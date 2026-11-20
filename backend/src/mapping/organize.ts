import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { canonical } from '../domain/canonical.js';
import { DomainError, requireThat } from '../domain/errors.js';
import type { AccessService, Principal } from '../services/access.js';
import { OrganizeStore, type StoredTask } from './organize-store.js';
import {
  ORGANIZE_MAX_INPUT, OrganizeCancel, OrganizeRequest, OrganizeRetry,
  type OrganizeInput, type OrganizeOutput, type OrganizeSummary, type OrganizeTask, type OrganizeUsage,
} from './organize-contracts.js';

export interface OrganizeModel {
  readonly model: string;
  generate(job: { taskId: string; attempt: number; input: OrganizeInput }, signal: AbortSignal,
    onUsage: (usage: OrganizeUsage) => void):
    Promise<{ result: OrganizeOutput; usage: OrganizeUsage | null }>;
}

export class OrganizeTasks {
  private readonly pending = new Map<string, { abort: AbortController; projectId: string; task: StoredTask }>();
  private closed = false;
  private readonly store: OrganizeStore;

  constructor(
    private readonly db: Database.Database,
    private readonly access: AccessService,
    private readonly model?: OrganizeModel,
  ) {
    this.store = new OrganizeStore(db);
  }

  private authorize(projectId: string, actor: Principal) {
    this.access.validate(actor);
    this.access.project(actor, projectId);
    this.access.human(actor);
    requireThat(this.db.prepare('SELECT 1 FROM mapping_projects WHERE id=?').get(projectId), 'NOT_FOUND', '项目不存在', 404);
  }

  private freshness(projectId: string, input: OrganizeInput): OrganizeTask['freshness'] {
    const card = this.store.card(projectId, input.cardId);
    if (!card) return 'deleted';
    return card.versionId === input.thoughtVersionId && card.body.versionId === input.bodyVersionId
      ? 'current' : 'changed';
  }

  private view(projectId: string, task: StoredTask): OrganizeTask {
    const data = structuredClone(task);
    this.expire(data);
    const { candidateId, deadline, attempts, ...value } = data;
    return { ...value, attempts: attempts.map(({ retryId, ...attempt }) => attempt),
      candidateOnCanvas: value.applied && Boolean(this.store.card(projectId, candidateId)),
      freshness: this.freshness(projectId, task.input) };
  }

  status(projectId: string, actor: Principal) {
    this.authorize(projectId, actor);
    return { model: this.model?.model ?? null };
  }

  list(projectId: string, cardId: string | undefined, actor: Principal): OrganizeSummary[] {
    this.authorize(projectId, actor);
    return this.store.list(projectId, cardId);
  }

  archive(projectId: string) {
    return this.store.all(projectId).map(task => this.view(projectId, task));
  }

  get(projectId: string, id: string, actor: Principal) {
    this.authorize(projectId, actor);
    return this.view(projectId, this.store.get(projectId, id));
  }

  start(projectId: string, raw: unknown, actor: Principal) {
    const input = OrganizeRequest.parse(raw);
    const { requestId, ...selection } = input;
    const request = canonical({ ...selection, blockIds: [...input.blockIds].sort() });
    const { task, created } = this.db.transaction(() => {
      this.authorize(projectId, actor);
      const previous = this.store.request(projectId, requestId);
      if (previous) {
        requireThat(previous.request === request, 'IDEMPOTENCY_MISMATCH', '任务编号已用于不同上下文', 409);
        return { task: this.store.get(projectId, previous.taskId), created: false };
      }
      requireThat(input.mode === 'simulate' || this.model, 'ORGANIZE_MODEL_UNCONFIGURED', '真实整理需要配置本机模型', 503);
      const source = this.store.card(projectId, input.cardId);
      requireThat(source && source.versionId === input.thoughtVersionId && source.body.versionId === input.bodyVersionId,
        'ORGANIZE_SOURCE_STALE', '原卡已更改或删除，请重新选择要整理的内容', 409);
      const chosen = new Set(input.blockIds);
      const blocks = source.body.blocks.flatMap(({ id, type, text }) =>
        chosen.has(id) && type === 'text' && typeof text === 'string' && text.trim() ? [{ id, text }] : []);
      requireThat(blocks.length === input.blockIds.length && chosen.size === blocks.length,
        'ORGANIZE_INVALID_SCOPE', '请从当前版本选择有效的文字段落');
      const title = input.includeTitle ? source.title : null;
      const length = (title?.length ?? 0) + blocks.reduce((count, block) => count + block.text.length, 0);
      requireThat((!!title?.trim() || blocks.length > 0) && length <= ORGANIZE_MAX_INPUT,
        'ORGANIZE_INVALID_SCOPE', '请选择有内容的标题或段落，合计最多 24,000 字符');
      const model = input.mode === 'real' ? this.model!.model : null;
      const scope = canonical({ request, model });
      const cached = this.store.forScope(projectId, scope);
      if (cached) {
        this.store.recordRequest(projectId, requestId, request, cached.id);
        return { task: cached, created: false };
      }
      const now = new Date().toISOString();
      const task: StoredTask = {
        id: randomUUID(), candidateId: randomUUID(), cardId: input.cardId, mode: input.mode,
        model,
        input: {
          cardId: source.id, thoughtVersionId: source.versionId, bodyVersionId: source.body.versionId,
          title, blocks, omittedBlockCount: source.body.blocks.length - blocks.length,
        },
        state: 'running', createdAt: now, updatedAt: now, error: null, attempt: 1, output: null, outputAttempt: null,
        usage: null, applied: false, deadline: Date.now() + 130_000,
        attempts: [{ number: 1, state: 'running', requestedAt: now, finishedAt: null, usage: null, output: null, error: null }],
      };
      this.store.create(projectId, scope, task);
      this.store.recordRequest(projectId, requestId, request, task.id);
      return { task, created: true };
    }).immediate();
    if (created) this.launch(projectId, task);
    return { task: this.view(projectId, task), created };
  }

  retry(projectId: string, id: string, raw: unknown, actor: Principal) {
    const request = OrganizeRetry.parse(raw);
    const { task: next, started } = this.db.transaction(() => {
      this.authorize(projectId, actor);
      const task = this.store.get(projectId, id);
      const replay = task.attempts.find(attempt => attempt.retryId === request.requestId);
      if (replay) {
        requireThat(replay.number === request.attempt + 1, 'IDEMPOTENCY_MISMATCH', '重试请求编号与原任务不一致', 409);
        return { task, started: false };
      }
      requireThat(task.attempt === request.attempt, 'ORGANIZE_ATTEMPT_CHANGED', '任务已更新，请先重新读取', 409);
      requireThat(this.freshness(projectId, task.input) === 'current', 'ORGANIZE_SOURCE_STALE', '原卡已更改或删除，请重新选择整理范围', 409);
      this.expire(task);
      requireThat(!task.applied && ['failed', 'partial', 'cancelled', 'interrupted'].includes(task.state),
        'ORGANIZE_NOT_RETRYABLE', '当前任务不能重试', 409);
      requireThat(task.mode === 'simulate' || this.model?.model === task.model, 'ORGANIZE_MODEL_UNCONFIGURED', '请恢复原任务的模型配置，或用当前配置开始新任务', 503);
      task.attempt += 1;
      task.state = 'running';
      task.error = null;
      task.usage = null;
      task.updatedAt = new Date().toISOString();
      task.deadline = Date.now() + 130_000;
      task.attempts.push({ number: task.attempt, retryId: request.requestId, state: 'running', requestedAt: task.updatedAt, finishedAt: null, usage: null, output: null, error: null });
      this.store.save(projectId, task);
      return { task, started: true };
    }).immediate();
    if (started) {
      this.pending.get(id)?.abort.abort();
      this.launch(projectId, next);
    }
    return this.view(projectId, next);
  }

  cancel(projectId: string, id: string, raw: unknown, actor: Principal) {
    const { attempt } = OrganizeCancel.parse(raw);
    const task = this.db.transaction(() => {
      this.authorize(projectId, actor);
      const current = this.store.get(projectId, id);
      requireThat(current.attempt === attempt, 'ORGANIZE_ATTEMPT_CHANGED', '任务已更新，请先重新读取', 409);
      if (current.state === 'running') {
        if (!this.expire(current)) this.finishAttempt(current, 'cancelled', current.usage);
        this.store.save(projectId, current);
      }
      return current;
    }).immediate();
    if (task.state === 'cancelled' || task.state === 'interrupted') {
      const pending = this.pending.get(id);
      if (pending?.task.attempt === attempt) pending.abort.abort();
    }
    return this.view(projectId, task);
  }

  takeCandidate(projectId: string, id: string, attempt: number) {
    const task = this.store.get(projectId, id);
    requireThat(!task.applied && task.attempt === attempt && ['succeeded', 'partial'].includes(task.state) && task.output?.candidate,
      'ORGANIZE_RESULT_UNAVAILABLE', '结果已添加、已更新或尚不可添加，请重新审阅', 409);
    requireThat(this.freshness(projectId, task.input) === 'current',
      'ORGANIZE_SOURCE_STALE', '原卡已更改或删除，请重新选择整理范围', 409);
    task.applied = true;
    task.updatedAt = new Date().toISOString();
    this.store.save(projectId, task);
    return { id: task.candidateId, ...task.output.candidate, aiOrigin: { taskId: task.id, mode: task.mode } };
  }

  private finishAttempt(task: StoredTask, state: OrganizeTask['state'], usage: OrganizeUsage | null,
    output: OrganizeOutput | null = null, error: string | null = null, finishedAt = new Date().toISOString()) {
    task.state = state;
    task.error = error;
    task.updatedAt = finishedAt;
    const attempt = task.attempts[task.attempts.length - 1]!;
    Object.assign(attempt, { state, finishedAt: task.updatedAt, usage, output, error });
    task.usage = usage;
  }

  private expire(task: StoredTask) {
    if (task.state !== 'running' || task.deadline > Date.now()) return false;
    this.finishAttempt(task, 'interrupted', task.usage, null, '运行已中断，可以重试', new Date(task.deadline).toISOString());
    return true;
  }

  private launch(projectId: string, task: StoredTask) {
    void this.run(projectId, task).catch(() => {
      console.error('整理结果未保存；任务超时后可重试');
    });
  }

  private async run(projectId: string, source: StoredTask) {
    const abort = new AbortController();
    this.pending.set(source.id, { abort, projectId, task: source });
    let output: OrganizeOutput | null = null;
    let usage: OrganizeUsage | null = null;
    let error: string | null = null;
    try {
      if (source.mode === 'simulate') {
        const { title, blocks } = source.input;
        const content = [title, ...blocks.map(block => block.text)].filter(Boolean).join('\n\n').trim();
        output = {
          candidate: {
            title: `模拟整理：${title?.trim().slice(0, 200) || '所选段落'}`,
            text: content.slice(0, 16_000),
          },
          gaps: content.length > 16_000 ? ['模拟结果达到文字上限，后续文字未显示'] : [],
        };
      } else {
        ({ result: output, usage } = await this.model!.generate(
          { taskId: source.id, attempt: source.attempt, input: source.input }, abort.signal, observed => {
            if (this.closed) return;
            this.db.transaction(() => {
              const task = this.store.get(projectId, source.id);
              const attempt = task.attempts.find(item => item.number === source.attempt)!;
              attempt.usage = observed;
              if (task.attempt === source.attempt) task.usage = observed;
              this.store.save(projectId, task);
            }).immediate();
          }));
      }
    } catch (cause) {
      error = cause instanceof DomainError ? cause.message : '整理未完成，请检查本机模型后重试';
    } finally {
      if (this.pending.get(source.id)?.abort === abort) this.pending.delete(source.id);
    }
    if (this.closed || (abort.signal.aborted && !usage)) return;
    this.db.transaction(() => {
      const task = this.store.get(projectId, source.id);
      const attempt = task.attempts.find(item => item.number === source.attempt)!;
      usage = attempt.usage ?? usage;
      if (task.attempt !== source.attempt || task.state !== 'running') {
        if (usage) {
          attempt.usage = usage;
          this.store.save(projectId, task);
        }
        return;
      }
      task.usage = usage;
      if (!this.expire(task)) {
        if (output && (output.candidate || !task.output?.candidate)) {
          task.output = output;
          task.outputAttempt = source.attempt;
        }
        const state = output?.candidate && !output.gaps.length ? 'succeeded'
          : task.output ? 'partial' : 'failed';
        this.finishAttempt(task, state, usage, output, error);
      }
      this.store.save(projectId, task);
    }).immediate();
  }

  close() {
    this.closed = true;
    for (const { abort, projectId, task: source } of this.pending.values()) {
      this.db.transaction(() => {
        const task = this.store.get(projectId, source.id);
        if (task.state === 'running' && task.attempt === source.attempt) {
          if (!this.expire(task)) this.finishAttempt(task, 'interrupted', task.usage, null, '运行已中断，可以重试');
          this.store.save(projectId, task);
        }
      }).immediate();
      abort.abort();
    }
    this.pending.clear();
  }
}
