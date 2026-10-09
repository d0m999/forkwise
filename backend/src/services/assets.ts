import { exportWorkflowGroups } from '../repositories/workflow-history.js';
import { readJournal, recordAction } from '../repositories/action-history.js';
import { redactCanvasImages } from './redact-canvas.js';
import { markdownSummary } from './markdown-summary.js';
import { readLayout, saveLayout } from '../repositories/layout.js';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Id, Text } from '../contracts/entities.js';
import type { Actor, AnyEntity } from '../contracts/entities.js';
import type { ResearchRepository } from '../repositories/research.js';
import type { GraphWriteService } from './graph-write.js';
import { requireThat } from '../domain/errors.js';
import { JobRepository } from '../repositories/jobs.js';

export { LayoutInput } from '../contracts/assets.js';
import { LayoutInput } from '../contracts/assets.js';
export class AssetService {
  constructor(
    readonly repo: ResearchRepository,
    readonly write: GraphWriteService,
  ) {}
  layout(projectId: string) {
    return readLayout(this.repo, projectId);
  }
  saveLayout(projectId: string, actor: Actor, key: string, raw: unknown) {
    const input = LayoutInput.parse(raw);
    return this.write.idempotent(actor, projectId, key, { op: 'layout.save', input }, () => {
      const before = readLayout(this.repo, projectId),
        now = this.write.clock();
      const after = saveLayout(this.repo, projectId, input, now, actor);
      recordAction(
        this.repo,
        projectId,
        actor,
        now,
        new Map(),
        [],
        before,
        after,
        '调整画布布局、批注或样式',
      );
      return after;
    });
  }
  recordJudgment(projectId: string, actor: Actor, key: string, title: string) {
    Text.parse(title);
    requireThat(actor.type === 'human', 'HUMAN_REQUIRED', '历史判断由本人主动记录', 403);
    return this.write.idempotent(actor, projectId, key, { op: 'judgment.record', title }, () => {
      const state = this.repo.snapshot(projectId);
      const id = randomUUID();
      const refs = state.objects.map((e) => ({ id: e.id, versionId: e.versionId }));
      this.repo.db
        .prepare('INSERT INTO judgments(id,project_id,title,refs,created_at) VALUES(?,?,?,?,?)')
        .run(id, projectId, title, JSON.stringify(refs), this.write.clock());
      return this.judgment(projectId, id);
    });
  }
  judgments(projectId: string) {
    this.repo.project(projectId);
    return this.repo.db
      .prepare(
        'SELECT id,title,created_at AS createdAt FROM judgments WHERE project_id=? ORDER BY created_at DESC',
      )
      .all(projectId);
  }
  judgment(projectId: string, id: string) {
    this.repo.project(projectId);
    const row = this.repo.db
      .prepare(
        'SELECT id,title,refs,created_at AS createdAt FROM judgments WHERE project_id=? AND id=?',
      )
      .get(projectId, id) as
      | { id: string; title: string; refs: string; createdAt: string }
      | undefined;
    requireThat(row, 'JUDGMENT_NOT_FOUND', '历史判断不存在', 404);
    const refs = JSON.parse(row.refs) as { id: string; versionId: string }[];
    const objects = refs.map((ref) => this.repo.version(projectId, ref.id, ref.versionId));
    requireThat(objects.every(Boolean), 'BROKEN_HISTORY', '历史判断缺少所引用的版本，已停止回放');
    return {
      id: row.id,
      title: row.title,
      createdAt: row.createdAt,
      objects: objects as AnyEntity[],
    };
  }
  export(projectId: string) {
    return this.repo.db
      .transaction(() => {
        const project = this.repo.project(projectId);
        const objects = this.repo.objects(projectId);
        const restricted = new Set(
          objects
            .filter((e) => e.kind === 'source' && e.data.rights === 'restricted')
            .map((e) => e.id),
        );
        const blocked = new Set(
          objects
            .filter((e) => e.kind === 'source_version' && restricted.has(e.data.sourceId))
            .map((e) => e.id),
        );
        const saved = new Map(
          (
            this.repo.db
              .prepare('SELECT source_version_id AS id,text FROM materials WHERE project_id=?')
              .all(projectId) as { id: string; text: string }[]
          ).map((m) => [m.id, m.text]),
        );
        const materials = objects
          .filter((e) => e.kind === 'source_version')
          .map((e) =>
            blocked.has(e.id)
              ? { id: e.id, text: null, omission: '来源权利限制，仅导出索引' }
              : saved.has(e.id)
                ? { id: e.id, text: saved.get(e.id)! }
                : { id: e.id, text: null, omission: '当前存档未包含可复核原文' },
          );
        const versions = (
          this.repo.db
            .prepare(
              'SELECT snapshot,actor FROM versions WHERE project_id=? ORDER BY created_at,entity_id,version',
            )
            .all(projectId) as { snapshot: string; actor: string }[]
        ).map((v) => ({ snapshot: JSON.parse(v.snapshot), actor: JSON.parse(v.actor) }));
        const files = (
          this.repo.db
            .prepare(
              'SELECT id,source_id AS sourceId,name,mime,hash,bytes,retrieved_at AS retrievedAt,published_at AS publishedAt FROM file_assets WHERE project_id=?',
            )
            .all(projectId) as {
            id: string;
            sourceId: string;
            name: string;
            mime: string;
            hash: string;
            bytes: Buffer;
            retrievedAt: string;
            publishedAt: string | null;
          }[]
        ).map(({ bytes, ...file }) => ({
          ...file,
          base64:
            restricted.has(file.sourceId) || bytes.length === 0 ? null : bytes.toString('base64'),
          ...(restricted.has(file.sourceId)
            ? { omission: '来源权利限制，仅导出索引' }
            : bytes.length === 0
              ? { omission: '当前存档未包含原文件' }
              : {}),
        }));
        const artifacts = (
          this.repo.db
            .prepare(
              'SELECT source_version_id AS sourceVersionId,file_id AS fileId,data FROM parsed_artifacts WHERE project_id=?',
            )
            .all(projectId) as { sourceVersionId: string; fileId: string; data: string }[]
        )
          .filter((a) => !blocked.has(a.sourceVersionId))
          .map((a) => ({ ...a, data: JSON.parse(a.data) }));
        const tasks = new JobRepository(this.repo.db).list(projectId).map((job) => ({
          ...job,
          runToken: null,
          dedupeKey: (
            this.repo.db.prepare('SELECT dedupe_key FROM jobs WHERE id=?').get(job.id) as {
              dedupe_key: string;
            }
          ).dedupe_key,
        }));
        const layout = this.layout(projectId);
        layout.data = redactCanvasImages(
          layout.data,
          new Set(files.filter((f) => restricted.has(f.sourceId)).map((f) => f.hash)),
        );
        const result = {
          format: 'forkwise-project',
          schemaVersion: 1,
          exportedAt: this.write.clock(),
          project,
          objects,
          versions,
          materials,
          files,
          artifacts,
          tasks,
          layout,
          workflowGroups: exportWorkflowGroups(this.repo.db, projectId),
          actionHistory: (() => {
            const journal = readJournal(this.repo, projectId);
            const hashes = new Set(
              files.filter((f) => restricted.has(f.sourceId)).map((f) => f.hash),
            );
            for (const entry of journal.entries)
              if (entry.layout) {
                entry.layout.before = redactCanvasImages(entry.layout.before, hashes);
                entry.layout.after = redactCanvasImages(entry.layout.after, hashes);
              }
            return journal;
          })(),
          judgments: this.repo.db
            .prepare(
              'SELECT id,title,refs,created_at AS createdAt FROM judgments WHERE project_id=?',
            )
            .all(projectId),
        };
        return JSON.parse(
          JSON.stringify(result, (_key, value: unknown) => {
            if (
              value &&
              typeof value === 'object' &&
              'sourceVersionId' in value &&
              ('quote' in value || ('kind' in value && value.kind === 'image')) &&
              blocked.has(String(value.sourceVersionId))
            )
              return {
                ...value,
                ...('quote' in value ? { quote: '' } : {}),
                unavailableReason: 'rights',
              };
            if (
              value &&
              typeof value === 'object' &&
              'sourceVersionId' in value &&
              'artifact' in value &&
              blocked.has(String(value.sourceVersionId))
            )
              return { ...value, artifact: null, omission: '来源权利限制，仅导出索引' };
            if (
              value &&
              typeof value === 'object' &&
              'id' in value &&
              'text' in value &&
              blocked.has(String(value.id))
            )
              return { ...value, text: null, omission: '来源权利限制，仅导出索引' };
            return value;
          }),
        ) as typeof result;
      })
      .deferred();
  }
  summary(projectId: string, judgmentId?: string): string {
    return this.repo.db
      .transaction(() => {
        const project = this.repo.project(projectId);
        const judgment = judgmentId ? this.judgment(projectId, judgmentId) : undefined;
        const objects = judgment?.objects ?? this.repo.snapshot(projectId).objects;
        return markdownSummary(project, objects, this.write.clock(), judgment);
      })
      .deferred();
  }
}
