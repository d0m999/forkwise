import {
  SecClient,
  SourceError,
  resolveSubmissionDocument,
  selectSubmissionDocuments,
  type FilingFilter,
} from '@forkwise/public-data-core';
import { linkWorkflowTask } from '../repositories/workflow-history.js';
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { SecFilingInput } from '../contracts/sec-filings.js';
import type { Actor } from '../contracts/entities.js';
import { ChangesSchema } from '../contracts/responses.js';
import type { JobRepository } from '../repositories/jobs.js';
import type { MaterialFileService } from './material-files.js';
import type { GraphWriteService } from './graph-write.js';
import { digest } from './graph-write.js';
import { requireThat, DomainError } from '../domain/errors.js';
import { readSecIndex } from './sec-index.js';
import { parseHtml } from './html-parser.js';
import { saveFilingFile, saveFilingText } from './sec-filing-import.js';
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const Saved = z
  .object({
    fileId: z.string(),
    sourceId: z.string(),
    changes: ChangesSchema,
    acquisitionChanges: ChangesSchema.optional(),
    acquisition: z.object({
      hash: z.string(),
      retrievedAt: z.string(),
      adapterVersion: z.string(),
      url: z.string(),
      cik: z.string(),
    }),
    lineage: z.record(z.string(), z.unknown()),
  })
  .passthrough();

export class SecFilingService {
  private running = new Map<string, AbortController>();
  private stopping = false;
  constructor(
    readonly write: GraphWriteService,
    readonly jobs: JobRepository,
    readonly files: MaterialFileService,
    readonly client?: SecClient,
  ) {}
  private snapshot(projectId: string, indexSourceVersionId: string) {
    return readSecIndex(this.write.repo, projectId, indexSourceVersionId).snapshot;
  }
  select(projectId: string, indexSourceVersionId: string, filter: FilingFilter) {
    const snapshot = this.snapshot(projectId, indexSourceVersionId);
    try {
      return selectSubmissionDocuments(snapshot.raw, {
        ...filter,
        expectedCik: snapshot.cik,
        history: snapshot.dataset === 'submissions-history',
      });
    } catch (error) {
      if (error instanceof SourceError) throw new DomainError(error.code, error.message);
      throw error;
    }
  }
  private index(projectId: string, input: z.infer<typeof SecFilingInput>) {
    const snapshot = this.snapshot(projectId, input.indexSourceVersionId),
      raw = snapshot.raw;
    try {
      return {
        snapshot,
        record: resolveSubmissionDocument(raw, snapshot.cik, input.accessionNumber, {
          history: snapshot.dataset === 'submissions-history',
        }),
      };
    } catch (error) {
      if (error instanceof SourceError) throw new DomainError(error.code, error.message);
      throw error;
    }
  }
  request(projectId: string, actor: Actor, key: string, raw: unknown, workflowId?: string) {
    const input = SecFilingInput.parse(raw);
    this.write.repo.project(projectId);
    return this.write.idempotent(
      actor,
      projectId,
      key,
      { op: 'sec-filing.request', input, ...(workflowId ? { workflowId } : {}) },
      () => {
        const { snapshot, record } = this.index(projectId, input);
        this.jobs.assertCapacity(projectId);
        const job = this.jobs.enqueue(
          projectId,
          'source.sec-filing',
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
    let saved: z.infer<typeof Saved> | undefined;
    const active = () => {
      abort.signal.throwIfAborted();
      requireThat(this.jobs.isRunning(job), 'TASK_NOT_RUNNING', '材料获取任务已停止');
    };
    try {
      const stored = SecFilingInput.extend({ binding: z.record(z.string(), z.unknown()) }).parse(
        job.input,
      );
      const { binding, ...input } = stored,
        { snapshot: index, record } = this.index(projectId, input);
      requireThat(
        digest(binding) === digest({ indexHash: index.hash, ...record }),
        'INVALID_FILING_BINDING',
        '申报记录与任务固定输入不一致',
      );
      let text: string;
      if (job.output) {
        saved = Saved.parse(job.output);
        const file = this.files.file(projectId, saved.fileId);
        text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(file.bytes);
        requireThat(
          file.source_id === saved.sourceId &&
            hash(text) === saved.acquisition.hash &&
            saved.acquisition.url === record.url &&
            saved.acquisition.cik === index.cik &&
            saved.acquisition.retrievedAt === file.retrieved_at &&
            file.hash === saved.acquisition.hash &&
            saved.sourceId === `sec_filing_${digest(record.url)}` &&
            digest(saved.lineage) ===
              digest({
                indexUrl: index.url,
                indexHash: index.hash,
                ...record,
                indexSourceVersionId: input.indexSourceVersionId,
              }),
          'INVALID_FILING_SNAPSHOT',
          '已取得正文与原任务不一致',
        );
      } else {
        requireThat(this.client, 'SEC_NOT_CONFIGURED', '尚未配置本人真实的 SEC_USER_AGENT', 503);
        const snapshot = await this.client.fetchFiling(index, input.accessionNumber, {
          signal: abort.signal,
          ...(index.dataset === 'submissions-history'
            ? {
                historyRoot: readSecIndex(this.write.repo, projectId, input.indexSourceVersionId)
                  .historyRoot!,
              }
            : {}),
        });
        active();
        text = snapshot.raw;
        this.write.repo.db
          .transaction(() => {
            active();
            saved = {
              ...saveFilingFile(this.write, job, snapshot),
              acquisition: {
                hash: snapshot.hash,
                retrievedAt: snapshot.retrievedAt,
                adapterVersion: snapshot.adapterVersion,
                url: snapshot.url,
                cik: snapshot.cik,
              },
              lineage: { ...snapshot.lineage!, indexSourceVersionId: input.indexSourceVersionId },
            };
            this.jobs.checkpoint(job, saved);
          })
          .immediate();
      }
      active();
      requireThat(saved, 'INVALID_FILING_SNAPSHOT', '未保存原始文件');
      let artifact: ReturnType<typeof parseHtml>;
      try {
        artifact = parseHtml(text);
      } catch (error) {
        artifact = {
          text: '',
          blocks: [],
          normalizerVersion: 'html-body@1',
          status: 'failed',
          gaps: [
            error instanceof DomainError
              ? `${error.code}: ${error.message}`
              : 'HTML 解析失败，原文件保留，可显式重试',
          ],
          coverage: 'body_text',
        };
      }
      // Main HTML text is partial coverage of a filing: images, exhibits and structured tables remain unverified.
      artifact.gaps.push(
        '仅取得索引指定的 HTML 主文件；未获取附件、未识别图片或核对表格财务口径。',
      );
      this.write.repo.db
        .transaction(() => {
          active();
          const parsed = saveFilingText(
            this.write,
            job,
            saved!,
            {
              ...artifact,
              status: artifact.status as 'complete' | 'partial' | 'failed',
              secFiling: saved!.lineage,
            },
            {
              provider: 'sec-edgar',
              adapterVersion: saved!.acquisition.adapterVersion,
              snapshotHash: saved!.acquisition.hash,
              requestUrl: record.url,
            },
          );
          this.jobs.finish(
            job,
            artifact.status === 'complete'
              ? 'succeeded'
              : artifact.status === 'partial'
                ? 'partial'
                : 'failed',
            {
              ...saved,
              ...parsed,
              acquisitionChanges: saved!.acquisitionChanges ?? saved!.changes,
              parseStatus: artifact.status,
              gaps: artifact.gaps,
            },
            artifact.status === 'complete' ? null : artifact.gaps.join('；'),
            { cost: null },
          );
        })
        .immediate();
    } catch (error) {
      this.jobs.finish(
        job,
        'failed',
        this.jobs.get(projectId, id).output,
        error instanceof Error && 'code' in error
          ? `${String(error.code)}: ${error.message}`
          : '申报正文获取或保存失败；已取得原文件保留',
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
    for (const c of this.running.values()) c.abort();
  }
  async drain() {
    const pending = this.write.repo.db
      .prepare(
        "SELECT project_id,id FROM jobs WHERE kind='source.sec-filing' AND state='queued' ORDER BY created_at,id",
      )
      .all() as { project_id: string; id: string }[];
    for (const j of pending) {
      if (this.stopping) break;
      await this.run(j.project_id, j.id);
    }
  }
}
