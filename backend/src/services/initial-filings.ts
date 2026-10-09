import { z } from 'zod';
import { SecFilingInput } from '../contracts/sec-filings.js';
import { InitialFilingsProgress, type SourcePlanResult } from '../contracts/initial-research.js';
import type { Job } from '../repositories/jobs.js';
import { taskWorkflow } from '../repositories/workflow-history.js';
import { digest } from './graph-write.js';
import type { SecFilingService } from './sec-filings.js';
import { DomainError, requireThat } from '../domain/errors.js';
import { createHash } from 'node:crypto';
import type { AnyEntity } from '../contracts/entities.js';

type Progress = z.infer<typeof InitialFilingsProgress>;
type Root = {
  request: { cik: string; dataset: string };
  sourceVersionId?: string;
  state: string;
  targetId?: string;
  filterKey?: string;
};
const errorMessage = (error: unknown) =>
  error instanceof DomainError
    ? `${error.code}: ${error.message}`
    : '选取或取得正文失败；已完成部分保留';
const requestKey = (request: z.infer<typeof SecFilingInput>) => digest(request);

function prepare(
  service: SecFilingService,
  projectId: string,
  plan: SourcePlanResult,
  roots: Root[],
  progress: Progress,
) {
  const selections: Progress['selections'] = [],
    wanted = new Map<
      string,
      {
        request: z.infer<typeof SecFilingInput>;
        url: string;
        indexBindings: z.infer<typeof SecFilingInput>[];
      }
    >();
  const filings = new Map<string, { key: string; fingerprint: string }>();
  let conflict = false;
  // Parse each fixed index/filter once even when many targets share it.
  const cache = new Map<string, ReturnType<SecFilingService['select']> | DomainError>();
  for (const target of plan.targets)
    for (const request of target.requests) {
      if (!request.filings) continue;
      for (const root of roots.filter(
        (r) =>
          Number(r.request.cik) === Number(request.cik) &&
          r.request.dataset === request.dataset &&
          (!r.targetId ||
            (r.targetId === target.target.id && r.filterKey === digest(request.filings))),
      )) {
        if (root?.state !== 'available' || !root.sourceVersionId) continue;
        const indexSourceVersionId = root.sourceVersionId,
          filter = request.filings;
        const selection: Progress['selections'][number] = {
          targetId: target.target.id,
          indexSourceVersionId,
          filter,
          documents: [],
          state: 'selected',
          matchedRecords: null,
          historyFileCount: null,
          gaps: [],
        };
        try {
          const key = digest({ indexSourceVersionId, filter });
          if (!cache.has(key)) {
            try {
              cache.set(key, service.select(projectId, indexSourceVersionId, filter));
            } catch (error) {
              if (!(error instanceof DomainError)) throw error;
              cache.set(key, error);
            }
          }
          const chosen = cache.get(key)!;
          if (chosen instanceof DomainError) throw chosen;
          selection.matchedRecords = chosen.matchedRecords;
          selection.historyFileCount = chosen.historyFileCount;
          selection.gaps = [
            ...chosen.gaps,
            ...chosen.unavailable.map((u) => `${u.recordPointer}：${u.error}`),
          ];
          if (chosen.unavailable.length) selection.state = 'failed';
          for (const document of chosen.documents) {
            const input = { indexSourceVersionId, accessionNumber: document.accessionNumber };
            selection.documents.push(input);
            const identity = `${Number(request.cik)}:${document.accessionNumber}`,
              fingerprint = digest({
                url: document.url,
                form: document.form,
                filingDate: document.filingDate,
                reportDate: document.reportDate,
              }),
              existing = filings.get(identity);
            if (existing) {
              if (existing.fingerprint !== fingerprint) {
                conflict = true;
                selection.state = 'failed';
                selection.gaps.push(
                  `${document.accessionNumber}：不同索引列出的主文件或申报元数据不一致，未自动择一。`,
                );
                continue;
              }
              const canonical = wanted.get(existing.key)!;
              if (
                !canonical.indexBindings.some(
                  (binding) => requestKey(binding) === requestKey(input),
                )
              )
                canonical.indexBindings.push(input);
            } else {
              filings.set(identity, { key: requestKey(input), fingerprint });
              wanted.set(requestKey(input), {
                request: input,
                url: document.url,
                indexBindings: [input],
              });
            }
          }
        } catch (error) {
          selection.state = 'failed';
          selection.gaps.push(errorMessage(error));
        }
        selections.push(selection);
      }
    }
  progress.selections = selections;
  requireThat(
    !conflict,
    'CONFLICTING_FILING_INDEXES',
    '不同索引中的同一申报字段冲突；请核对固定材料，未自动选择或开始新正文获取',
  );
  requireThat(
    wanted.size <= 10,
    'TOO_MANY_FILINGS',
    '本次研究选中超过 10 个主文件；请缩小研究范围，未开始新正文获取、未静默删减',
  );
  const previous = new Map(progress.acquisitions.map((a) => [requestKey(a.request), a]));
  requireThat(
    previous.size === progress.acquisitions.length &&
      [...previous.keys()].every((key) => wanted.has(key)),
    'INVALID_FILING_PROGRESS',
    '已保存正文范围与固定计划或索引不符',
  );
  progress.acquisitions = [...wanted].map(([key, input]) => {
    const prior = previous.get(key);
    requireThat(
      !prior || prior.url === input.url,
      'INVALID_FILING_PROGRESS',
      '已保存正文地址与固定索引不符',
    );
    return prior
      ? { ...prior, indexBindings: input.indexBindings }
      : { ...input, state: 'pending', gaps: [] };
  });
}

function usableBody(
  service: SecFilingService,
  projectId: string,
  version: AnyEntity | undefined,
  url: string,
) {
  if (
    version?.kind !== 'source_version' ||
    version.data.provenance?.provider !== 'sec-edgar' ||
    version.data.provenance.requestUrl !== url ||
    version.data.parseStatus !== 'complete' ||
    version.data.textOrigin !== 'html_body' ||
    !version.data.fileId
  )
    return false;
  try {
    const file = service.files.file(projectId, version.data.fileId),
      artifact = service.files.artifact(projectId, version.id),
      source = service.write.repo
        .snapshot(projectId)
        .objects.find((e) => e.id === version.data.sourceId),
      text = service.write.repo.material(projectId, version.id);
    return (
      source?.kind === 'source' &&
      source.data.rights === 'public' &&
      source.data.url === url &&
      file.source_id === source.id &&
      file.hash === version.data.provenance.snapshotHash &&
      createHash('sha256').update(file.bytes).digest('hex') === file.hash &&
      createHash('sha256').update(text).digest('hex') === version.data.contentHash &&
      artifact.text === text
    );
  } catch (error) {
    if (error instanceof DomainError) return false;
    throw error;
  }
}

function historicalVersion(
  service: SecFilingService,
  projectId: string,
  url: string,
  asOf: string,
) {
  const objects = service.write.repo.snapshot(projectId).objects;
  const sourceIds = new Set(
    objects
      .filter((e) => e.kind === 'source' && e.data.url === url && e.data.rights === 'public')
      .map((e) => e.id),
  );
  return objects
    .filter(
      (e) =>
        e.kind === 'source_version' &&
        sourceIds.has(e.data.sourceId) &&
        e.data.provenance?.provider === 'sec-edgar' &&
        e.data.provenance.requestUrl === url &&
        e.data.parseStatus === 'complete' &&
        e.data.textOrigin === 'html_body' &&
        Date.parse(e.data.retrievedAt) <= Date.parse(asOf) &&
        Date.parse(e.createdAt) <= Date.parse(asOf) &&
        (!e.data.publishedAt || Date.parse(e.data.publishedAt) <= Date.parse(asOf)) &&
        usableBody(service, projectId, e, url),
    )
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .at(-1);
}

/** Returns false only when another worker owns a child, so the coordinator can yield. */
export async function runInitialFilings(options: {
  service: SecFilingService;
  parent: Job;
  plan: SourcePlanResult;
  roots: Root[];
  progress: Progress;
  asOf?: string;
  active: () => void;
  save: () => void;
  child: (id: string) => Promise<Job>;
}) {
  const { service, parent, plan, roots, progress, asOf, active, save, child } = options;
  const projectId = parent.projectId,
    groupId = taskWorkflow(service.write.repo.db, projectId, parent.id)?.id;
  prepare(service, projectId, plan, roots, progress);
  save();
  for (const acquisition of progress.acquisitions) {
    active();
    if (asOf) {
      const version = historicalVersion(service, projectId, acquisition.url, asOf);
      if (version) {
        acquisition.sourceVersionId = version.id;
        acquisition.state = 'available';
        delete acquisition.error;
        acquisition.gaps = ['仅使用历史时点前已保存的 HTML 正文；附件、图片及财务表格口径未核对。'];
      } else {
        delete acquisition.sourceVersionId;
        acquisition.state = 'not_known';
        acquisition.error =
          '历史时点没有已取得且解析完成的申报正文；未联网取新材料或用披露日期代替取得时间';
      }
      save();
      continue;
    }
    try {
      if (!acquisition.jobId) {
        const task = service.request(
          projectId,
          { id: `workflow_${parent.id}`, type: 'system' },
          `filing_${requestKey(acquisition.request)}`,
          acquisition.request,
          groupId,
        );
        acquisition.jobId = task.id;
        save();
      }
      const stored = service.jobs.get(projectId, acquisition.jobId),
        input = stored.input as z.infer<typeof SecFilingInput>;
      requireThat(
        stored.kind === 'source.sec-filing' &&
          taskWorkflow(service.write.repo.db, projectId, stored.id)?.id === groupId &&
          digest({
            indexSourceVersionId: input.indexSourceVersionId,
            accessionNumber: input.accessionNumber,
          }) === requestKey(acquisition.request),
        'INVALID_CHILD_TASK',
        '正文任务与本次研究的固定输入或归属不符',
      );
      requireThat(
        acquisition.state !== 'available' ||
          (stored.state === 'succeeded' &&
            (stored.output as { sourceVersionId?: string } | null)?.sourceVersionId ===
              acquisition.sourceVersionId),
        'INVALID_FILING_PROGRESS',
        '已记录正文与原获取结果不符',
      );
      const result = acquisition.state === 'available' ? stored : await child(acquisition.jobId);
      if (result.state === 'running' || result.state === 'queued') return false;
      if (result.state === 'succeeded') {
        const output = result.output as { sourceVersionId: string; gaps: string[] };
        requireThat(
          usableBody(
            service,
            projectId,
            service.write.repo
              .snapshot(projectId)
              .objects.find((e) => e.id === output.sourceVersionId),
            acquisition.url,
          ),
          'INVALID_FILING_PROGRESS',
          '正文、原文件或解析定位不可复核；未送入查证',
        );
        acquisition.sourceVersionId = output.sourceVersionId;
        acquisition.state = 'available';
        acquisition.gaps = output.gaps;
        delete acquisition.error;
      } else {
        acquisition.state = 'failed';
        acquisition.error = result.error ?? `正文任务处于 ${result.state}`;
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

export function filingMaterialIds(progress: Progress, targetId: string) {
  const requests = new Set(
    progress.selections
      .filter((s) => s.targetId === targetId)
      .flatMap((s) => s.documents.map(requestKey)),
  );
  return progress.acquisitions
    .filter(
      (a) =>
        (a.indexBindings ?? [a.request]).some((input) => requests.has(requestKey(input))) &&
        a.state === 'available' &&
        a.sourceVersionId,
    )
    .map((a) => a.sourceVersionId!);
}
