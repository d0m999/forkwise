import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { canonical } from '../domain/canonical.js';
import { DomainError, requireThat } from '../domain/errors.js';
import type { AccessService, Principal } from '../services/access.js';
import { hasPendingCardPaste } from './cut.js';
import { canRestoreAnyCard } from './history.js';
import { organizeTextBlocks } from './organize-blocks.js';
import { canRetryOrganize } from './organize-state.js';
import { readAsset, verifyAssetBytes, writeAssetRow } from './media.js';
import { SEC_UNCONFIGURED, verifyPublicFacts, type VerificationSource } from './verification.js';
import type { Card, MediaAsset } from './contracts.js';
import { OrganizeStore, type StoredTask } from './organize-store.js';
import {
  ORGANIZE_MAX_INPUT, OrganizeCancel, OrganizeRequest, OrganizeRetry,
  type OrganizeInput, type OrganizeOutput, type OrganizeSendDisclosure, type OrganizeStatus, type OrganizeSummary,
  type OrganizeTask, type OrganizeTaskView, type OrganizeUsage,
} from './organize-contracts.js';

// Two model calls at 60s each and up to three local preflights at 12s each.
const ATTEMPT_TIMEOUT_MS = 160_000;

export interface OrganizeModel {
  readonly model: string;
  readonly configuredModelDigest?: string;
  readonly reuseAcrossRequests?: boolean;
  readonly sendDisclosure?: OrganizeSendDisclosure;
  resolveDigest(signal: AbortSignal): Promise<string>;
  generate(job: { taskId: string; attempt: number; input: OrganizeInput; modelDigest: string }, signal: AbortSignal,
    onUsage: (usage: OrganizeUsage) => void):
    Promise<{ result: OrganizeOutput; usage: OrganizeUsage | null }>;
}

type StartPlan = Pick<OrganizeRequest, 'requestId' | 'mode' | 'verification'> & {
  projectId: string;
  selection: string;
  input: OrganizeInput;
  model: string | null;
  configuredModelDigest: string | undefined;
  requestedAt: string;
};
type StartResult = { task: OrganizeTask; created: boolean };

export class OrganizeTasks {
  private readonly starting = new Map<string, { plan: StartPlan; abort: AbortController; result: Promise<StartResult> }>();
  private readonly pending = new Map<string, { abort: AbortController; projectId: string; task: StoredTask }>();
  private closed = false;
  private readonly store: OrganizeStore;

  constructor(
    private readonly db: Database.Database,
    private readonly access: AccessService,
    private readonly model?: OrganizeModel,
    private readonly blockedReason = '真实整理尚未启用，可先试用模拟整理',
    private readonly verificationSource?: VerificationSource,
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
    const { candidateId, cutCandidateIds, deadline, modelDigest, configuredModelDigest, startRequestId, attempts, ...value } = data;
    const candidateState = this.candidateState(projectId, data);
    const freshness = this.freshness(projectId, task.input);
    const current = !task.verification || freshness === 'current';
    return { ...value, attempts: attempts.map(({ retryId, ...attempt }) => attempt),
      candidateOnCanvas: candidateState === 'on-canvas',
      addAvailable: current && candidateState === 'add',
      cutCopyAvailable: current && candidateState === 'copy',
      freshness };
  }

  private candidateState(projectId: string, task: StoredTask): 'on-canvas' | 'add' | 'copy' | null {
    const ids = [task.candidateId, ...(task.cutCandidateIds ?? [])];
    if (task.applied && ids.some(id => this.store.card(projectId, id))) return 'on-canvas';
    if (!task.output?.candidate || !['succeeded', 'partial'].includes(task.state)) return null;
    if (!task.applied) return 'add';
    const candidateIds = new Set(ids);
    if (canRestoreAnyCard(this.db, projectId, candidateIds)) return null;
    return hasPendingCardPaste(this.db, projectId, candidateIds) ? 'copy' : 'add';
  }

  status(projectId: string, actor: Principal, verification = false): OrganizeStatus {
    this.authorize(projectId, actor);
    if (verification) return { model: null, blockedReason: this.verificationSource?.client
      ? null : this.verificationSource?.blockedReason ?? SEC_UNCONFIGURED,
      ...(this.verificationSource?.fixture ? { verificationFixture: true } : {}) };
    return this.model ? {
      model: this.model.model,
      blockedReason: null,
      ...(this.model.sendDisclosure && { sendDisclosure: this.model.sendDisclosure }),
    } : { model: null, blockedReason: this.blockedReason };
  }

  list(projectId: string, cardId: string | undefined, actor: Principal, verification = false): OrganizeSummary[] {
    this.authorize(projectId, actor);
    return this.store.list(projectId, cardId, verification);
  }

  archive(projectId: string) {
    return this.store.all(projectId).map(task => this.view(projectId, task));
  }

  get(projectId: string, id: string, actor: Principal): OrganizeTaskView {
    this.authorize(projectId, actor);
    const task = this.store.get(projectId, id);
    return { ...this.view(projectId, task), retryBlockedReason: this.retryBlock(task)?.message ?? null };
  }

  private reusableModelTask(projectId: string, request: string, model: string, digest: string) {
    const current = this.store.forScope(projectId, canonical({ request, model, digest }));
    if (current) return current;
    // Legacy keys only named the model. Reuse only a result with a matching observed digest.
    const legacy = this.store.forScope(projectId, canonical({ request, model }));
    if (legacy && outputDigest(legacy) === digest) return legacy;
  }

  start(projectId: string, raw: unknown, actor: Principal): Promise<StartResult> {
    return this.handleStartRequest(projectId, raw, actor, 'start');
  }

  async cancelStart(projectId: string, raw: unknown, actor: Principal): Promise<OrganizeTask> {
    return (await this.handleStartRequest(projectId, raw, actor, 'cancel')).task;
  }

  private async handleStartRequest(projectId: string, raw: unknown, actor: Principal, action: 'start' | 'cancel'): Promise<StartResult> {
    const input = OrganizeRequest.parse(raw);
    const { requestId, disclosureId, ...scope } = input;
    const selection = selectionKey(scope);
    this.authorize(projectId, actor);
    const cancelling = action === 'cancel';
    requireThat(!cancelling || input.mode === 'real', 'ORGANIZE_INVALID_SCOPE', '当前请求无需取消模型预检');
    const previous = this.replayStart(projectId, requestId, selection);
    if (previous) {
      // A request that reused another task never owns that task's running attempt.
      const task = cancelling && previous.startRequestId === requestId && previous.attempt === 1
        ? this.cancelAttempt(projectId, previous.id, 1, actor)
        : this.view(projectId, previous);
      return { task, created: false };
    }

    const key = canonical([projectId, requestId]);
    const pending = this.starting.get(key);
    if (pending) {
      requireThat(pending.plan.selection === selection, 'IDEMPOTENCY_MISMATCH', '任务编号已用于不同上下文', 409);
      if (!cancelling) {
        let taskId: string;
        try {
          taskId = (await pending.result).task.id;
        } finally {
          this.authorize(projectId, actor);
        }
        return { task: this.view(projectId, this.store.get(projectId, taskId)), created: false };
      }
    }
    const model = input.mode === 'real' && !input.verification ? this.model : undefined;
    requireThat(input.mode === 'simulate' || input.verification || model, 'ORGANIZE_MODEL_UNCONFIGURED', this.blockedReason, 503);
    if (!cancelling && model) this.requireSendDisclosure(disclosureId);
    const plan = pending?.plan ?? {
      projectId, requestId, selection, mode: input.mode, model: model?.model ?? null,
      verification: input.verification,
      configuredModelDigest: model?.configuredModelDigest,
      requestedAt: new Date().toISOString(), input: this.freezeInput(projectId, input),
    };
    if (cancelling) {
      // Commit the cancelled receipt first, including when cancellation arrives before start.
      const result = this.completeStart(plan, actor, { state: 'cancelled' });
      pending?.abort.abort();
      return result;
    }
    if (!model) return this.completeStart(plan, actor, { state: 'ready', digest: null });

    const abort = new AbortController();
    const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(12_000)]);
    const result = this.checkModelAndStart(plan, actor, model, signal).finally(() => this.starting.delete(key));
    this.starting.set(key, { plan, abort, result });
    return result;
  }

  private requireSendDisclosure(id?: string) {
    const current = this.model?.sendDisclosure;
    requireThat(!current || id === current.id, 'ORGANIZE_DISCLOSURE_CHANGED',
      '请重新打开 AI 整理，确认当前的发送和留存说明后再试。', 409);
  }

  private replayStart(projectId: string, requestId: string, selection: string) {
    const previous = this.store.request(projectId, requestId);
    if (!previous) return undefined;
    requireThat(previous.request === selection, 'IDEMPOTENCY_MISMATCH', '任务编号已用于不同上下文', 409);
    return this.store.get(projectId, previous.taskId);
  }

  private freezeInput(projectId: string, input: OrganizeRequest): OrganizeInput {
    const source = this.store.card(projectId, input.cardId);
    requireThat(source && source.versionId === input.thoughtVersionId && source.body.versionId === input.bodyVersionId,
      'ORGANIZE_SOURCE_STALE', input.verification ? '原卡已更改或删除，请重新打开查证' : '原卡已更改或删除，请重新选择要整理的内容', 409);
    if (input.verification) return {
      cardId: source.id, thoughtVersionId: source.versionId, bodyVersionId: source.body.versionId,
      title: null, blocks: [], omittedBlockCount: source.body.blocks.length,
    };
    const chosen = new Set(input.blockIds);
    const blocks = organizeTextBlocks(source.body.blocks)
      .filter(block => chosen.has(block.id)).map(({ id, text }) => ({ id, text }));
    requireThat(blocks.length === input.blockIds.length
      && chosen.size === blocks.length && new Set(blocks.map(block => block.id)).size === chosen.size,
      'ORGANIZE_INVALID_SCOPE', '请从当前版本选择有效的正文文字');
    const title = input.includeTitle ? source.title : null;
    const length = (title?.length ?? 0) + blocks.reduce((count, block) => count + block.text.length, 0);
    requireThat((!!title?.trim() || blocks.length > 0) && length <= ORGANIZE_MAX_INPUT,
      'ORGANIZE_INVALID_SCOPE', '请选择有内容的标题或正文块，合计最多 24,000 字符');
    return {
      cardId: source.id, thoughtVersionId: source.versionId, bodyVersionId: source.body.versionId,
      title, blocks, omittedBlockCount: source.body.blocks.length - blocks.length,
    };
  }

  private async checkModelAndStart(plan: StartPlan, actor: Principal, model: OrganizeModel, signal: AbortSignal) {
    let digest: string;
    try {
      digest = await model.resolveDigest(signal);
      signal.throwIfAborted();
    } catch (cause) {
      return this.completeStart(plan, actor, { state: 'failed', error: modelError(cause) });
    }
    return this.completeStart(plan, actor, { state: 'ready', digest });
  }

  private completeStart(plan: StartPlan, actor: Principal, check:
    { state: 'ready'; digest: string | null } | { state: 'failed'; error: string } | { state: 'cancelled' }): StartResult {
    const { projectId, requestId, selection, input, mode, verification, model, configuredModelDigest, requestedAt } = plan;
    const digest = check.state === 'ready' ? check.digest : null;
    requireThat(!this.closed, 'ORGANIZE_CLOSED', '工作台正在关闭，请重新打开后重试', 503);
    const { task, created } = this.db.transaction(() => {
      this.authorize(projectId, actor);
      const previous = this.replayStart(projectId, requestId, selection);
      if (previous) return { task: previous, created: false };
      if (check.state !== 'cancelled') {
        requireThat(this.freshness(projectId, input) === 'current',
          'ORGANIZE_SOURCE_STALE', verification ? '原卡已更改或删除，请重新打开查证' : '原卡已更改或删除，请重新选择要整理的内容', 409);
      }
      // A new public lookup or rolling model request needs a fresh receipt.
      const requestOnly = !!verification || (model !== null && this.model?.reuseAcrossRequests === false);
      const scope = requestOnly ? canonical({ request: selection, requestId }) : model
        ? canonical({ request: selection, model, digest, ...(digest === null ? { requestId } : {}) })
        : canonical({ request: selection, model: null });
      const cached = !requestOnly && model && digest
        ? this.reusableModelTask(projectId, selection, model, digest)
        : this.store.forScope(projectId, scope);
      if (cached) {
        this.store.recordRequest(projectId, requestId, selection, cached.id);
        return { task: cached, created: false };
      }
      const now = new Date().toISOString();
      const task: StoredTask = {
        id: randomUUID(), candidateId: randomUUID(), cardId: input.cardId, mode, model, startRequestId: requestId,
        ...(verification ? { verification, ...(this.verificationSource?.fixture ? { verificationFixture: true } : {}) } : {}),
        ...(digest ? { modelDigest: digest } : configuredModelDigest ? { configuredModelDigest } : {}),
        input,
        state: 'running', createdAt: requestedAt, updatedAt: now, error: null, attempt: 1, output: null, outputAttempt: null,
        usage: null, applied: false, deadline: Date.now() + ATTEMPT_TIMEOUT_MS,
        attempts: [{ number: 1, state: 'running', requestedAt, finishedAt: null, usage: null, output: null, error: null }],
      };
      if (check.state !== 'ready') this.finishAttempt(task, check.state, null, null, check.state === 'failed' ? check.error : null);
      this.store.create(projectId, scope, task);
      this.store.recordRequest(projectId, requestId, selection, task.id);
      return { task, created: true };
    }).immediate();
    if (created && check.state === 'ready') this.launch(projectId, task, digest);
    return { task: this.view(projectId, task), created };
  }

  private retryBlock(task: StoredTask) {
    if (task.verification) {
      if (!this.verificationSource?.client) return {
        code: 'SEC_NOT_CONFIGURED', message: this.verificationSource?.blockedReason ?? SEC_UNCONFIGURED, status: 503,
      } as const;
      if (task.verificationFixture !== this.verificationSource.fixture) return {
        code: 'SEC_SOURCE_CHANGED', message: '查证来源模式已更改，请重新发起查证。', status: 409,
      } as const;
      return null;
    }
    if (task.mode === 'simulate') return null;
    if (this.model?.model !== task.model) {
      const message = !this.model && task.model?.startsWith('openai/')
        ? this.blockedReason : '这条记录使用的模型当前不可用，无法重试。';
      return { code: 'ORGANIZE_MODEL_UNCONFIGURED', message, status: 503 } as const;
    }
    const configuredDigest = this.model?.configuredModelDigest;
    if (configuredDigest !== undefined && (task.modelDigest ?? task.configuredModelDigest) !== configuredDigest) {
      return { code: 'ORGANIZE_MODEL_CHANGED', message: '整理任务的模型配置不匹配，请用当前配置开始新任务。', status: 409 } as const;
    }
    return null;
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
      requireThat(this.freshness(projectId, task.input) === 'current', 'ORGANIZE_SOURCE_STALE', '原卡已更改或删除，请重新打开任务', 409);
      this.expire(task);
      requireThat(canRetryOrganize(task),
        'ORGANIZE_NOT_RETRYABLE', '当前任务不能重试', 409);
      const block = this.retryBlock(task);
      if (block) throw new DomainError(block.code, block.message, block.status);
      if (task.mode === 'real' && !task.verification) this.requireSendDisclosure(request.disclosureId);
      task.attempt += 1;
      task.state = 'running';
      task.error = null;
      task.usage = null;
      task.updatedAt = new Date().toISOString();
      task.deadline = Date.now() + ATTEMPT_TIMEOUT_MS;
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
    return this.cancelAttempt(projectId, id, attempt, actor);
  }

  private cancelAttempt(projectId: string, id: string, attempt: number, actor: Principal) {
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

  takeCandidate(projectId: string, id: string, attempt: number, copyWhileCut?: true, outputAttempt?: number):
    Pick<Card, 'id' | 'title' | 'aiOrigin' | 'verificationOrigin'> & { text: string } {
    const task = this.store.get(projectId, id);
    const candidate = task.output?.candidate;
    requireThat(candidate && task.attempt === attempt
      && this.candidateState(projectId, task) === (copyWhileCut ? 'copy' : 'add'),
      'ORGANIZE_RESULT_UNAVAILABLE', '结果已添加、已有候选可恢复、结果已更新或尚不可添加，请重新审阅', 409);
    requireThat(this.freshness(projectId, task.input) === 'current',
      'ORGANIZE_SOURCE_STALE', '原卡已更改或删除，请重新打开任务', 409);
    const evidence = task.output?.verification?.evidence;
    if (task.verification) {
      requireThat(task.outputAttempt === (outputAttempt ?? attempt), 'ORGANIZE_RESULT_UNAVAILABLE',
        '请确认要添加哪一次查证的结果', 409);
      requireThat(evidence?.status === 'accessed', 'ORGANIZE_RESULT_UNAVAILABLE', '查证原文不可回查', 409);
      const asset = readAsset(this.db, projectId, evidence.receipt.assetId);
      requireThat(asset.hash === evidence.receipt.hash, 'ORGANIZE_RESULT_UNAVAILABLE', '查证原文与回执不一致', 409);
    }
    if (copyWhileCut) task.cutCandidateIds = [...(task.cutCandidateIds ?? []), task.candidateId];
    if (task.applied) task.candidateId = randomUUID();
    task.applied = true;
    task.updatedAt = new Date().toISOString();
    this.store.save(projectId, task);
    return { id: task.candidateId, ...candidate, ...(evidence?.status === 'accessed'
      ? { verificationOrigin: { assetId: evidence.receipt.assetId, hash: evidence.receipt.hash, ...(evidence.receipt.fixture ? { fixture: true } : {}) } }
      : { aiOrigin: { taskId: task.id, mode: task.mode } }) };
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

  private launch(projectId: string, task: StoredTask, verifiedDigest: string | null = null) {
    void this.run(projectId, task, verifiedDigest).catch(() => {
      console.error('整理结果未保存；任务超时后可重试');
    });
  }

  private async run(projectId: string, source: StoredTask, verifiedDigest: string | null) {
    const abort = new AbortController();
    this.pending.set(source.id, { abort, projectId, task: source });
    let output: OrganizeOutput | null = null;
    let usage: OrganizeUsage | null = null;
    let error: string | null = null;
    let asset: MediaAsset | undefined;
    try {
      if (source.verification) {
        ({ output, asset } = await verifyPublicFacts(source.verification, this.verificationSource, abort.signal));
      } else if (source.mode === 'simulate') {
        const { title, blocks } = source.input;
        const content = [title, ...blocks.map(block => block.text)].filter(Boolean).join('\n\n').trim();
        output = {
          candidate: {
            title: `模拟整理：${title?.trim().slice(0, 200) || '所选正文'}`,
            text: content.slice(0, 16_000),
          },
          gaps: content.length > 16_000 ? ['模拟结果达到文字上限，后续文字未显示'] : [],
        };
      } else {
        const model = this.model!;
        const modelDigest = verifiedDigest ?? await model.resolveDigest(abort.signal);
        abort.signal.throwIfAborted();
        const pinned = source.modelDigest ?? outputDigest(source) ?? source.configuredModelDigest;
        requireThat(pinned ? pinned === modelDigest : !hasOrganizeOutput(source.output), 'ORGANIZE_MODEL_CHANGED',
          '整理模型已更新，请用当前配置开始新任务', 409);
        if (!source.modelDigest) {
          this.db.transaction(() => {
            const task = this.store.get(projectId, source.id);
            if (model.reuseAcrossRequests !== false) {
              const { cardId, thoughtVersionId, bodyVersionId, title, blocks } = source.input;
              const request = selectionKey({
                mode: source.mode, cardId, thoughtVersionId, bodyVersionId,
                includeTitle: title !== null, blockIds: blocks.map(block => block.id),
              });
              const existing = this.reusableModelTask(projectId, request, model.model, modelDigest);
              requireThat(!existing || existing.id === task.id, 'ORGANIZE_SCOPE_EXISTS',
                '当前模型和选中范围已有整理记录，请在记录中查看', 409);
              this.store.setScope(projectId, task.id, canonical({ request, model: model.model, digest: modelDigest }));
            }
            task.modelDigest = modelDigest;
            delete task.configuredModelDigest;
            this.store.save(projectId, task);
          }).immediate();
        }
        ({ result: output, usage } = await model.generate(
          { taskId: source.id, attempt: source.attempt, input: source.input, modelDigest }, abort.signal, observed => {
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
      error = source.verification ? '查证未完成，请重试' : modelError(cause);
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
        const verification = output?.verification;
        if (asset && verification?.evidence.status === 'accessed') {
          try {
            verifyAssetBytes(asset);
            const existing = this.db.prepare('SELECT 1 FROM mapping_assets WHERE project_id=? AND id=?').get(projectId, asset.id);
            if (existing) {
              const retained = readAsset(this.db, projectId, asset.id);
              requireThat(retained.kind === asset.kind && retained.mime === asset.mime && retained.hash === asset.hash &&
                Buffer.from(retained.base64, 'base64').equals(Buffer.from(asset.base64, 'base64')), 'ASSET_CORRUPT', '同一身份的已保存原文与本次查证不一致');
            } else writeAssetRow(this.db, projectId, asset);
          } catch (cause) {
            if (!(cause instanceof DomainError)) throw cause;
            const { url, hash, retrievedAt } = verification.evidence.receipt;
            output = { candidate: null, gaps: [], verification: {
              ...verification, coverage: 'insufficient', records: [], matchedRecords: 0,
              evidence: { status: 'not_retained', url, hash, retrievedAt, reason: cause.message },
            } };
          }
        }
        if (output && (output.candidate || !task.output?.candidate)) {
          task.output = output;
          task.outputAttempt = source.attempt;
        }
        if (!hasOrganizeOutput(task.output)) {
          task.output = null;
          task.outputAttempt = null;
        }
        const evidence = output?.verification?.evidence;
        const attemptState = output?.candidate && !output.gaps.length ? 'succeeded'
          : evidence?.status === 'accessed' || evidence?.status === 'not_retained' ||
            (!source.verification && task.output) ? 'partial' : 'failed';
        const state = source.verification && task.output?.candidate && attemptState === 'failed' ? 'partial' : attemptState;
        this.finishAttempt(task, state, usage, output, error);
        if (state !== attemptState) attempt.state = attemptState;
      }
      this.store.save(projectId, task);
    }).immediate();
  }

  close() {
    this.closed = true;
    for (const { abort } of this.starting.values()) abort.abort();
    this.starting.clear();
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

function outputDigest(task: StoredTask): string | undefined {
  if (!hasOrganizeOutput(task.output)) return undefined;
  return task.attempts.find(attempt => attempt.number === task.outputAttempt)?.usage?.modelDigest?.toLowerCase();
}

function hasOrganizeOutput(output: OrganizeOutput | null): boolean {
  return Boolean(output?.candidate || output?.gaps.length || output?.verification);
}

function selectionKey(selection: Omit<OrganizeRequest, 'requestId' | 'disclosureId'>): string {
  return canonical({ ...selection, blockIds: [...selection.blockIds].sort() });
}

function modelError(cause: unknown): string {
  return cause instanceof DomainError ? cause.message : '整理未完成，请稍后重试';
}
