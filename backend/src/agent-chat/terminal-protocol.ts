import { z } from 'zod';
import { DomainError, requireThat } from '../domain/errors.js';
import { codexChatModel } from './codex.js';

type Notify = (method: string, params: unknown) => void;
type TerminalApi = {
  initialize(): Promise<unknown>;
  query(method: string, params: object): Promise<unknown>;
  resume(): Promise<unknown>;
  turn(text: string, clientUserMessageId: string | undefined, notify: Notify): Promise<unknown>;
  interrupt(turnId: string): Promise<unknown>;
};

const record = z.record(z.string(), z.unknown());
const identifier = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const noTextElements = z.array(z.never()).nullish();
const plainText = z.object({
  type: z.literal('text'),
  text: z.string().refine(text => text.trim().length > 0),
  text_elements: noTextElements,
  textElements: noTextElements,
}).strict();
const page = z.object({
  cursor: z.string().max(4096).nullish(),
  limit: z.number().int().min(1).max(200).nullish(),
  sortDirection: z.enum(['asc', 'desc']).nullish(),
  itemsView: z.enum(['notLoaded', 'summary', 'full']).nullish(),
  turnId: identifier.nullish(),
});
const modelCatalog = z.object({
  data: z.array(z.object({
    model: z.string(), hidden: z.boolean(), displayName: z.string().optional(), description: z.string().optional(),
    supportedReasoningEfforts: z.array(z.object({ reasoningEffort: z.string(), description: z.string() })).default([]),
    defaultReasoningEffort: z.string().default('medium'),
  })),
  nextCursor: z.string().nullish(),
});
const resumeMetadata = new Set(['threadId', 'model', 'cwd', 'runtimeWorkspaceRoots', 'excludeTurns', 'initialTurnsPage',
  'approvalPolicy', 'approvalsReviewer', 'sandbox', 'permissions', 'serviceTier', 'personality', 'config']);
const resumeConfig = z.object({ model_reasoning_effort: z.string().regex(/^[a-z]{1,16}$/).optional() }).strict();
const turnMetadata = new Set(['threadId', 'input', 'clientUserMessageId', 'turnTrigger', 'model', 'cwd', 'runtimeWorkspaceRoots',
  'approvalPolicy', 'approvalsReviewer', 'sandboxPolicy', 'permissions', 'serviceTier', 'serviceTierForTurn', 'effort', 'summary', 'personality', 'collaborationMode']);

function empty(value: unknown): boolean {
  if (value == null || value === '') return true;
  if (Array.isArray(value)) return value.length === 0;
  return typeof value === 'object' && Object.keys(value).length === 0;
}

function invalidParams(): never {
  throw new DomainError('CODEX_TERMINAL_PARAMS', '终端请求的参数不受支持。', 400);
}

function paramsObject(params: unknown) {
  const parsed = record.safeParse(params ?? {});
  if (!parsed.success) invalidParams();
  return parsed.data;
}

function requireLuna(model: unknown) {
  requireThat(model == null || model === codexChatModel, 'CODEX_MODEL_MISMATCH', '此终端仅支持 gpt-6-luna。', 400);
}

export function terminalProtocol(threadId: string, api: TerminalApi): (method: string, params: unknown, notify: Notify) => Promise<unknown> {
  let resumed = false;
  const requireThread = (value: unknown) => {
    requireThat(value === threadId, 'CODEX_TERMINAL_THREAD', '此终端仅可访问绑定的原生会话。', 403);
  };
  return async (method, rawParams, notify) => {
    const params = paramsObject(rawParams);
    switch (method) {
      case 'initialize': return api.initialize();
      case 'initialized': return {};
      case 'account/read': {
        const result = paramsObject(await api.query(method, { refreshToken: false }));
        const account = paramsObject(result.account);
        const type = account.type;
        const safeAccount = type === 'chatgpt' ? {
          type, email: null, workspaceName: null, planType: typeof account.planType === 'string' ? account.planType : 'unknown',
        } : type === 'amazonBedrock' ? {
          type, usesCodexManagedCredentials: false,
        } : type === 'apiKey' || type === 'gcp' ? { type } : null;
        return { account: safeAccount, userId: null, workspaceRouting: null, requiresOpenaiAuth: result.requiresOpenaiAuth !== false };
      }
      case 'model/list': {
        let cursor: string | null = null;
        do {
          const result = modelCatalog.safeParse(await api.query(method, { cursor, limit: 100, includeHidden: false }));
          if (!result.success) throw new DomainError('CODEX_MODEL_UNAVAILABLE', '无法读取本机 Codex 模型列表。', 503);
          const model = result.data.data.find(model => model.model === codexChatModel && !model.hidden);
          if (model) return { data: [{
            id: codexChatModel, model: codexChatModel, displayName: model.displayName ?? codexChatModel, description: model.description ?? '', hidden: false,
            inputModalities: ['text'], supportedReasoningEfforts: model.supportedReasoningEfforts,
            defaultReasoningEffort: model.defaultReasoningEffort, isDefault: true, supportsPersonality: false,
            upgrade: null, upgradeInfo: null, availabilityNux: null, modelSpecialty: null, multiAgentVersion: null,
            additionalSpeedTiers: [], serviceTiers: [], defaultServiceTier: null, availableAccessPrograms: null,
          }], nextCursor: null };
          cursor = result.data.nextCursor ?? null;
        } while (cursor);
        return { data: [], nextCursor: null };
      }
      case 'config/read':
        // Advertise the handoff's model. Never read or expose local config layers.
        return { config: { model: codexChatModel }, origins: {}, layers: null };
      case 'configRequirements/read': return { requirements: null };
      case 'collaborationMode/list': return { data: [] };
      case 'experimentalFeature/list': return { data: [], nextCursor: null };
      case 'skills/list': return { data: [] };
      case 'thread/read': {
        requireThread(params.threadId);
        if (params.includeTurns != null && typeof params.includeTurns !== 'boolean') invalidParams();
        return api.query(method, { threadId, includeTurns: params.includeTurns === true });
      }
      case 'thread/turns/list':
      case 'thread/items/list': {
        requireThread(params.threadId);
        const pagination = page.safeParse(params);
        if (!pagination.success) invalidParams();
        const { cursor, limit, sortDirection, itemsView, turnId } = pagination.data;
        return api.query(method, method === 'thread/turns/list' ? { threadId, cursor, limit, sortDirection, itemsView }
          : { threadId, cursor, limit, sortDirection, turnId });
      }
      case 'thread/goal/get':
        requireThread(params.threadId);
        return { goal: null };
      case 'thread/resume': {
        requireThread(params.threadId);
        requireLuna(params.model);
        if (Object.entries(params).some(([key, value]) => !resumeMetadata.has(key) && !empty(value))) invalidParams();
        if (!resumeConfig.safeParse(params.config ?? {}).success) invalidParams();
        const result = await api.resume();
        resumed = true;
        return result;
      }
      case 'turn/start': {
        requireThread(params.threadId);
        requireThat(resumed, 'CODEX_TERMINAL_RESUME_REQUIRED', '请先恢复绑定的原生会话。', 409);
        requireLuna(params.model);
        if (Object.entries(params).some(([key, value]) => !turnMetadata.has(key) && !empty(value))) invalidParams();
        if (params.turnTrigger != null && params.turnTrigger !== 'user') invalidParams();
        if (params.collaborationMode != null) {
          const mode = paramsObject(params.collaborationMode);
          const settings = paramsObject(mode.settings);
          requireLuna(settings.model);
          if (!empty(settings.developerInstructions) || !empty(settings.developer_instructions)) invalidParams();
        }
        const input = z.tuple([plainText]).safeParse(params.input);
        const clientId = identifier.nullish().safeParse(params.clientUserMessageId);
        if (!input.success || !clientId.success) invalidParams();
        return api.turn(input.data[0].text, clientId.data ?? undefined, notify);
      }
      case 'turn/interrupt': {
        requireThread(params.threadId);
        requireThat(resumed, 'CODEX_TERMINAL_RESUME_REQUIRED', '请先恢复绑定的原生会话。', 409);
        const turnId = identifier.safeParse(params.turnId);
        if (!turnId.success) invalidParams();
        return api.interrupt(turnId.data);
      }
      default: throw new DomainError('CODEX_TERMINAL_METHOD', '此终端请求不受支持。', 400);
    }
  };
}
