import { assertWorkflowWritable, travelWorkflow } from '../repositories/workflow-history.js';
import { HistoryTravel } from '../contracts/action-history.js';
import {
  readJournal,
  saveJournal,
  historyStatus,
  recordAction,
  applyHistoryEntry,
  restoreHistoryLayout,
} from '../repositories/action-history.js';
import { digest } from '../domain/canonical.js';
export { canonical, digest } from '../domain/canonical.js';
import { readLayout, saveLayout, pruneLayout } from '../repositories/layout.js';
import { randomUUID } from 'node:crypto';
import { WriteRequest, ProjectInput } from '../contracts/commands.js';
import type { Actor, ChangeSet, Project, AnyEntity } from '../contracts/entities.js';
import { requireThat } from '../domain/errors.js';
import { WriteContext } from '../domain/write-context.js';
import { applyGraph } from '../domain/graph-commands.js';
import { applyResearch } from '../domain/research-commands.js';
import { assertGraph } from '../domain/graph.js';
import type { ResearchRepository } from '../repositories/research.js';

export class GraphWriteService {
  constructor(
    readonly repo: ResearchRepository,
    readonly clock: () => string = () => new Date().toISOString(),
    readonly onChanged: (
      context: WriteContext,
      changed: AnyEntity[],
      reason?: 'history',
    ) => void = () => {},
    readonly afterWorkflowTravel: (projectId: string, workflowId: string) => void = () => {},
  ) {}
  idempotent<T>(actor: Actor, projectId: string, key: string, input: unknown, run: () => T): T {
    requireThat(
      /^[A-Za-z0-9_-]{8,128}$/.test(key),
      'INVALID_IDEMPOTENCY_KEY',
      '请提供 8 至 128 字符的唯一操作键',
      400,
    );
    return this.repo.db
      .transaction(() => {
        const hash = digest({ actorType: actor.type, input });
        const row = this.repo.db
          .prepare(
            'SELECT hash,response FROM operations WHERE actor_id=? AND project_id=? AND key=?',
          )
          .get(actor.id, projectId, key) as { hash: string; response: string } | undefined;
        if (row) {
          requireThat(row.hash === hash, 'IDEMPOTENCY_CONFLICT', '同一操作键不能用于不同请求', 409);
          return JSON.parse(row.response) as T;
        }
        const result = run();
        this.repo.db
          .prepare(
            'INSERT INTO operations(actor_id,project_id,key,hash,response,created_at) VALUES(?,?,?,?,?,?)',
          )
          .run(actor.id, projectId, key, hash, JSON.stringify(result), this.clock());
        return result;
      })
      .immediate();
  }
  createProject(actor: Actor, key: string, raw: unknown): Project {
    const input = ProjectInput.parse(raw);
    return this.idempotent(actor, '__projects__', key, { op: 'project.create', input }, () => {
      const id = randomUUID();
      this.repo.db
        .prepare('INSERT INTO projects(id,name,question,revision,created_at) VALUES(?,?,?,0,?)')
        .run(id, input.name, input.question, this.clock());
      return this.repo.project(id);
    });
  }
  execute(
    projectId: string,
    actor: Actor,
    key: string,
    raw: unknown,
    workflowId?: string,
  ): ChangeSet {
    const input = WriteRequest.parse(raw);
    this.repo.project(projectId);
    return this.idempotent(
      actor,
      projectId,
      key,
      workflowId ? { input, workflowId } : input,
      () => {
        if (workflowId) {
          requireThat(
            actor.type === 'system',
            'INVALID_WORKFLOW_WRITE',
            '研究分组仅用于受控后台阶段',
            403,
          );
          assertWorkflowWritable(this.repo.db, projectId, workflowId);
        }
        const project = this.repo.project(projectId);
        const oldLayout = readLayout(this.repo, projectId);
        const context = new WriteContext(this.repo, projectId, actor, input.expected, this.clock());
        for (const command of input.commands)
          if (!applyGraph(context, command)) applyResearch(context, command);
        assertGraph(context.objects);
        const changed = context.changed();
        if (changed.length) {
          this.repo.persist(changed, actor, context.texts);
          this.repo.db.prepare('UPDATE projects SET revision=revision+1 WHERE id=?').run(projectId);
          this.onChanged(context, changed);
        }
        const layout = input.layout
          ? saveLayout(this.repo, projectId, input.layout, this.clock(), actor)
          : changed.length
            ? pruneLayout(this.repo, projectId, this.clock())
            : undefined;
        recordAction(
          this.repo,
          projectId,
          actor,
          context.now,
          context.original,
          changed,
          oldLayout,
          layout ?? oldLayout,
          actionLabel(input.commands),
          workflowId,
        );
        return {
          history: this.history(projectId),
          ...(layout ? { layout } : {}),
          projectId,
          revisionBefore: project.revision,
          revisionAfter: project.revision + (changed.length ? 1 : 0),
          upserted: changed.filter((e) => !e.deletedAt),
          deletedIds: changed.filter((e) => e.deletedAt).map((e) => e.id),
        };
      },
    );
  }
  history(projectId: string) {
    return historyStatus(readJournal(this.repo, projectId));
  }
  travel(projectId: string, actor: Actor, key: string, raw: unknown): ChangeSet {
    requireThat(actor.type === 'human', 'HUMAN_REQUIRED', '撤销或重做研究判断须由本人执行', 403);
    const input = HistoryTravel.parse(raw);
    let stoppedGroup: string | undefined;
    const result = this.idempotent(actor, projectId, key, { op: 'history.travel', input }, () => {
      const project = this.repo.project(projectId),
        journal = readJournal(this.repo, projectId),
        oldLayout = readLayout(this.repo, projectId);
      requireThat(
        project.revision === input.expectedRevision &&
          journal.version === input.expectedHistoryVersion &&
          oldLayout.version === input.expectedLayoutVersion,
        'HISTORY_CONFLICT',
        '研究或画布已变化，请重新读取后再撤销／重做',
        409,
      );
      const context = new WriteContext(this.repo, projectId, actor, {}, this.clock());
      const next = applyHistoryEntry(context.objects, journal, input.direction, (id, version) =>
        this.repo.version(projectId, id, version),
      );
      const entry =
        journal.entries[input.direction === 'undo' ? journal.cursor - 1 : journal.cursor]!;
      const changed: AnyEntity[] = [];
      for (const ref of entry.objects) {
        const current = context.objects.get(ref.id)!;
        const saved = next.get(ref.id);
        const e = {
          ...(saved ?? current),
          version: current.version + 1,
          versionId: randomUUID(),
          updatedAt: context.now,
          deletedAt: saved && !saved.deletedAt ? null : context.now,
        } as AnyEntity;
        changed.push(e);
        context.objects.set(e.id, e);
      }
      assertGraph(context.objects);
      if (changed.length) {
        this.repo.persist(changed, actor, new Map());
        this.repo.db.prepare('UPDATE projects SET revision=revision+1 WHERE id=?').run(projectId);
        this.onChanged(context, changed, 'history');
      }
      const layout = entry.layout
        ? saveLayout(
            this.repo,
            projectId,
            {
              expectedVersion: oldLayout.version,
              data: restoreHistoryLayout(
                entry.layout[input.direction === 'undo' ? 'before' : 'after'],
                oldLayout.data,
              ),
            },
            context.now,
            actor,
          )
        : pruneLayout(this.repo, projectId, context.now);
      if (entry.workflowId) {
        travelWorkflow(this.repo.db, projectId, entry.workflowId, input.direction, context.now);
        stoppedGroup = entry.workflowId;
      }
      journal.cursor += input.direction === 'undo' ? -1 : 1;
      journal.version++;
      saveJournal(this.repo, projectId, journal);
      return {
        projectId,
        revisionBefore: project.revision,
        revisionAfter: project.revision + (changed.length ? 1 : 0),
        upserted: changed.filter((e) => !e.deletedAt),
        deletedIds: changed.filter((e) => e.deletedAt).map((e) => e.id),
        ...(layout ? { layout } : {}),
        history: historyStatus(journal),
      };
    });
    if (stoppedGroup) this.afterWorkflowTravel(projectId, stoppedGroup);
    return result;
  }
  operation(projectId: string, actor: Actor, key: string): unknown {
    this.repo.project(projectId);
    const row = this.repo.db
      .prepare('SELECT response FROM operations WHERE actor_id=? AND project_id=? AND key=?')
      .get(actor.id, projectId, key) as { response: string } | undefined;
    requireThat(row, 'OPERATION_NOT_FOUND', '尚未找到此操作结果；重试时使用原操作键', 404);
    return JSON.parse(row.response);
  }
}

function actionLabel(commands: { op: string }[]): string {
  if (!commands.length) return '调整画布布局、批注或样式';
  const names: Record<string, string> = {
    'statement.create': '新建主张',
    'statement.edit': '改写主张',
    'statement.derive': '局部改写主张',
    'statement.copy': '复制主张',
    'inference.create': '新建推导',
    'inference.edit': '修改推导',
    'object.delete': '删除研究对象',
    'stance.set': '保存个人立场',
    'object.adopt': '采用研究对象',
    'evidence.adopt': '采用依据',
    'condition.create': '新建条件',
    'condition.edit': '修改条件',
    'condition.derive': '局部修改条件',
    'evaluation.confirm': '保存条件判断',
    'evaluation.propose': '新增评估建议',
    'verification.confirm': '保存验证节点',
    'impact.review': '记录影响建议复核结果',
    'verification.propose': '新增验证节点建议',
    'material.attach': '加入对象材料',
    'material.hide': '隐藏对象材料',
    'evidence.link': '关联证据',
    'evidence.relate': '修改证据关系',
    'evidence.create': '新增证据',
    'note.create': '记录笔记',
    'impact.adopt': '采用修改建议',
  };
  const labels = [...new Set(commands.map((c) => names[c.op]).filter(Boolean))];
  return labels.length === 1 ? labels[0]! : labels.length ? '批量编辑研究内容' : '导入材料';
}
