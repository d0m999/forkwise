import { z } from 'zod';
import { SecHistoryInput } from '../contracts/sec-filings.js';
import { readSecIndex } from './sec-index.js';
import { resolveSubmissionHistory } from '@forkwise/public-data-core';
import { linkWorkflowTask } from '../repositories/workflow-history.js';
import { PublicDataInput } from '../contracts/public-data.js';
export { PublicDataInput } from '../contracts/public-data.js';
import { SecClient, SourceError, sourceCatalog } from '@forkwise/public-data-core';
import type { Actor, ChangeSet } from '../contracts/entities.js';
import type { CommandInput } from '../contracts/commands.js';
import type { JobRepository } from '../repositories/jobs.js';
import type { GraphWriteService } from './graph-write.js';
import { digest } from './graph-write.js';
import { DomainError, requireThat } from '../domain/errors.js';

export class PublicDataService {
  readonly catalog = sourceCatalog;
  private running = new Map<string, AbortController>();
  private stopping = false;
  constructor(
    readonly write: GraphWriteService,
    readonly jobs: JobRepository,
    readonly client?: SecClient,
  ) {}
  request(projectId: string, actor: Actor, key: string, raw: unknown, workflowId?: string) {
    const input = PublicDataInput.parse(raw);
    this.write.repo.project(projectId);
    return this.write.idempotent(
      actor,
      projectId,
      key,
      { op: 'public-data.request', input, ...(workflowId ? { workflowId } : {}) },
      () => {
        this.jobs.assertCapacity(projectId);
        const job = this.jobs.enqueue(
          projectId,
          'source.sec',
          input,
          digest({ actor: actor.id, key, input }),
        );
        if (workflowId) linkWorkflowTask(this.write.repo.db, projectId, workflowId, job.id);
        return job;
      },
    );
  }
  historyRequest(projectId: string, actor: Actor, key: string, raw: unknown, workflowId?: string) {
    const input = SecHistoryInput.parse(raw);
    return this.write.idempotent(
      actor,
      projectId,
      key,
      { op: 'public-data.history', input, ...(workflowId ? { workflowId } : {}) },
      () => {
        const { snapshot } = readSecIndex(this.write.repo, projectId, input.indexSourceVersionId);
        requireThat(
          snapshot.dataset === 'submissions',
          'INVALID_INDEX_SOURCE',
          '历史分片只从根索引目录取得',
        );
        let record;
        try {
          record = resolveSubmissionHistory(snapshot.raw, snapshot.cik, input.fileName);
        } catch (error) {
          if (error instanceof SourceError) throw new DomainError(error.code, error.message);
          throw error;
        }
        this.jobs.assertCapacity(projectId);
        const job = this.jobs.enqueue(
          projectId,
          'source.sec-history',
          { ...input, binding: { indexHash: snapshot.hash, ...record } },
          digest({ actor, key, input }),
        );
        if (workflowId) linkWorkflowTask(this.write.repo.db, projectId, workflowId, job.id);
        return job;
      },
    );
  }
  async run(projectId: string, id: string) {
    const job = this.jobs.claim(projectId, id);
    if (!job) return this.jobs.get(projectId, id);
    const abort = new AbortController();
    this.running.set(id, abort);
    try {
      requireThat(
        this.client,
        'SEC_NOT_CONFIGURED',
        '尚未配置本人真实的 SEC_USER_AGENT；规则与研究数据保持已保存',
        503,
      );
      const historyInput =
        job.kind === 'source.sec-history'
          ? SecHistoryInput.extend({ binding: z.record(z.string(), z.unknown()) }).parse(job.input)
          : undefined;
      const input = historyInput ? undefined : PublicDataInput.parse(job.input);
      const parent = historyInput
        ? readSecIndex(this.write.repo, projectId, historyInput.indexSourceVersionId).snapshot
        : undefined;
      if (historyInput && parent)
        requireThat(
          parent.dataset === 'submissions' &&
            digest(historyInput.binding) ===
              digest({
                indexHash: parent.hash,
                ...resolveSubmissionHistory(parent.raw, parent.cik, historyInput.fileName),
              }),
          'INVALID_HISTORY_BINDING',
          '历史文件与固定父目录或任务输入不符',
        );
      const snapshot =
        historyInput && parent
          ? await this.client.fetchHistory(parent, historyInput.fileName, { signal: abort.signal })
          : await this.client.fetch(input!.cik, input!.dataset, { signal: abort.signal });
      requireThat(
        snapshot.raw.length <= 5_000_000,
        'SOURCE_TOO_LARGE',
        '原始 SEC 快照已保留在本机缓存，但超过单次材料导入上限；未截断入库',
        413,
      );
      this.write.repo.db
        .transaction(() => {
          if (!this.jobs.isRunning(job)) return;
          const state = this.write.repo.snapshot(projectId);
          const sourceId = historyInput
            ? `sec_history_${digest(snapshot.url)}`
            : `sec_${snapshot.cik}_${input!.dataset}`;
          const source = state.objects.find((e) => e.id === sourceId);
          const expected: Record<string, number> = {};
          const commands: CommandInput[] = [];
          if (source) {
            requireThat(
              source.kind === 'source' && source.data.url === snapshot.url,
              'SOURCE_ID_CONFLICT',
              '公开来源身份与现有对象冲突，已停止导入',
              409,
            );
            expected[source.id] = source.version;
          } else
            commands.push({
              op: 'source.create',
              id: sourceId,
              data: {
                title: `SEC ${snapshot.cik} ${historyInput ? historyInput.fileName : input!.dataset}`,
                publisher: 'SEC',
                rights: 'public',
                url: snapshot.url,
              },
            });
          const prior = state.objects.find(
            (e) =>
              e.kind === 'source_version' &&
              e.data.sourceId === sourceId &&
              e.data.contentHash === snapshot.hash,
          );
          const materialId =
            prior?.id ??
            (historyInput
              ? `sec_history_${digest({ sourceId, hash: snapshot.hash })}`
              : `sec_${snapshot.hash}`);
          if (!prior)
            commands.push({
              op: 'source.import',
              id: materialId,
              sourceId,
              text: snapshot.raw,
              retrievedAt: snapshot.retrievedAt,
              publishedAt: null,
              provenance: {
                provider: snapshot.sourceId,
                adapterVersion: snapshot.adapterVersion,
                snapshotHash: snapshot.hash,
                requestUrl: snapshot.url,
                ...(historyInput && parent
                  ? {
                      indexParent: {
                        sourceVersionId: historyInput.indexSourceVersionId,
                        snapshotHash: parent.hash,
                      },
                    }
                  : {}),
              },
            });
          const changes: ChangeSet = commands.length
            ? this.write.execute(projectId, { id: `job_${id}`, type: 'system' }, `import_${id}`, {
                expected,
                commands,
              })
            : {
                projectId,
                revisionBefore: state.project.revision,
                revisionAfter: state.project.revision,
                upserted: [],
                deletedIds: [],
              };
          this.jobs.finish(
            job,
            'succeeded',
            {
              sourceVersionId: materialId,
              ...(snapshot.history ? { history: snapshot.history } : {}),
              changes,
              acquisition: {
                hash: snapshot.hash,
                retrievedAt: snapshot.retrievedAt,
                adapterVersion: snapshot.adapterVersion,
              },
              message: '已保存原始公开材料；尚未将任意财务字段加入计算白名单，也未确认主张成立',
            },
            null,
            { networkRequests: '由适配器执行', cost: null },
          );
        })
        .immediate();
    } catch (error) {
      this.jobs.finish(
        job,
        'failed',
        null,
        error instanceof DomainError || error instanceof SourceError
          ? `${error.code}: ${error.message}`
          : '公开来源获取失败，未应用不完整材料',
      );
    } finally {
      this.running.delete(id);
    }
    return this.jobs.get(projectId, id);
  }
  cancel(projectId: string, id: string) {
    const job = this.jobs.cancel(projectId, id);
    this.running.get(id)?.abort();
    return job;
  }
  abort(id: string) {
    this.running.get(id)?.abort();
  }
  stop() {
    this.stopping = true;
    for (const controller of this.running.values()) controller.abort();
  }
  async drain() {
    const pending = this.write.repo.db
      .prepare(
        "SELECT project_id,id FROM jobs WHERE kind IN ('source.sec','source.sec-history') AND state='queued' ORDER BY created_at,id",
      )
      .all() as { project_id: string; id: string }[];
    for (const job of pending) {
      if (this.stopping) break;
      await this.run(job.project_id, job.id);
    }
  }
}
