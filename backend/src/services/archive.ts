import { validateUpdateScope } from './manual-update-scope.js';
import { saveJournal, applyHistoryEntry } from '../repositories/action-history.js';
import { rasterImage } from './raster-image.js';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { ArchiveSchema, type Archive } from '../contracts/assets.js';
import {
  Citation,
  isImageCitation,
  Ref,
  type Actor,
  type AnyEntity,
} from '../contracts/entities.js';
import { assertGraph, references } from '../domain/graph.js';
import { resolveImpactProposal, validateImpactBinding } from '../domain/impact-review.js';
import { requireThat } from '../domain/errors.js';
import { canonical, digest, type GraphWriteService } from './graph-write.js';
import type { SearchRepository } from '../repositories/search.js';

/** Import is an atomic restore into an absent identity, never an overwrite. */
export class ArchiveService {
  constructor(
    readonly write: GraphWriteService,
    readonly search: SearchRepository,
  ) {}
  import(actor: Actor, key: string, raw: unknown) {
    requireThat(actor.type === 'human', 'HUMAN_REQUIRED', '研究资产导入须由本人发起', 403);
    const archive = ArchiveSchema.parse(raw);
    return this.write.idempotent(
      actor,
      '__imports__',
      key,
      { op: 'archive.import', archive },
      () => {
        const { repo } = this.write;
        const { project } = archive;
        requireThat(
          !repo.db.prepare('SELECT id FROM projects WHERE id=?').get(project.id),
          'PROJECT_EXISTS',
          '该项目身份已存在；请恢复到新的隔离数据库，不能覆盖现有项目',
          409,
        );
        const { materials, histories, omissions } = this.validate(archive);
        requireThat(
          !project.deletedAt,
          'DELETED_ARCHIVE',
          '已删除项目须先在原数据目录恢复后再导出',
        );
        repo.db
          .prepare(
            'INSERT INTO projects(id,name,question,revision,created_at,deleted_at) VALUES(?,?,?,?,?,NULL)',
          )
          .run(project.id, project.name, project.question, project.revision, project.createdAt);
        const entity = repo.db.prepare(
          'INSERT INTO entities(id,project_id,kind,version,version_id,content_version_id,data,created_at,updated_at,deleted_at) VALUES(?,?,?,?,?,?,?,?,?,?)',
        );
        for (const e of archive.objects)
          entity.run(
            e.id,
            project.id,
            e.kind,
            e.version,
            e.versionId,
            e.contentVersionId,
            JSON.stringify(e.data),
            e.createdAt,
            e.updatedAt,
            e.deletedAt,
          );
        const version = repo.db.prepare(
          'INSERT INTO versions(id,project_id,entity_id,version,content_version_id,snapshot,actor,created_at) VALUES(?,?,?,?,?,?,?,?)',
        );
        for (const { snapshot: e, actor: author } of archive.versions) {
          requireThat(
            !repo.db.prepare('SELECT id FROM versions WHERE id=?').get(e.versionId),
            'VERSION_ID_COLLISION',
            '历史版本身份已存在，导入已停止',
            409,
          );
          version.run(
            e.versionId,
            project.id,
            e.id,
            e.version,
            e.contentVersionId,
            JSON.stringify(e),
            JSON.stringify(author),
            e.updatedAt,
          );
        }
        const link = repo.db.prepare(
          'INSERT OR IGNORE INTO links(project_id,from_id,to_id,role) VALUES(?,?,?,?)',
        );
        for (const e of archive.objects)
          if (!e.deletedAt)
            for (const ref of references(e)) link.run(project.id, e.id, ref.id, ref.role);
        for (const [id, text] of materials)
          repo.db
            .prepare('INSERT INTO materials(project_id,source_version_id,text) VALUES(?,?,?)')
            .run(project.id, id, text);
        for (const file of archive.files)
          repo.db
            .prepare(
              'INSERT INTO file_assets(id,project_id,source_id,name,mime,hash,bytes,retrieved_at,published_at) VALUES(?,?,?,?,?,?,?,?,?)',
            )
            .run(
              file.id,
              project.id,
              file.sourceId,
              file.name,
              file.mime,
              file.hash,
              file.base64 === null ? Buffer.alloc(0) : Buffer.from(file.base64, 'base64'),
              file.retrievedAt,
              file.publishedAt,
            );
        for (const artifact of archive.artifacts)
          repo.db
            .prepare(
              'INSERT INTO parsed_artifacts(project_id,source_version_id,file_id,data) VALUES(?,?,?,?)',
            )
            .run(
              project.id,
              artifact.sourceVersionId,
              artifact.fileId,
              JSON.stringify(artifact.data),
            );
        for (const task of archive.tasks) {
          requireThat(
            !repo.db.prepare('SELECT id FROM jobs WHERE id=?').get(task.id),
            'TASK_ID_COLLISION',
            '任务历史身份重复',
            409,
          );
          const state = ['queued', 'running'].includes(task.state) ? 'interrupted' : task.state;
          repo.db
            .prepare(
              'INSERT INTO jobs(id,project_id,kind,state,input,output,error,attempt,run_token,created_at,updated_at,dedupe_key,usage) VALUES(?,?,?,?,?,?,?,?,NULL,?,?,?,?)',
            )
            .run(
              task.id,
              project.id,
              task.kind,
              state,
              JSON.stringify(task.input),
              JSON.stringify(task.output),
              task.error,
              task.attempt,
              task.createdAt,
              task.updatedAt,
              task.dedupeKey,
              JSON.stringify(task.usage),
            );
        }
        repo.db
          .prepare('INSERT INTO layouts(project_id,version,data,updated_at) VALUES(?,?,?,?)')
          .run(
            project.id,
            archive.layout.version,
            JSON.stringify(archive.layout.data),
            this.write.clock(),
          );
        for (const group of archive.workflowGroups) {
          requireThat(
            !repo.db.prepare('SELECT id FROM workflow_groups WHERE id=?').get(group.id),
            'WORKFLOW_ID_COLLISION',
            '研究操作身份已存在',
            409,
          );
          repo.db
            .prepare(
              'INSERT INTO workflow_groups(id,project_id,root_job_id,applied,stopped) VALUES(?,?,?,?,?)',
            )
            .run(
              group.id,
              project.id,
              group.rootJobId,
              group.applied ? 1 : 0,
              group.stopped ? 1 : 0,
            );
          for (const jobId of group.taskIds)
            repo.db
              .prepare('INSERT INTO workflow_group_tasks(job_id,project_id,group_id) VALUES(?,?,?)')
              .run(jobId, project.id, group.id);
        }
        if (archive.actionHistory) saveJournal(repo, project.id, archive.actionHistory);
        for (const j of archive.judgments) {
          requireThat(
            !repo.db.prepare('SELECT id FROM judgments WHERE id=?').get(j.id),
            'JUDGMENT_ID_COLLISION',
            '历史判断身份已存在，导入已停止',
            409,
          );
          repo.db
            .prepare('INSERT INTO judgments(id,project_id,title,refs,created_at) VALUES(?,?,?,?,?)')
            .run(j.id, project.id, j.title, j.refs, j.createdAt);
        }
        this.search.index(
          [...histories.values()].filter((e) => e.kind !== 'source_version' || materials.has(e.id)),
          materials,
        );
        const provenance = {
          importedAt: this.write.clock(),
          archiveHash: digest(archive),
          historyAuthenticity: 'unverified',
          omissions,
        };
        repo.db
          .prepare('INSERT INTO settings(key,value) VALUES(?,?)')
          .run(`import:${project.id}`, JSON.stringify(provenance));
        return { project: repo.project(project.id), provenance };
      },
    );
  }
  /** Read-only integrity gate shared by restore and migration previews. */
  validate(archive: Archive) {
    const objects = new Map<string, AnyEntity>();
    const histories = new Map<string, AnyEntity>();
    const grouped = new Map<string, AnyEntity[]>();
    const materials = new Map<string, string>();
    const omissions: string[] = [];
    for (const e of archive.objects) {
      requireThat(
        e.projectId === archive.project.id && !objects.has(e.id),
        'INVALID_ARCHIVE',
        '资产的项目范围或对象身份重复',
      );
      objects.set(e.id, e);
    }
    for (const { snapshot: e } of archive.versions) {
      requireThat(
        e.projectId === archive.project.id && objects.has(e.id) && !histories.has(e.versionId),
        'INVALID_HISTORY',
        '历史版本范围或身份错误',
      );
      histories.set(e.versionId, e);
      const group = grouped.get(e.id) ?? [];
      group.push(e);
      grouped.set(e.id, group);
    }
    for (const e of objects.values()) {
      const history = (grouped.get(e.id) ?? []).sort((a, b) => a.version - b.version);
      requireThat(
        history.length === e.version &&
          history.every(
            (v, i) =>
              v.version === i + 1 &&
              v.kind === e.kind &&
              v.createdAt === e.createdAt &&
              Date.parse(v.updatedAt) >= Date.parse(v.createdAt) &&
              (i === 0 || Date.parse(v.updatedAt) >= Date.parse(history[i - 1]!.updatedAt)),
          ),
        'INVALID_HISTORY',
        '编辑历史缺失、不连续或时间顺序错误',
      );
      requireThat(
        canonical(history.at(-1)) === canonical(e),
        'INVALID_HISTORY',
        '最新对象与历史中的最新版本不一致',
      );
    }
    for (const m of archive.materials) {
      const e = objects.get(m.id);
      requireThat(
        e?.kind === 'source_version' && !materials.has(m.id) && !omissions.includes(m.id),
        'INVALID_MATERIAL',
        '材料与来源版本不匹配或重复',
      );
      if (m.text === null) {
        requireThat(Boolean(m.omission), 'INVALID_MATERIAL', '缺失原文必须说明原因');
        omissions.push(m.id);
        continue;
      }
      requireThat(
        m.text.length === e.data.textLength &&
          createHash('sha256').update(m.text).digest('hex') === e.data.contentHash,
        'MATERIAL_HASH_MISMATCH',
        '材料原文与记录的长度或指纹不匹配',
      );
      materials.set(m.id, m.text);
    }
    const files = new Map(archive.files.map((f) => [f.id, f]));
    requireThat(files.size === archive.files.length, 'INVALID_FILE', '原文件身份重复');
    const fileHashes = new Set<string>();
    for (const file of archive.files) {
      requireThat(objects.get(file.sourceId)?.kind === 'source', 'INVALID_FILE', '原文件来源缺失');
      const sourceHash = canonical([file.sourceId, file.hash]);
      requireThat(!fileHashes.has(sourceHash), 'INVALID_FILE', '同一来源的原文件指纹重复');
      fileHashes.add(sourceHash);
      if (file.base64 === null) {
        requireThat(Boolean(file.omission), 'INVALID_FILE', '缺失原文件需说明原因');
        continue;
      }
      const bytes = Buffer.from(file.base64, 'base64');
      requireThat(
        bytes.toString('base64') === file.base64 &&
          createHash('sha256').update(bytes).digest('hex') === file.hash,
        'INVALID_FILE',
        '原文件编码或指纹不匹配',
      );
    }
    const artifactIds = new Set<string>();
    for (const artifact of archive.artifacts) {
      const version = objects.get(artifact.sourceVersionId);
      requireThat(
        version?.kind === 'source_version' &&
          version.data.fileId === artifact.fileId &&
          files.has(artifact.fileId) &&
          !artifactIds.has(artifact.sourceVersionId),
        'INVALID_ARTIFACT',
        '解析产物身份或原文件引用错误',
      );
      artifactIds.add(artifact.sourceVersionId);
      if ('text' in artifact.data)
        requireThat(
          artifact.data.text === materials.get(artifact.sourceVersionId),
          'INVALID_ARTIFACT',
          '解析产物文本与材料版本不同',
        );
    }
    const taskIds = new Set(archive.tasks.map((t) => t.id));
    requireThat(
      taskIds.size === archive.tasks.length &&
        archive.tasks.every((t) => t.projectId === archive.project.id),
      'INVALID_TASK_HISTORY',
      '任务身份重复或范围不属于此项目',
    );
    for (const task of archive.tasks) {
      if (task.input && typeof task.input === 'object' && 'update' in task.input) {
        requireThat(
          task.kind === 'research.impact',
          'INVALID_UPDATE_SCOPE',
          '更新事件只能绑定影响分析任务',
        );
        validateUpdateScope(
          task.input,
          (id, version) => {
            const e = histories.get(version);
            return e?.id === id ? e : undefined;
          },
          (id) =>
            [...histories.values()].find(
              (e) => e.id === id && e.kind === 'source_version' && !e.deletedAt,
            ),
        );
      }
    }
    for (const e of histories.values()) {
      const content = histories.get(e.contentVersionId);
      requireThat(
        content?.id === e.id && content.version <= e.version,
        'INVALID_HISTORY',
        '内容版本引用错误',
      );
      for (const ref of references(e))
        requireThat(objects.has(ref.id), 'INVALID_HISTORY', '历史引用的对象身份缺失');
      for (const ref of pinned(e))
        requireThat(
          histories.get(ref.versionId)?.id === ref.id,
          'INVALID_HISTORY',
          '固定的历史版本缺失或身份不符',
        );
      if (e.kind === 'source_version')
        requireThat(
          materials.has(e.id) || omissions.includes(e.id),
          'MATERIAL_MISSING',
          '材料既无原文也无缺失说明',
        );
      if (e.kind === 'review') {
        const task = archive.tasks.find((t) => t.id === e.data.jobId);
        const candidate = resolveImpactProposal(task, e.data.proposalIndex);
        validateImpactBinding(candidate, (id, version) => {
          const e = histories.get(version);
          return e?.id === id ? e : undefined;
        });
        const target = histories.get(e.data.target.versionId);
        const ids =
          target?.kind === 'inference'
            ? [...new Set([...target.data.premiseIds, target.data.conclusionId])].sort()
            : [];
        requireThat(
          (target?.kind === 'statement' || target?.kind === 'inference') &&
            !target.deletedAt &&
            e.data.target.id === e.data.proposalTarget.id &&
            canonical(ids) === canonical(e.data.context.map((r) => r.id)) &&
            e.data.context.every(
              (r) =>
                histories.get(r.versionId)?.kind === 'statement' &&
                histories.get(r.versionId)?.contentVersionId === r.versionId,
            ) &&
            candidate.fingerprint === e.data.proposalHash &&
            canonical(candidate.proposal.target) === canonical(e.data.proposalTarget),
          'INVALID_REVIEW_HISTORY',
          '复核记录与原建议、目标或前提版本不一致',
        );
      }
      if (e.kind === 'evidence_link' && e.data.context) {
        const target = histories.get(e.data.target.versionId);
        const ids =
          target?.kind === 'inference'
            ? [...new Set([...target.data.premiseIds, target.data.conclusionId])].sort()
            : [];
        requireThat(
          (target?.kind === 'statement' || target?.kind === 'inference') &&
            target.contentVersionId === e.data.target.versionId &&
            canonical(ids) === canonical(e.data.context.map((r) => r.id)) &&
            e.data.context.every(
              (r) =>
                histories.get(r.versionId)?.kind === 'statement' &&
                histories.get(r.versionId)?.contentVersionId === r.versionId,
            ),
          'INVALID_EVIDENCE_CONTEXT',
          '证据关联的前提版本不完整或不匹配',
        );
      }
      if (e.kind === 'verification_node') {
        const target = histories.get(e.data.target.versionId);
        const contextIds =
          target?.kind === 'inference'
            ? [...new Set([...target.data.premiseIds, target.data.conclusionId])].sort()
            : [];
        requireThat(
          (target?.kind === 'statement' || target?.kind === 'inference') &&
            target.contentVersionId === e.data.target.versionId &&
            JSON.stringify(contextIds) === JSON.stringify(e.data.context.map((r) => r.id)) &&
            e.data.context.every(
              (r) =>
                histories.get(r.versionId)?.kind === 'statement' &&
                histories.get(r.versionId)?.contentVersionId === r.versionId,
            ),
          'INVALID_HISTORY',
          '验证节点上下文与固定的目标版本不一致',
        );
        if (e.data.basedOn) {
          const based = histories.get(e.data.basedOn.versionId);
          requireThat(
            based?.kind === 'verification_node' &&
              based.data.status === 'candidate' &&
              based.data.target.id === e.data.target.id,
            'INVALID_HISTORY',
            '验证节点的候选来历无效',
          );
        }
        if (e.data.sourceTask)
          requireThat(
            archive.tasks.some((t) => t.id === e.data.sourceTask && t.kind === 'workflow.initial'),
            'INVALID_TASK_HISTORY',
            '验证节点所引用的任务缺失',
          );
      }
      if (e.kind === 'source_version' && e.data.derivedFrom) {
        const prior = objects.get(e.data.derivedFrom);
        requireThat(
          prior?.kind === 'source_version' &&
            prior.data.fileId === e.data.fileId &&
            prior.data.sourceId === e.data.sourceId,
          'INVALID_TRANSCRIPTION',
          '转写来历必须属于同一原文件与来源',
        );
      }
      if (e.kind === 'source_version' && e.data.fileId)
        requireThat(
          files.get(e.data.fileId)?.sourceId === e.data.sourceId,
          'INVALID_FILE',
          '来源版本所用原文件缺失',
        );
      if ((e.kind === 'statement' || e.kind === 'inference') && e.data.stance.reasonProvenance)
        requireThat(
          taskIds.has(e.data.stance.reasonProvenance.jobId),
          'DRAFT_NOT_FOUND',
          '立场理由引用的 AI 任务历史缺失',
        );
      if ((e.kind === 'statement' || e.kind === 'inference') && e.data.editProvenance) {
        const provenance = e.data.editProvenance;
        requireThat(
          taskIds.has(provenance.jobId),
          'PROPOSAL_NOT_FOUND',
          '修改建议引用的 AI 任务历史缺失',
        );
        requireThat(
          histories.get(provenance.previous.versionId)?.id === provenance.previous.id,
          'INVALID_HISTORY',
          '修改建议采用前的版本缺失',
        );
      }
      walkCitations(e.data, (c) => {
        if (isImageCitation(c)) {
          const version = objects.get(c.sourceVersionId),
            file = archive.files.find((f) => f.id === c.fileId);
          requireThat(
            version?.kind === 'source_version' &&
              version.data.fileId === c.fileId &&
              file?.sourceId === version.data.sourceId,
            'INVALID_IMAGE_CITATION',
            '原图引用与材料版本不匹配',
          );
          if (!file.base64)
            requireThat(
              Boolean(c.unavailableReason) && Boolean(file.omission),
              'INVALID_IMAGE_CITATION',
              '缺失原图的引用须标出不可复核',
            );
          else {
            const image = rasterImage(Buffer.from(file.base64, 'base64'), file.mime);
            requireThat(
              image.width === c.imageWidth && image.height === c.imageHeight,
              'INVALID_IMAGE_CITATION',
              '引用尺寸与原图不一致',
            );
          }
          return;
        }
        const text = materials.get(c.sourceVersionId);
        requireThat(
          objects.get(c.sourceVersionId)?.kind === 'source_version',
          'INVALID_CITATION',
          '引用来源版本不存在',
        );
        if (text === undefined)
          requireThat(
            Boolean(c.unavailableReason) && c.quote === '' && omissions.includes(c.sourceVersionId),
            'INVALID_CITATION',
            '缺失材料的引用未标出不可复核',
          );
        else
          requireThat(
            c.start < c.end && text.slice(c.start, c.end) === c.quote,
            'INVALID_CITATION',
            '历史引用与原文不匹配',
          );
      });
    }
    assertGraph(objects);
    for (const id of Object.keys(archive.layout.data.positions))
      requireThat(objects.has(id), 'INVALID_LAYOUT_REFERENCE', '布局引用不存在的对象');
    for (const j of archive.judgments) {
      const refs = z.array(Ref).parse(JSON.parse(j.refs));
      requireThat(
        new Set(refs.map((r) => r.id)).size === refs.length &&
          refs.every((r) => histories.get(r.versionId)?.id === r.id),
        'INVALID_JUDGMENT',
        '历史判断引用缺失或重复',
      );
    }
    const workflowGroups = new Map(archive.workflowGroups.map((g) => [g.id, g]));
    requireThat(
      workflowGroups.size === archive.workflowGroups.length,
      'INVALID_WORKFLOW_HISTORY',
      '研究操作身份重复',
    );
    const groupedJobs = new Map<string, string>();
    const tasksById = new Map(archive.tasks.map((task) => [task.id, task]));
    for (const group of archive.workflowGroups) {
      const root = tasksById.get(group.rootJobId);
      const input = root?.input as { owner?: string; reconstructionJobId?: string } | undefined;
      requireThat(
        root?.kind === 'workflow.initial' &&
          input?.owner === group.id &&
          group.taskIds.includes(group.rootJobId) &&
          !!input.reconstructionJobId &&
          tasksById.get(input.reconstructionJobId)?.kind === 'research.reconstruct' &&
          group.taskIds.includes(input.reconstructionJobId),
        'INVALID_WORKFLOW_HISTORY',
        '研究操作缺少匹配的父任务或重建任务',
      );
      requireThat(
        group.applied || group.stopped,
        'INVALID_WORKFLOW_HISTORY',
        '已撤销的研究必须停止执行',
      );
      for (const id of group.taskIds) {
        const task = tasksById.get(id);
        const workflow = (task?.input as { workflow?: { owner?: string } } | undefined)?.workflow;
        requireThat(
          task &&
            !groupedJobs.has(id) &&
            (id === group.rootJobId ||
              ['source.sec', 'source.sec-filing', 'source.sec-history'].includes(task.kind) ||
              (['research.reconstruct', 'research.verify'].includes(task.kind) &&
                workflow?.owner === group.id)),
          'INVALID_WORKFLOW_HISTORY',
          '研究阶段任务缺失、重复或属于其他研究',
        );
        requireThat(
          !group.stopped || !['queued', 'running', 'interrupted'].includes(task.state),
          'INVALID_WORKFLOW_HISTORY',
          '已停止研究仍含可运行任务',
        );
        groupedJobs.set(id, group.id);
      }
    }
    for (const task of archive.tasks)
      if (task.historyState) {
        const group = workflowGroups.get(groupedJobs.get(task.id) ?? '');
        requireThat(
          group &&
            task.historyState ===
              (!group.applied ? 'undone' : group.stopped ? 'stopped' : 'applied'),
          'INVALID_WORKFLOW_HISTORY',
          '任务的操作历史状态与分组不一致',
        );
      }
    if (archive.actionHistory) {
      const journal = archive.actionHistory;
      requireThat(
        new Set(journal.entries.map((e) => e.id)).size === journal.entries.length,
        'INVALID_ACTION_HISTORY',
        '撤销记录身份重复',
      );
      const lookup = (id: string, v: string) => {
        const e = histories.get(v);
        return e?.id === id ? e : undefined;
      };
      const seenGroups = new Set<string>();
      for (const [index, entry] of journal.entries.entries()) {
        if (entry.workflowId) {
          const group = workflowGroups.get(entry.workflowId);
          requireThat(
            group &&
              !seenGroups.has(group.id) &&
              group.applied === index < journal.cursor &&
              !entry.layout &&
              entry.objects.every((e) => e.before === null),
            'INVALID_WORKFLOW_HISTORY',
            '研究操作步骤与分组或游标不匹配',
          );
          seenGroups.add(group.id);
        }
        requireThat(
          new Set(entry.objects.map((e) => e.id)).size === entry.objects.length,
          'INVALID_ACTION_HISTORY',
          '撤销记录对象重复',
        );
        for (const layout of entry.layout ? [entry.layout.before, entry.layout.after] : [])
          for (const id of [
            ...Object.keys(layout.positions),
            ...Object.values(layout.canvas?.attachments ?? {}).map((a) => a.target),
          ])
            requireThat(objects.has(id), 'INVALID_ACTION_HISTORY', '撤销布局引用的对象不存在');
      }
      for (const direction of ['undo', 'redo'] as const) {
        const replay = { ...journal };
        let state = new Map(objects);
        while (direction === 'undo' ? replay.cursor > 0 : replay.cursor < replay.entries.length) {
          state = applyHistoryEntry(state, replay, direction, lookup);
          replay.cursor += direction === 'undo' ? -1 : 1;
        }
      }
    }
    return { materials, histories, omissions };
  }
}
function pinned(e: AnyEntity): { id: string; versionId: string }[] {
  switch (e.kind) {
    case 'statement':
    case 'condition':
      return e.data.lineage ? [e.data.lineage] : [];
    case 'evidence_link':
      return [e.data.target, ...(e.data.context ?? [])];
    case 'evaluation':
      return [e.data.condition, ...(e.data.basedOn ? [e.data.basedOn] : [])];
    case 'verification_node':
      return [e.data.target, ...e.data.context, ...(e.data.basedOn ? [e.data.basedOn] : [])];
    case 'review':
      return [e.data.target, e.data.proposalTarget, ...e.data.context];
    default:
      return [];
  }
}
function walkCitations(value: unknown, visit: (v: z.infer<typeof Citation>) => void): void {
  if (!value || typeof value !== 'object') return;
  if (
    'sourceVersionId' in value &&
    ('quote' in value || ('kind' in value && value.kind === 'image'))
  )
    visit(Citation.parse(value));
  else for (const child of Object.values(value)) walkCitations(child, visit);
}
