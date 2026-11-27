import { expect, it, vi } from 'vitest';
import { terminalProtocol } from '../src/agent-chat/terminal-protocol.js';

const threadId = 'bba243c1-12ba-4ed1-98c5-856d14629c3e';
const luna = { model: 'gpt-6-luna', hidden: false };

function session() {
  const api = {
    initialize: vi.fn(async () => ({ userAgent: 'fixture' })),
    query: vi.fn<(method: string, params: object) => Promise<unknown>>(async () => ({})),
    resume: vi.fn(async () => ({ thread: { id: threadId } })),
    turn: vi.fn(async () => ({ turn: { id: 'turn-1' } })),
    interrupt: vi.fn(async () => ({})),
  };
  const dispatch = terminalProtocol(threadId, api);
  const notify = vi.fn();
  const signal = new AbortController().signal;
  return { api, notify, signal, call: (method: string, params?: unknown) => dispatch(method, params, notify, signal) };
}

it('为终端引导提供 Luna 和最少账户信息，忽略刷新令牌和配置路径请求', async () => {
  const { api, call } = session();
  api.query
    .mockResolvedValueOnce({ account: { type: 'chatgpt', planType: 'plus', email: 'private@example.test', workspaceName: 'private' },
      requiresOpenaiAuth: true, userId: 'private', workspaceRouting: 'private' })
    .mockResolvedValueOnce({ data: [{ ...luna, hidden: true }, { model: 'another-model', hidden: false }], nextCursor: 'next' })
    .mockResolvedValueOnce({ data: [{ ...luna, id: 'native-id', displayName: 'Luna', description: '', isDefault: false,
      upgrade: 'another-model', defaultReasoningEffort: 'medium', supportedReasoningEfforts: [], inputModalities: ['text', 'image'] }], nextCursor: null });

  await expect(call('initialize', { clientInfo: { name: 'fixture' } })).resolves.toEqual({ userAgent: 'fixture' });
  await expect(call('initialized')).resolves.toEqual({});
  await expect(call('account/read', { refreshToken: true })).resolves.toEqual({
    account: { type: 'chatgpt', email: null, workspaceName: null, planType: 'plus' },
    userId: null, workspaceRouting: null, requiresOpenaiAuth: true,
  });
  await expect(call('model/list', { modelProvider: 'another-provider', cursor: 'arbitrary', includeHidden: true })).resolves.toEqual({
    data: [{ ...luna, id: 'gpt-6-luna', displayName: 'Luna', description: '', isDefault: true, supportsPersonality: false,
      defaultReasoningEffort: 'medium', supportedReasoningEfforts: [], inputModalities: ['text'], upgrade: null, upgradeInfo: null,
      availabilityNux: null, modelSpecialty: null, multiAgentVersion: null, additionalSpeedTiers: [], serviceTiers: [],
      defaultServiceTier: null, availableAccessPrograms: null }], nextCursor: null,
  });
  await expect(call('config/read', { cwd: '/private', includeLayers: true })).resolves.toEqual({ config: { model: 'gpt-6-luna' }, origins: {}, layers: null });
  await expect(call('configRequirements/read')).resolves.toEqual({ requirements: null });
  await expect(call('collaborationMode/list', {})).resolves.toEqual({ data: [] });
  expect(api.query.mock.calls).toEqual([
    ['account/read', { refreshToken: false }],
    ['model/list', { cursor: null, limit: 100, includeHidden: false }],
    ['model/list', { cursor: 'next', limit: 100, includeHidden: false }],
  ]);
});

it('保留未登录状态，只有隐藏或其他模型时返回空列表', async () => {
  const { api, call } = session();
  api.query.mockResolvedValueOnce({ account: null, requiresOpenaiAuth: true })
    .mockResolvedValueOnce({ data: [{ ...luna, hidden: true }, { model: 'another', hidden: false }], nextCursor: null });
  await expect(call('account/read')).resolves.toEqual({ account: null, userId: null, workspaceRouting: null, requiresOpenaiAuth: true });
  await expect(call('model/list')).resolves.toEqual({ data: [], nextCursor: null });
});

it('通过会话绑定读取分页记录，解析纯文本、回合设置和中断 ID', async () => {
  const { api, call, notify, signal } = session();
  await expect(call('turn/start', { threadId, input: [{ type: 'text', text: '合成问题' }] })).rejects.toMatchObject({ code: 'CODEX_TERMINAL_RESUME_REQUIRED' });

  await call('thread/read', { threadId, includeTurns: false, path: '/another-thread' });
  await call('thread/turns/list', { threadId, limit: 12, cursor: 'next', sortDirection: 'desc', itemsView: 'notLoaded', cwd: '/another' });
  await call('thread/items/list', { threadId, turnId: 'turn-1', limit: 24, cursor: null, sortDirection: 'desc', deferOutput: null });
  expect(api.query.mock.calls).toEqual([
    ['thread/read', { threadId, includeTurns: false }],
    ['thread/turns/list', { threadId, limit: 12, cursor: 'next', sortDirection: 'desc', itemsView: 'notLoaded' }],
    ['thread/items/list', { threadId, turnId: 'turn-1', limit: 24, cursor: null, sortDirection: 'desc' }],
  ]);
  await call('thread/resume', { threadId, model: 'gpt-6-luna', cwd: '/terminal', config: { model_reasoning_effort: 'medium' },
    history: [], path: '', developerInstructions: null, excludeTurns: true });
  expect(api.resume).toHaveBeenCalledExactlyOnceWith();

  await expect(call('turn/start', {
    threadId, input: [{ type: 'text', text: ' 合成问题 ', text_elements: [] }], clientUserMessageId: 'msg-7', turnTrigger: 'user',
    model: 'gpt-6-luna', cwd: '/terminal', sandboxPolicy: { type: 'dangerFullAccess' },
    collaborationMode: { mode: 'default', settings: { model: 'gpt-6-luna', reasoning_effort: 'medium', developer_instructions: null } },
  })).resolves.toEqual({ turn: { id: 'turn-1' } });
  expect(api.turn).toHaveBeenCalledExactlyOnceWith(' 合成问题 ', 'msg-7',
    { sandboxPolicy: { type: 'dangerFullAccess' }, effort: 'medium' }, notify, signal);
  await call('turn/interrupt', { threadId, turnId: 'turn-1' });
  expect(api.interrupt).toHaveBeenCalledExactlyOnceWith('turn-1');
});

it('拒绝越域、历史注入、备用模型和带内容的工具请求', async () => {
  const { api, call } = session();
  for (const method of ['thread/read', 'thread/turns/list', 'thread/items/list', 'thread/resume', 'turn/start', 'turn/interrupt']) {
    await expect(call(method, { threadId: 'other-thread' })).rejects.toMatchObject({ code: 'CODEX_TERMINAL_THREAD' });
  }
  for (const injection of [{ path: '/private' }, { history: [{ type: 'message' }] }, { developerInstructions: 'private' },
    { baseInstructions: 'private' }, { config: { model: 'private' } }, { sandbox: 'read-only' },
    { permissions: 'read-only' }, { approvalPolicy: 'untrusted' }, { approvalsReviewer: 'auto_review' }]) {
    await expect(call('thread/resume', { threadId, ...injection })).rejects.toMatchObject({ code: 'CODEX_TERMINAL_PARAMS' });
  }
  expect(api.resume).not.toHaveBeenCalled();
  api.resume.mockRejectedValueOnce(new Error('fixture resume failed'));
  await expect(call('thread/resume', { threadId })).rejects.toThrow('fixture resume failed');
  await expect(call('turn/start', { threadId })).rejects.toMatchObject({ code: 'CODEX_TERMINAL_RESUME_REQUIRED' });
  await call('thread/resume', { threadId });

  const input = [{ type: 'text', text: '合成问题' }];
  for (const invalid of [{ input: [{ type: 'localImage', path: '/private' }] }, { input: [...input, ...input] },
    { input: [{ ...input[0], text_elements: [{ byteRange: { start: 0, end: 1 } }] }] },
    { input: [{ ...input[0], textElements: [{ byteRange: { start: 0, end: 1 } }] }] },
    { input: [{ ...input[0], path: '/private' }] }, { toolOutput: { text: 'private' } },
    { additionalContext: { private: 'private' } }, { attachments: ['/private'] }, { clientUserMessageId: '../private' }]) {
    await expect(call('turn/start', { threadId, input, ...invalid })).rejects.toMatchObject({ code: 'CODEX_TERMINAL_PARAMS' });
  }
  for (const invalid of [{ model: 'another-model' }, { collaborationMode: { settings: { model: 'another-model' } } }]) {
    await expect(call('turn/start', { threadId, input, ...invalid })).rejects.toMatchObject({ code: 'CODEX_MODEL_MISMATCH' });
  }
  await expect(call('thread/read', { threadId, includeTurns: 'true' })).rejects.toMatchObject({ code: 'CODEX_TERMINAL_PARAMS' });
  await expect(call('thread/turns/list', { threadId, limit: 10_000 })).rejects.toMatchObject({ code: 'CODEX_TERMINAL_PARAMS' });
  await expect(call('config/value/write', { private: 'private' })).rejects.toMatchObject({
    code: 'CODEX_TERMINAL_METHOD', message: '此终端请求不受支持。', details: null,
  });
  await expect(call('config/value/write', [])).rejects.toMatchObject({ code: 'CODEX_TERMINAL_METHOD' });
  await expect(call('turn/start', [])).rejects.toMatchObject({ code: 'CODEX_TERMINAL_PARAMS' });
  expect(api.query).not.toHaveBeenCalled();
  expect(api.turn).not.toHaveBeenCalled();
  expect(api.interrupt).not.toHaveBeenCalled();
});
