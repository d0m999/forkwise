import { selectSubmissionHistory, SourceError } from '@forkwise/public-data-core';
import { z } from 'zod';
import { InitialHistoryProgress, type SourcePlanResult } from '../contracts/initial-research.js';
import type { PublicDataService } from './public-data.js';
import type { Job } from '../repositories/jobs.js';
import { taskWorkflow } from '../repositories/workflow-history.js';
import { digest } from './graph-write.js';
import { DomainError, requireThat } from '../domain/errors.js';
import { readSecIndex } from './sec-index.js';

type Progress = z.infer<typeof InitialHistoryProgress>;
type Root = {
  request: { cik: string; dataset: string };
  sourceVersionId?: string;
  state: string;
  targetId?: string;
  filterKey?: string;
};
const errorMessage = (error: unknown) =>
  error instanceof DomainError || error instanceof SourceError
    ? `${error.code}: ${error.message}`
    : '历史分片取得失败，已完成材料保留';

export async function runInitialHistory(options: {
  service: PublicDataService;
  parent: Job;
  plan: SourcePlanResult;
  roots: Root[];
  progress: Progress;
  asOf?: string;
  active: () => void;
  save: () => void;
  child: (id: string) => Promise<Job>;
}) {
  const { service, parent, plan, roots, progress, asOf, active, save, child } = options,
    projectId = parent.projectId;
  const wanted = new Map<string, Progress['acquisitions'][number]>(),
    selections: Progress['selections'] = [];
  const cache = new Map<string, ReturnType<typeof selectSubmissionHistory>>();
  for (const target of plan.targets)
    for (const request of target.requests) {
      if (!request.filings?.includeHistory) continue;
      const root = roots.find(
        (r) => r.request.dataset === 'submissions' && Number(r.request.cik) === Number(request.cik),
      );
      if (root?.state !== 'available' || !root.sourceVersionId) continue;
      const selected: Progress['selections'][number] = {
        targetId: target.target.id,
        indexSourceVersionId: root.sourceVersionId,
        filter: request.filings,
        fileNames: [],
        excludedFiles: null,
        listedFiles: null,
        state: 'selected',
        gaps: [],
      };
      try {
        const snapshot = readSecIndex(service.write.repo, projectId, root.sourceVersionId).snapshot,
          key = digest({ id: root.sourceVersionId, filter: request.filings });
        requireThat(
          snapshot.dataset === 'submissions',
          'INVALID_INDEX_SOURCE',
          '历史文件只能从固定根索引选择',
        );
        if (!cache.has(key))
          cache.set(
            key,
            selectSubmissionHistory(snapshot.raw, {
              expectedCik: snapshot.cik,
              ...request.filings,
            }),
          );
        const scope = cache.get(key)!;
        selected.listedFiles = scope.listedFiles;
        selected.excludedFiles = scope.excludedFiles;
        selected.gaps = scope.gaps;
        if (scope.gaps.length) selected.state = 'failed';
        for (const file of scope.files) {
          selected.fileNames.push(file.name);
          const input = { indexSourceVersionId: root.sourceVersionId, fileName: file.name };
          wanted.set(digest(input), {
            request: input,
            url: file.url,
            cik: snapshot.cik,
            state: 'pending',
          });
        }
      } catch (error) {
        selected.state = 'failed';
        selected.gaps.push(errorMessage(error));
      }
      selections.push(selected);
    }
  progress.selections = selections;
  requireThat(
    wanted.size <= 10,
    'TOO_MANY_HISTORY_FILES',
    '本次研究超过 10 个不同历史分片；请缩小范围，未静默删减或开始新分片获取',
  );
  const previous = new Map(progress.acquisitions.map((a) => [digest(a.request), a]));
  requireThat(
    previous.size === progress.acquisitions.length &&
      [...previous.keys()].every((key) => wanted.has(key)),
    'INVALID_HISTORY_PROGRESS',
    '历史分片范围与固定计划不符',
  );
  progress.acquisitions = [...wanted].map(([key, wanted]) => {
    const prior = previous.get(key);
    requireThat(
      !prior || (prior.url === wanted.url && prior.cik === wanted.cik),
      'INVALID_HISTORY_PROGRESS',
      '历史分片主体或地址与固定目录不符',
    );
    return prior ?? wanted;
  });
  save();
  const groupId = taskWorkflow(service.write.repo.db, projectId, parent.id)?.id;
  for (const acquisition of progress.acquisitions) {
    active();
    try {
      if (asOf) {
        const candidates = service.write.repo
          .snapshot(projectId)
          .objects.filter(
            (e) =>
              e.kind === 'source_version' &&
              e.data.provenance?.requestUrl === acquisition.url &&
              Date.parse(e.createdAt) <= Date.parse(asOf) &&
              Date.parse(e.data.retrievedAt) <= Date.parse(asOf) &&
              (!e.data.publishedAt || Date.parse(e.data.publishedAt) <= Date.parse(asOf)),
          )
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
        const version = candidates.find((e) => {
          try {
            return (
              readSecIndex(service.write.repo, projectId, e.id).snapshot.dataset ===
              'submissions-history'
            );
          } catch (error) {
            if (error instanceof DomainError) return false;
            throw error;
          }
        });
        if (version) {
          acquisition.sourceVersionId = version.id;
          acquisition.state = 'available';
          delete acquisition.error;
        } else {
          delete acquisition.sourceVersionId;
          acquisition.state = 'not_known';
          acquisition.error = '历史时点没有已记录且取得的该索引分片；未联网补取';
        }
        save();
        continue;
      }
      if (!acquisition.jobId) {
        acquisition.jobId = service.historyRequest(
          projectId,
          { id: `workflow_${parent.id}`, type: 'system' },
          `history_${digest(acquisition.request)}`,
          acquisition.request,
          groupId,
        ).id;
        save();
      }
      const stored = service.jobs.get(projectId, acquisition.jobId),
        input = stored.input as Progress['acquisitions'][number]['request'];
      requireThat(
        stored.kind === 'source.sec-history' &&
          taskWorkflow(service.write.repo.db, projectId, stored.id)?.id === groupId &&
          digest({ indexSourceVersionId: input.indexSourceVersionId, fileName: input.fileName }) ===
            digest(acquisition.request),
        'INVALID_CHILD_TASK',
        '历史分片任务与固定输入或研究归属不符',
      );
      requireThat(
        acquisition.state !== 'available' ||
          (stored.state === 'succeeded' &&
            (stored.output as { sourceVersionId: string }).sourceVersionId ===
              acquisition.sourceVersionId),
        'INVALID_HISTORY_PROGRESS',
        '已记录分片版本与原获取结果不符',
      );
      const result = acquisition.state === 'available' ? stored : await child(acquisition.jobId);
      if (result.state === 'running' || result.state === 'queued') return false;
      if (result.state === 'succeeded') {
        const id = (result.output as { sourceVersionId: string }).sourceVersionId,
          { snapshot } = readSecIndex(service.write.repo, projectId, id);
        requireThat(
          snapshot.url === acquisition.url &&
            snapshot.cik === acquisition.cik &&
            snapshot.dataset === 'submissions-history',
          'INVALID_HISTORY_PROGRESS',
          '历史分片结果与原目录不符',
        );
        acquisition.sourceVersionId = id;
        acquisition.state = 'available';
        delete acquisition.error;
      } else {
        acquisition.state = 'failed';
        acquisition.error = result.error ?? `历史分片任务处于 ${result.state}`;
      }
    } catch (error) {
      active();
      acquisition.state = 'failed';
      acquisition.error = errorMessage(error);
    }
    save();
  }
  return true;
}

export function historyRoots(progress: Progress): Root[] {
  const result = new Map<string, Root>();
  for (const selection of progress.selections)
    for (const fileName of selection.fileNames) {
      const acquisition = progress.acquisitions.find(
        (a) =>
          a.request.indexSourceVersionId === selection.indexSourceVersionId &&
          a.request.fileName === fileName,
      );
      if (acquisition?.state !== 'available' || !acquisition.sourceVersionId) continue;
      const root = {
        targetId: selection.targetId,
        filterKey: digest(selection.filter),
        request: { cik: acquisition.cik, dataset: 'submissions' },
        state: 'available',
        sourceVersionId: acquisition.sourceVersionId,
      };
      result.set(`${selection.targetId}:${acquisition.sourceVersionId}:${root.filterKey}`, root);
    }
  return [...result.values()];
}
