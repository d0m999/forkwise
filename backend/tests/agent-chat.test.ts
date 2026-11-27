import { once } from 'node:events';
import fs, { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { AgentChat, openAgentChatDirectory } from '../src/agent-chat/chat.js';
import { createWorkspaceApp } from '../src/mapping/http.js';
import { openMapping } from '../src/mapping/storage.js';

const origin = 'http://127.0.0.1:18923';
const endpoint = origin + '/api/agent-chat';
const model = 'gpt-6-luna';
const nativeDefaultModel = 'codex-fixture-model';
const nativeDefault = { model: nativeDefaultModel, hidden: false, isDefault: true };
const availableModels = [
  nativeDefault,
  { model, hidden: false, isDefault: false },
];
type FixtureModel = { model: string; hidden: boolean; isDefault?: boolean };
let root: string;
let directory: string;
let nativeHome: string;
let nativeAccount: string;
let modelSettings: string;
let nativeRequests: string;
let rerouteSignal: string;
let resultSignal: string;
let chats: AgentChat | undefined;
let mapping: ReturnType<typeof openMapping> | undefined;

function setFixtureModels(models: FixtureModel[], behavior: {
  nextModelPage?: FixtureModel[];
  modelListError?: boolean;
  openedModel?: string;
  reroutedModel?: string;
  completedModel?: string;
  interruptOutcome?: 'interrupted' | 'completed' | 'unconfirmed' | 'interruptError' | 'noReply' | 'interruptedOnClose';
  holdClose?: boolean;
  omitRecordedTurn?: boolean;
  terminalSettings?: 'onResume' | 'onClose' | 'changed' | 'unknown';
  failModelAfterResume?: boolean;
  holdTurn?: boolean;
} = {}) {
  writeFileSync(modelSettings, JSON.stringify({ models, ...behavior }), { mode: 0o600 });
}

beforeEach(() => {
  root = mkdtempSync(join(realpathSync(tmpdir()), 'forkwise-agent-chat-'));
  const workspace = join(root, 'workspace');
  mapping = openMapping(workspace);
  directory = openAgentChatDirectory(workspace);
  nativeHome = join(root, 'codex');
  nativeAccount = join(nativeHome, 'native-account.json');
  modelSettings = join(nativeHome, 'fixture-models.json');
  nativeRequests = join(nativeHome, 'fixture-requests');
  rerouteSignal = join(nativeHome, 'fixture-reroute');
  resultSignal = join(nativeHome, 'fixture-result');
  mkdirSync(nativeHome, { mode: 0o700 });
  writeFileSync(nativeAccount, JSON.stringify({ expiresAt: Date.now() + 60_000 }), { mode: 0o600 });
  setFixtureModels(availableModels);
  const executable = join(root, 'codex-test.mjs');
  writeFileSync(executable, `#!${process.execPath}
import assert from 'node:assert/strict';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
assert.deepEqual(process.argv.slice(2), [
  'app-server', '--listen', 'stdio://', '-c', 'agents.enabled=false', '-c', 'features.multi_agent_v2=false',
]);
assert.equal(process.env.CODEX_HOME, ${JSON.stringify(nativeHome)});
assert.equal(process.env.ACCESS_TOKEN, undefined);
assert.equal(process.env.OPENAI_API_KEY, undefined);
const accountPath = join(process.env.CODEX_HOME, 'native-account.json');
const model = ${JSON.stringify(model)};
const { models, nextModelPage, modelListError, openedModel, reroutedModel, completedModel, interruptOutcome, holdClose, omitRecordedTurn,
  terminalSettings, failModelAfterResume, holdTurn } = JSON.parse(readFileSync(${JSON.stringify(modelSettings)}, 'utf8'));
const nativeDefault = models.find(candidate => candidate.isDefault)?.model;
const print = event => process.stdout.write(JSON.stringify(event) + '\\n');
const load = id => JSON.parse(readFileSync(join(process.cwd(), id + '.json'), 'utf8'));
const eventLine = (timestamp, payload) => JSON.stringify({timestamp, type: 'event_msg', payload}) + '\\n';
const settings = (threadId, approvalPolicy = 'never') => ({ type: 'thread_settings_applied', thread_id: threadId,
  thread_settings: { model, approval_policy: approvalPolicy } });
const flushSettings = (thread, change) => appendFileSync(thread.path, eventLine('2026-11-27T08:01:00.111222333Z',
  change === 'unknown' ? { type: 'fixture_unknown_context', text: '未核验材料占位' }
    : settings(thread.id, change === 'changed' ? 'on-request' : 'never')));
async function waitForSignal(path) {
  while (!existsSync(path)) await new Promise(resolve => setTimeout(resolve, 10));
}
let authenticated = false;
let reroutedTurn;
let verifyingResult = false;
let resumedForTerminal;
for await (const line of createInterface({input: process.stdin})) {
  const {id, method, params} = JSON.parse(line);
  if (method) appendFileSync(${JSON.stringify(nativeRequests)}, method + '\\n', { mode: 0o600 });
  const respond = result => print({id, result});
  if (method === 'initialize') {
    writeFileSync(join(process.env.CODEX_HOME, 'started'), '');
    respond({});
  } else if (method === 'account/read') {
    assert.deepEqual(params, { refreshToken: false });
    authenticated = existsSync(accountPath) &&
      JSON.parse(readFileSync(accountPath, 'utf8')).expiresAt > Date.now();
    respond({ account: authenticated ? { type: 'chatgpt', email: 'fixture@example.com', planType: 'plus' } : null });
  } else if (method === 'model/list') {
    assert.equal(authenticated, true);
    if (modelListError || (failModelAfterResume && resumedForTerminal))
      print({ id, error: { code: -32603, message: 'model list unavailable' } });
    else respond(params.cursor === 'next-models'
      ? { data: nextModelPage, nextCursor: null }
      : { data: models, nextCursor: nextModelPage ? 'next-models' : null });
  } else if (method === 'thread/start') {
    assert.equal(authenticated, true);
    const { model: requested, ...openParams } = params;
    assert.equal(requested, model);
    assert.deepEqual(openParams, { cwd: process.cwd() });
    const id = randomUUID();
    respond({thread: {id, path: null, turns: [], status: {type: 'idle'}}, model: openedModel ?? requested ?? nativeDefault});
  } else if (method === 'thread/resume') {
    assert.equal(authenticated, true);
    const { model: requested, excludeTurns, ...openParams } = params;
    assert.equal(requested, model);
    assert.ok(excludeTurns === undefined || excludeTurns === true);
    assert.deepEqual(openParams, { threadId: params.threadId, cwd: process.cwd() });
    const thread = load(params.threadId);
    if (!excludeTurns) {
      resumedForTerminal = thread;
      if (terminalSettings && terminalSettings !== 'onClose') flushSettings(thread, terminalSettings);
    }
    respond({thread: {...thread, preview: thread.turns.at(-1)?.items[0]?.content?.[0]?.text ?? ''},
      model: openedModel ?? requested ?? nativeDefault});
  } else if (method === 'thread/read') {
    if (verifyingResult) await waitForSignal(${JSON.stringify(resultSignal)});
    respond({thread: load(params.threadId)});
  } else if (method === 'thread/turns/list') {
    respond({ data: load(params.threadId).turns, nextCursor: null });
  } else if (method === 'thread/items/list') {
    const turns = load(params.threadId).turns.filter(turn => !params.turnId || turn.id === params.turnId);
    respond({ data: turns.flatMap(turn => turn.items.map(item => ({ ...item, turnId: turn.id }))), nextCursor: null });
  } else if (method === 'turn/start') {
    assert.equal(params.model, model);
    const { clientUserMessageId, ...turnParams } = params;
    if (clientUserMessageId !== undefined) assert.equal(typeof clientUserMessageId, 'string');
    assert.deepEqual(Object.keys(turnParams).sort(), ['input', 'model', 'threadId']);
    assert.equal(turnParams.input.length, 1);
    assert.equal(turnParams.input[0].type, 'text');
    const threadId = params.threadId;
    const path = join(process.cwd(), threadId + '.json');
    let turns = [];
    try { turns = load(threadId).turns; } catch {}
    const turnId = randomUUID();
    const itemId = randomUUID();
    const answer = reroutedModel || completedModel ? '错误模型的合成回答' : '合成回答';
    const status = reroutedModel && interruptOutcome !== 'completed' ? 'interrupted' : 'completed';
    const turn = {id: turnId, status, items: [
      {id: randomUUID(), type: 'userMessage', content: params.input},
      {id: itemId, type: 'agentMessage', text: answer}
    ]};
    const delta = {method: 'item/agentMessage/delta', params: {threadId, itemId, delta: answer}};
    const saveTurn = () => {
      if (!omitRecordedTurn) turns.push(turn);
      else if (existsSync(path)) return;
      const jsonl = path + 'l';
      const recording = terminalSettings || existsSync(jsonl) ? jsonl : path;
      if (recording === jsonl) {
        if (!existsSync(recording)) writeFileSync(recording, eventLine('2026-11-27T08:00:00.111222333Z', settings(threadId)), {mode: 0o600});
        appendFileSync(recording, eventLine('2026-11-27T08:00:01.111222333Z', { type: 'task_complete', turn_id: turn.id }));
      }
      writeFileSync(path, JSON.stringify({id: threadId, path: recording, turns, status: {type: 'idle'}, model: completedModel ?? model}), {mode: 0o600});
    };
    const complete = () => {
      print(delta);
      saveTurn();
      verifyingResult = !!completedModel;
      print({method: 'turn/completed', params: {threadId, turn}});
    };
    respond({turn: {id: turnId, status: 'inProgress'}});
    if (reroutedModel) {
      reroutedTurn = {threadId, turn};
      const waitForTest = setInterval(() => {
        if (!existsSync(${JSON.stringify(rerouteSignal)})) return;
        clearInterval(waitForTest);
        saveTurn();
        print({method: 'model/rerouted', params: {threadId, turnId, fromModel: model, toModel: reroutedModel, reason: 'highRiskCyberActivity'}});
        print(delta);
        print({method: 'item/completed', params: {threadId, turnId, item: turn.items[1]}});
      }, 10);
      waitForTest.unref();
    } else if (holdTurn) {
      const waitForTest = setInterval(() => {
        if (!existsSync(${JSON.stringify(resultSignal)})) return;
        clearInterval(waitForTest);
        complete();
      }, 10);
      waitForTest.unref();
    } else complete();
  } else if (method === 'turn/interrupt') {
    assert.ok(reroutedTurn);
    const {threadId, turn} = reroutedTurn;
    assert.deepEqual(params, {threadId, turnId: turn.id});
    if (interruptOutcome === 'noReply' || interruptOutcome === 'interruptedOnClose') continue;
    if (interruptOutcome === 'interruptError' || interruptOutcome === 'completed') print({ id, error: { code: -32603, message: 'turn already completed' } });
    else respond({});
    if (interruptOutcome === 'interruptError') continue;
    if (interruptOutcome) await waitForSignal(${JSON.stringify(resultSignal)});
    if (interruptOutcome === 'unconfirmed') process.exit(0);
    print({method: 'turn/completed', params: {threadId, turn}});
  }
}
if (resumedForTerminal && terminalSettings === 'onClose') flushSettings(resumedForTerminal, terminalSettings);
if (verifyingResult || reroutedTurn) {
  if (interruptOutcome === 'interruptedOnClose') print({method: 'turn/completed', params: reroutedTurn});
  writeFileSync(join(process.env.CODEX_HOME, 'writer-closing'), String(process.pid));
  if (holdClose) await waitForSignal(join(process.env.CODEX_HOME, 'release-writer'));
}
`, { mode: 0o700 });
  vi.stubEnv('FORKWISE_CODEX_BINARY', executable);
  vi.stubEnv('CODEX_HOME', nativeHome);
  vi.stubEnv('ACCESS_TOKEN', 'fixture-token');
  vi.stubEnv('OPENAI_API_KEY', 'fixture-api-key');
});

afterEach(async () => {
  await chats?.close();
  chats = undefined;
  mapping?.close();
  mapping = undefined;
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

function terminalWorkspacePost(chat: AgentChat) {
  const app = createWorkspaceApp(mapping!, origin, () => new Response(''), chat);
  const human = mapping!.access.issue('human', ['*']);
  const headers = { Origin: origin, Authorization: 'Bearer ' + human, 'Content-Type': 'application/json' };
  return (path: string, body: object = {}) => app.request(endpoint + '/conversations' + path, {
    method: 'POST', headers, body: JSON.stringify(body),
  });
}

async function startTerminalConversation() {
  const chat = chats = new AgentChat(directory, 'test');
  const post = terminalWorkspacePost(chat);
  const created = await post('');
  expect(created.status).toBe(201);
  const { id } = await created.json() as { id: string };
  const first = await post(`/${id}/turns`, { text: '见岔首轮合成问题' });
  expect(first.status).toBe(202);
  const initial = await first.json() as { threadId: string; model: string };
  expect(initial).toMatchObject({ threadId: expect.any(String), model });
  await expect.poll(async () => (await chat.get(id)).busy).toBe(false);
  return { chat, id, threadId: initial.threadId, post };
}

type TerminalFrame = { id?: number; result?: unknown; error?: unknown; method?: string; params?: unknown };

async function connectTerminal(response: Response, threadId: string) {
  expect(response.status).toBe(201);
  const { command } = await response.json() as { command: string };
  const socketPath = /^codex --remote 'unix:\/\/([^']+)' resume --model gpt-6-luna '[^']+'$/.exec(command)?.[1];
  expect(command).toContain(`'${threadId}'`);
  expect(socketPath).toBeDefined();
  expect(Buffer.byteLength(socketPath!)).toBeLessThan(104);
  const socketInfo = lstatSync(socketPath!);
  expect(socketInfo.isSocket()).toBe(true);
  expect(socketInfo.mode & 0o777).toBe(0o600);
  const socketDirectory = dirname(socketPath!);
  expect(lstatSync(socketDirectory).mode & 0o777).toBe(0o700);

  const socket = new WebSocket(`ws+unix:${socketPath}:/`, { handshakeTimeout: 3_000 });
  const frames: TerminalFrame[] = [];
  socket.on('message', raw => frames.push(JSON.parse(raw.toString()) as TerminalFrame));
  const disconnected = new Promise<void>(resolve => socket.once('close', () => resolve()));
  await once(socket, 'open');
  let sequence = 0;
  async function waitFor(predicate: (frame: TerminalFrame) => boolean) {
    await expect.poll(() => frames.find(predicate), { timeout: 3_000 }).toBeDefined();
    return frames.find(predicate)!;
  }
  async function request(method: string, params: object) {
    const id = ++sequence;
    socket.send(JSON.stringify({ id, method, params }));
    return waitFor(frame => frame.id === id);
  }
  async function close() {
    socket.close();
    await disconnected;
    await expect.poll(() => existsSync(socketDirectory)).toBe(false);
  }
  expect(await request('initialize', { clientInfo: { name: 'codex-tui', version: 'test' } })).toHaveProperty('result');
  socket.send(JSON.stringify({ method: 'initialized' }));
  return { request, waitFor, frames, close, disconnected };
}

it('从空会话发问，并在原生记录变化后只读回看，禁止未核验的发送', async () => {
  chats = new AgentChat(directory, 'test');
  const first = chats.create();
  expect(await chats.get(first.id)).toMatchObject({ threadId: null, busy: false, messages: [] });
  const started = await chats.send(first.id, '第一个合成问题');
  expect(started.threadId).toEqual(expect.any(String));
  const chat = chats;
  await expect.poll(async () => (await chat.get(first.id)).busy).toBe(false);
  const completed = await chats.get(first.id);
  expect(completed).toMatchObject({ threadId: started.threadId, model });
  expect(completed.messages.map(message => message.text)).toEqual(['第一个合成问题', '合成回答']);
  expect(completed.resumeCommand).toContain(started.threadId);
  expect(completed.resumeCommand).toMatch(/--model (?:'gpt-6-luna'|"gpt-6-luna"|gpt-6-luna)(?:\s|$)/);
  expect(completed.resumeCommand).toMatch(/-c (?:'agents\.enabled=false'|"agents\.enabled=false"|agents\.enabled=false)(?:\s|$)/);
  expect(completed.resumeCommand).toMatch(/-c (?:'features\.multi_agent_v2=false'|"features\.multi_agent_v2=false"|features\.multi_agent_v2=false)(?:\s|$)/);

  const path = join(directory, 'no-project', started.threadId + '.json');
  const native = JSON.parse(readFileSync(path, 'utf8'));
  native.turns.push({ id: 'terminal-turn', status: 'completed', items: [
    { id: 'terminal-user', type: 'userMessage', content: [{ type: 'text', text: '未核验材料占位' }] },
    { id: 'terminal-agent', type: 'agentMessage', text: '终端合成回答' },
  ] });
  writeFileSync(path, JSON.stringify(native));
  const returned = await chats.get(first.id);
  expect(returned.messages.map(message => message.text)).toEqual(['第一个合成问题', '合成回答', '未核验材料占位', '终端合成回答']);
  await expect(chats.send(first.id, '继续')).rejects.toMatchObject({ code: 'CODEX_HISTORY_UNVERIFIED' });
  expect(JSON.parse(readFileSync(path, 'utf8')).turns).toHaveLength(2);
  expect(await chats.get(chats.create().id)).toMatchObject({ threadId: null, messages: [] });
});

it('可见的合成问答一致时，仍拦截隐藏内容变化后的原生历史', async () => {
  const first = '第一条合成问题';
  const terminal = '终端合成问题';
  const third = '继续合成提问';
  // Launchers from the earlier acceptance build must not relax this boundary.
  vi.stubEnv('FORKWISE_CODEX_SYNTHETIC_ROUND_TRIP', JSON.stringify([first, terminal, third]));
  const chat = chats = new AgentChat(directory, 'test');
  const { id } = chat.create();
  const { threadId } = await chat.send(id, first);
  await expect.poll(async () => (await chat.get(id)).busy).toBe(false);
  const path = join(directory, 'no-project', threadId + '.json');
  const native = JSON.parse(readFileSync(path, 'utf8'));
  native.turns.push({ id: 'terminal-turn', status: 'completed', items: [
    { id: 'terminal-user', type: 'userMessage', content: [{ type: 'text', text: terminal }] },
    { id: 'terminal-agent', type: 'agentMessage', text: '终端合成回答' },
  ] });
  native.unprojectedContext = '可见消息投影以外的未验证合成占位材料';
  writeFileSync(path, JSON.stringify(native));
  expect((await chat.get(id)).messages.map(message => message.text))
    .toEqual([first, '合成回答', terminal, '终端合成回答']);
  await expect(chat.send(id, third)).rejects.toMatchObject({ code: 'CODEX_HISTORY_UNVERIFIED' });
  expect(JSON.parse(readFileSync(path, 'utf8')).turns).toHaveLength(2);
});

it('从工作台到受控终端再回到工作台，三轮保持同一原生会话和 Luna', async () => {
  const { chat, id, threadId, post } = await startTerminalConversation();
  const terminal = await connectTerminal(await post(`/${id}/terminal`), threadId);
  expect(await terminal.request('account/read', { refreshToken: true })).toMatchObject({
    result: { account: { type: 'chatgpt', email: null } },
  });
  expect(await terminal.request('model/list', { includeHidden: true })).toMatchObject({
    result: { data: [{ model, isDefault: true }], nextCursor: null },
  });
  expect(await terminal.request('thread/resume', {
    threadId, model, cwd: '/tmp/fixture-outside-workspace', runtimeWorkspaceRoots: ['/tmp/fixture-root'],
  })).toMatchObject({ result: { thread: { id: threadId, turns: [{ status: 'completed' }] }, model } });
  const competing = await post(`/${id}/turns`, { text: '终端连接期间的并发问题' });
  expect(competing.status).toBe(409);
  expect(await competing.json()).toMatchObject({ code: 'CODEX_TERMINAL_CONNECTED' });

  const question = '终端第二轮合成问题';
  const second = await terminal.request('turn/start', {
    threadId, model, input: [{ type: 'text', text: question, textElements: [] }],
  });
  expect(second).toMatchObject({ result: { turn: { id: expect.any(String) } } });
  const secondTurnId = (second.result as { turn: { id: string } }).turn.id;
  const completed = await terminal.waitFor(frame => frame.method === 'turn/completed');
  expect(completed).toMatchObject({ params: { threadId, turn: { id: secondTurnId, status: 'completed', items: [
    { type: 'userMessage', content: [{ text: question }] },
    { type: 'agentMessage', text: '合成回答' },
  ] } } });
  await terminal.close();

  const third = await post(`/${id}/turns`, { text: '见岔第三轮合成问题' });
  expect(third.status).toBe(202);
  expect(await third.json()).toMatchObject({ threadId, model });
  await expect.poll(async () => (await chat.get(id)).busy).toBe(false);
  const result = await chat.get(id);
  expect(result).toMatchObject({ threadId, model });
  expect(result.messages.map(message => message.text)).toEqual([
    '见岔首轮合成问题', '合成回答', question, '合成回答', '见岔第三轮合成问题', '合成回答',
  ]);
}, 15_000);

it('从受控入口之外追加重复设置，仍不能恢复或发送', async () => {
  setFixtureModels(availableModels, { terminalSettings: 'onClose' });
  const { id, threadId, post } = await startTerminalConversation();
  const nativeThreadPath = join(directory, 'no-project', threadId + '.json');
  const recording = nativeThreadPath + 'l';
  const verifiedRecording = readFileSync(recording, 'utf8');
  const repeatedSettings = verifiedRecording.split('\n')[0]!.replace('08:00:00', '08:01:00');
  writeFileSync(recording, verifiedRecording + repeatedSettings + '\n');

  const terminal = await connectTerminal(await post(`/${id}/terminal`), threadId);
  expect(await terminal.request('thread/resume', { threadId, model })).toHaveProperty('error');
  expect(await terminal.request('turn/start', {
    threadId, model, input: [{ type: 'text', text: '修改记录后的合成问题' }],
  })).toHaveProperty('error');
  const calls = readFileSync(nativeRequests, 'utf8').split('\n');
  expect(calls).not.toContain('thread/resume');
  expect(calls.filter(method => method === 'turn/start')).toHaveLength(1);
  expect(JSON.parse(readFileSync(nativeThreadPath, 'utf8')).turns).toHaveLength(1);
  await terminal.close();
}, 15_000);

it.each([
  { name: '退出前未发送', failModelAfterResume: false },
  { name: '发送时模型目录临时不可用', failModelAfterResume: true },
])('终端$name，退出只追加重复设置时，回工作台仍可继续', async ({ failModelAfterResume }) => {
  setFixtureModels(availableModels, { terminalSettings: 'onClose', failModelAfterResume });
  const { chat, id, threadId, post } = await startTerminalConversation();
  const recording = join(directory, 'no-project', threadId + '.jsonl');
  const verifiedRecording = readFileSync(recording, 'utf8');
  const terminal = await connectTerminal(await post(`/${id}/terminal`), threadId);
  expect(await terminal.request('thread/resume', { threadId, model })).toHaveProperty('result');
  expect(readFileSync(recording, 'utf8')).toBe(verifiedRecording);
  if (failModelAfterResume) {
    expect(await terminal.request('turn/start', {
      threadId, model, input: [{ type: 'text', text: '目录暂时不可用的合成问题' }],
    })).toHaveProperty('error');
  }
  await terminal.close();
  const initialSettings = verifiedRecording.split('\n')[0]!;
  expect(readFileSync(recording, 'utf8')).toBe(verifiedRecording +
    initialSettings.replace('08:00:00', '08:01:00') + '\n');
  expect(readFileSync(nativeRequests, 'utf8').match(/^turn\/start$/gm)).toHaveLength(1);

  setFixtureModels(availableModels);
  const next = await post(`/${id}/turns`, { text: '恢复后的见岔合成问题' });
  expect(next.status).toBe(202);
  expect(await next.json()).toMatchObject({ threadId, model });
  await expect.poll(async () => (await chat.get(id)).busy).toBe(false);
}, 15_000);

it.each(['onResume', 'changed', 'unknown'] as const)(
  '恢复后写入原生设置记录 %s，只有重复设置可继续发送', async terminalSettings => {
    setFixtureModels(availableModels, { terminalSettings });
    const { chat, id, threadId, post } = await startTerminalConversation();
    const terminal = await connectTerminal(await post(`/${id}/terminal`), threadId);
    expect(await terminal.request('thread/resume', { threadId, model })).toHaveProperty('result');
    const start = await terminal.request('turn/start', {
      threadId, model, input: [{ type: 'text', text: '恢复记录变动后的合成问题' }],
    });
    if (terminalSettings === 'onResume') {
      expect(start).toHaveProperty('result');
      await terminal.waitFor(frame => frame.method === 'turn/completed');
    } else {
      expect(start).toHaveProperty('error');
    }
    await terminal.close();
    if (terminalSettings === 'onResume') {
      expect((await chat.get(id)).messages).toHaveLength(4);
    } else {
      const rejected = await post(`/${id}/turns`, { text: '改动记录后的见岔合成问题' });
      expect(rejected.status).toBe(403);
      expect(await rejected.json()).toMatchObject({ code: 'CODEX_HISTORY_UNVERIFIED' });
      expect(readFileSync(nativeRequests, 'utf8').match(/^turn\/start$/gm)).toHaveLength(1);
    }
  }, 15_000,
);

it('模型目录恢复后，可在同一个终端连接上重试 resume', async () => {
  const { id, threadId, post } = await startTerminalConversation();
  setFixtureModels(availableModels, { modelListError: true });
  const terminal = await connectTerminal(await post(`/${id}/terminal`), threadId);
  expect(await terminal.request('thread/resume', { threadId, model })).toHaveProperty('error');
  expect(readFileSync(nativeRequests, 'utf8')).not.toContain('thread/resume\n');
  setFixtureModels(availableModels);
  expect(await terminal.request('thread/resume', { threadId, model })).toMatchObject({
    result: { thread: { id: threadId, turns: [{ status: 'completed' }] }, model },
  });
  await terminal.close();
}, 15_000);

it('终端发出问题后断开，只有原生回合完成才更新工作台记录', async () => {
  const { chat, id, threadId, post } = await startTerminalConversation();
  setFixtureModels(availableModels, { holdTurn: true });
  const indexPath = join(directory, 'conversations.json');
  const initial = JSON.parse(readFileSync(indexPath, 'utf8'))[0];
  const terminal = await connectTerminal(await post(`/${id}/terminal`), threadId);
  expect(await terminal.request('thread/resume', { threadId, model })).toHaveProperty('result');
  const question = '终端断线前发出的合成问题';
  expect(await terminal.request('turn/start', {
    threadId, model, input: [{ type: 'text', text: question }],
  })).toHaveProperty('result');
  await terminal.close();

  try {
    expect((await chat.get(id)).busy).toBe(true);
    const competing = await post(`/${id}/turns`, { text: '原生回合完成前的合成问题' });
    expect(competing.status).toBe(409);
    expect(await competing.json()).toMatchObject({ code: 'CODEX_TURN_ACTIVE' });
    expect(JSON.parse(readFileSync(indexPath, 'utf8'))[0]?.checkpoint).toBe(initial.checkpoint);
  } finally {
    writeFileSync(resultSignal, '', { mode: 0o600 });
  }
  await expect.poll(async () => (await chat.get(id)).busy).toBe(false);
  expect(JSON.parse(readFileSync(indexPath, 'utf8'))[0]?.checkpoint).not.toBe(initial.checkpoint);
  const result = await chat.get(id);
  expect(result).toMatchObject({ threadId, model });
  expect(result.messages.map(message => message.text)).toEqual(['见岔首轮合成问题', '合成回答', question, '合成回答']);
}, 15_000);

it('重开带拒绝标记的已核验旧会话，终端只返回可见记录且仍可续聊', async () => {
  const { chat, id, threadId, post } = await startTerminalConversation();
  const rejectedQuestion = '旧回合被拒绝的合成问题';
  expect((await post(`/${id}/turns`, { text: rejectedQuestion })).status).toBe(202);
  await expect.poll(async () => (await chat.get(id)).busy).toBe(false);
  await chat.close();
  const recording = join(directory, 'no-project', threadId + '.json');
  const native = JSON.parse(readFileSync(recording, 'utf8'));
  const [visible, rejected] = native.turns as { id: string }[];
  const indexPath = join(directory, 'conversations.json');
  const [initial] = JSON.parse(readFileSync(indexPath, 'utf8'));
  writeFileSync(indexPath, JSON.stringify([{ ...initial, rejectedModelTurnId: rejected!.id, rejectedModelTurnStatus: 'completed' }]));

  const reopened = chats = new AgentChat(directory, 'test');
  const reopenedPost = terminalWorkspacePost(reopened);
  const terminal = await connectTerminal(await reopenedPost(`/${id}/terminal`), threadId);
  for (const method of ['thread/resume', 'thread/read']) {
    expect(await terminal.request(method, method === 'thread/resume' ? { threadId, model } : { threadId, includeTurns: true }))
      .toMatchObject({ result: { thread: { id: threadId, preview: '', turns: [{ id: visible!.id }] } } });
  }
  expect(await terminal.request('thread/turns/list', { threadId })).toMatchObject({
    result: { data: [{ id: visible!.id }] },
  });
  expect(await terminal.request('thread/items/list', { threadId })).toMatchObject({
    result: { data: [{ turnId: visible!.id }, { turnId: visible!.id }] },
  });
  expect(await terminal.request('thread/items/list', { threadId, turnId: rejected!.id })).toMatchObject({
    result: { data: [] },
  });
  expect(JSON.stringify(terminal.frames)).not.toContain(rejectedQuestion);

  const question = '重开旧会话后的合成问题';
  expect(await terminal.request('turn/start', {
    threadId, model, input: [{ type: 'text', text: question }],
  })).toHaveProperty('result');
  await terminal.waitFor(frame => frame.method === 'turn/completed');
  await terminal.close();
  const result = await reopened.get(id);
  expect(result).toMatchObject({ threadId, model });
  expect(result.messages.map(message => message.text)).toEqual(['见岔首轮合成问题', '合成回答', question, '合成回答']);
}, 15_000);

it('受控终端把路径和配置留在本地边界，拒绝其他会话、模型及额外附件', async () => {
  const { id, threadId, post } = await startTerminalConversation();
  const terminal = await connectTerminal(await post(`/${id}/terminal`), threadId);
  const otherThread = '00000000-0000-4000-8000-000000000000';
  const text = { type: 'text', text: '受控终端合成问题', textElements: [] };
  const beforeResume = readFileSync(nativeRequests, 'utf8');
  expect(await terminal.request('config/read', { cwd: '/tmp/fixture-project', includeLayers: true })).toMatchObject({
    result: { config: { model }, origins: {} },
  });
  for (const params of [
    { threadId: otherThread },
    { threadId, path: '/tmp/fixture-foreign-session' },
    { threadId, config: { model: nativeDefaultModel } },
    { threadId, model: nativeDefaultModel },
  ]) expect(await terminal.request('thread/resume', params)).toHaveProperty('error');
  expect(await terminal.request('thread/read', { threadId: otherThread, includeTurns: true })).toHaveProperty('error');
  expect(readFileSync(nativeRequests, 'utf8')).toBe(beforeResume);

  expect(await terminal.request('thread/resume', { threadId, model })).toHaveProperty('result');
  const afterResume = readFileSync(nativeRequests, 'utf8');
  for (const params of [
    { threadId: otherThread, input: [text] },
    { threadId, model: nativeDefaultModel, input: [text] },
    { threadId, config: { model: nativeDefaultModel }, input: [text] },
    { threadId, input: [text, { type: 'localImage', path: '/tmp/fixture-private.png' }] },
    { threadId, input: [{ ...text, textElements: [{ byteRange: { start: 0, end: 1 } }] }] },
  ]) expect(await terminal.request('turn/start', params)).toHaveProperty('error');
  expect(readFileSync(nativeRequests, 'utf8')).toBe(afterResume);
  expect(JSON.parse(readFileSync(join(directory, 'no-project', threadId + '.json'), 'utf8')).turns).toHaveLength(1);
  await terminal.close();
}, 15_000);

it('终端回合被原生改派后，WebSocket 收不到异模文本且工作台保留上一轮', async () => {
  const { chat, id, threadId, post } = await startTerminalConversation();
  setFixtureModels(availableModels, { reroutedModel: nativeDefaultModel });
  const terminal = await connectTerminal(await post(`/${id}/terminal`), threadId);
  expect(await terminal.request('thread/resume', { threadId, model })).toHaveProperty('result');
  expect(await terminal.request('turn/start', {
    threadId, model, input: [{ type: 'text', text: '终端将被改派的合成问题' }],
  })).toHaveProperty('result');
  expect(await terminal.request('thread/read', { threadId, includeTurns: true })).toHaveProperty('error');
  writeFileSync(rerouteSignal, '', { mode: 0o600 });
  expect(await terminal.waitFor(frame => frame.method === 'error')).toMatchObject({ params: { threadId } });
  await terminal.disconnected;
  expect(JSON.stringify(terminal.frames)).not.toContain('错误模型的合成回答');
  expect(terminal.frames.some(frame => frame.method === 'item/completed' || frame.method === 'turn/completed')).toBe(false);
  expect(readFileSync(nativeRequests, 'utf8')).toContain('turn/interrupt\n');
  const result = await chat.get(id);
  expect(result).toMatchObject({ threadId, model, busy: false, error: expect.stringContaining('已隐藏本轮内容') });
  expect(result.messages.map(message => message.text)).toEqual(['见岔首轮合成问题', '合成回答']);
}, 15_000);

it('正式路由拒绝非本人和跨站请求，且不提供独立授权入口', async () => {
  chats = new AgentChat(directory, 'test');
  const app = createWorkspaceApp(mapping!, origin, () => new Response(''), chats);
  const agent = mapping!.access.issue('agent', []);
  const human = mapping!.access.issue('human', ['*']);
  const headers = { Origin: origin, Authorization: 'Bearer ' + human, 'Content-Type': 'application/json' };
  expect((await app.request(endpoint + '/status')).status).toBe(401);
  expect((await app.request(endpoint + '/status', { headers: { Authorization: 'Bearer ' + agent } })).status).toBe(403);
  expect((await app.request(endpoint + '/conversations', { headers: { Authorization: 'Bearer ' + agent } })).status).toBe(403);
  const crossSite = await app.request(endpoint + '/status', { headers: { ...headers, 'Sec-Fetch-Site': 'cross-site' } });
  expect(crossSite.status).toBe(403);
  expect(await crossSite.json()).toMatchObject({ code: 'CROSS_SITE' });
  expect((await app.request(endpoint + '/authorization', { method: 'POST', headers, body: '{}' })).status).toBe(404);
  expect((await app.request(origin + '/auth/callback?state=invalid')).status).toBe(404);
  expect(existsSync(join(nativeHome, 'started'))).toBe(false);
});

it('正式路由复用原生登录，每次发送重新检查，退出后仍可读取原生历史', async () => {
  const chat = chats = new AgentChat(directory, 'test');
  const app = createWorkspaceApp(mapping!, origin, () => new Response(''), chat);
  const human = mapping!.access.issue('human', ['*']);
  const headers = { Origin: origin, Authorization: 'Bearer ' + human, 'Content-Type': 'application/json' };
  rmSync(nativeAccount);
  const emptyStatus = await app.request(endpoint + '/status', { headers });
  expect(emptyStatus.status).toBe(200);
  expect(await emptyStatus.json()).toEqual({ loggedIn: false, modelAvailable: false, message: expect.stringContaining('codex login') });

  const create = await app.request(endpoint + '/conversations', { method: 'POST', headers, body: '{}' });
  expect(create.status).toBe(201);
  const { id } = await create.json() as { id: string };
  const conversation = endpoint + '/conversations/' + id;
  const send = (text: string) => app.request(conversation + '/turns', {
    method: 'POST', headers, body: JSON.stringify({ text }),
  });
  const missing = await send('未登录问题');
  expect(missing.status).toBe(401);
  expect(await missing.json()).toMatchObject({ code: 'CODEX_LOGIN_REQUIRED', message: expect.stringContaining('codex login') });
  expect(readdirSync(join(directory, 'no-project'))).toEqual([]);
  await expect(chat.get(id)).resolves.toMatchObject({ threadId: null, busy: false, messages: [] });

  writeFileSync(nativeAccount, JSON.stringify({ expiresAt: Date.now() + 60_000 }), { mode: 0o600 });
  const loginStatus = await app.request(endpoint + '/status', { headers });
  expect(loginStatus.status).toBe(200);
  expect(await loginStatus.json()).toEqual({ loggedIn: true, modelAvailable: true });
  const first = await send('第一个合成问题');
  expect(first.status).toBe(202);
  const { threadId } = await first.json() as { threadId: string };
  await expect.poll(async () => (await chat.get(id)).busy).toBe(false);

  writeFileSync(nativeAccount, JSON.stringify({ expiresAt: 0 }));
  const expired = await send('过期后问题');
  expect(expired.status).toBe(401);
  expect(await expired.json()).toMatchObject({ code: 'CODEX_LOGIN_REQUIRED' });
  const expiredStatus = await app.request(endpoint + '/status', { headers });
  expect(expiredStatus.status).toBe(200);
  expect(await expiredStatus.json()).toEqual({ loggedIn: false, modelAvailable: false, message: expect.stringContaining('codex login') });
  const history = await app.request(conversation, { headers });
  expect(history.status).toBe(200);
  expect(await history.json()).toMatchObject({ threadId, model, messages: [{ text: '第一个合成问题' }, { text: '合成回答' }] });

  writeFileSync(nativeAccount, JSON.stringify({ expiresAt: Date.now() + 60_000 }));
  const resumed = await send('重新登录后的合成问题');
  expect(resumed.status).toBe(202);
  expect(await resumed.json()).toMatchObject({ threadId });
  await expect.poll(async () => (await chat.get(id)).busy).toBe(false);
  expect((await chat.get(id)).messages.map(message => message.text))
    .toEqual(['第一个合成问题', '合成回答', '重新登录后的合成问题', '合成回答']);
});

it.each([
  { name: '模型列表为空', models: [] },
  { name: '只有其他模型和近似模型 ID', models: [nativeDefault, { model: model + '-preview', hidden: false }] },
  { name: '精确模型 ID 仅以隐藏状态出现', models: [nativeDefault, { model, hidden: true }] },
])('原生登录后$name，状态报告不可用且发送返回 503', async ({ models }) => {
  const chat = chats = new AgentChat(directory, 'test');
  const app = createWorkspaceApp(mapping!, origin, () => new Response(''), chat);
  const human = mapping!.access.issue('human', ['*']);
  const headers = { Origin: origin, Authorization: 'Bearer ' + human, 'Content-Type': 'application/json' };
  const { id } = chat.create();
  expect(await chat.status()).toEqual({ loggedIn: true, modelAvailable: true });

  setFixtureModels(models);
  const status = await app.request(endpoint + '/status', { headers });
  expect(status.status).toBe(200);
  expect(await status.json()).toEqual({ loggedIn: true, modelAvailable: false, message: expect.stringContaining(model) });
  const send = await app.request(endpoint + '/conversations/' + id + '/turns', {
    method: 'POST', headers, body: JSON.stringify({ text: '不可用时的合成问题' }),
  });
  expect(send.status).toBe(503);
  expect(await send.json()).toMatchObject({ code: 'CODEX_MODEL_UNAVAILABLE' });
  expect(readFileSync(nativeRequests, 'utf8')).not.toMatch(/thread\/start|turn\/start/);
  expect(await chat.get(id)).toMatchObject({ threadId: null, busy: false, messages: [] });
});

it('在下一页模型列表找到 Luna 后，仍以 Luna 启动回合', async () => {
  const chat = chats = new AgentChat(directory, 'test');
  setFixtureModels([nativeDefault], { nextModelPage: [{ model, hidden: false }] });
  expect(await chat.status()).toEqual({ loggedIn: true, modelAvailable: true });
  const { id } = chat.create();
  await expect(chat.send(id, '分页模型列表的合成问题')).resolves.toMatchObject({ model });
  await expect.poll(async () => (await chat.get(id)).busy).toBe(false);
  expect((await chat.get(id)).messages.map(message => message.text)).toEqual(['分页模型列表的合成问题', '合成回答']);
});

it('模型目录查询失败时保留已登录状态和历史，发送继续停在回合启动之前', async () => {
  const chat = chats = new AgentChat(directory, 'test');
  const app = createWorkspaceApp(mapping!, origin, () => new Response(''), chat);
  const human = mapping!.access.issue('human', ['*']);
  const headers = { Origin: origin, Authorization: 'Bearer ' + human, 'Content-Type': 'application/json' };
  const { id } = chat.create();
  await chat.send(id, '目录故障前的合成问题');
  await expect.poll(async () => (await chat.get(id)).busy).toBe(false);
  setFixtureModels(availableModels, { modelListError: true });
  writeFileSync(nativeRequests, '');

  const status = await app.request(endpoint + '/status', { headers });
  expect(status.status).toBe(200);
  expect(await status.json()).toMatchObject({ loggedIn: true, modelAvailable: false });
  const conversation = endpoint + '/conversations/' + id;
  const history = await app.request(conversation, { headers });
  expect(history.status).toBe(200);
  expect(await history.json()).toMatchObject({ messages: [{ text: '目录故障前的合成问题' }, { text: '合成回答' }] });
  const send = await app.request(conversation + '/turns', {
    method: 'POST', headers, body: JSON.stringify({ text: '目录故障后的合成问题' }),
  });
  expect(send.status).toBe(503);
  expect(readFileSync(nativeRequests, 'utf8')).not.toMatch(/thread\/resume|turn\/start/);
});

it.each(['thread/start', 'thread/resume'] as const)('原生 %s 回报其他模型时拒绝发送', async method => {
  const chat = chats = new AgentChat(directory, 'test');
  const { id } = chat.create();
  if (method === 'thread/resume') {
    await chat.send(id, '第一条合成问题');
    await expect.poll(async () => (await chat.get(id)).busy).toBe(false);
    writeFileSync(nativeRequests, '');
  }
  const before = await chat.get(id);
  setFixtureModels(availableModels, { openedModel: nativeDefaultModel });
  await expect(chat.send(id, '模型不匹配时的合成问题')).rejects.toMatchObject({
    code: 'CODEX_MODEL_MISMATCH', message: '见岔只允许 gpt-6-luna，本轮未发送。',
  });
  const requests = readFileSync(nativeRequests, 'utf8').trim().split('\n');
  expect(requests).toContain(method);
  expect(requests).not.toContain('turn/start');
  expect(await chat.get(id)).toMatchObject({ threadId: before.threadId, model: before.model, busy: false, messages: before.messages });
});

it('回合被原生 Codex 改派到其他模型时中断，隐藏该回合并保留 G4 历史拦截', async () => {
  const chat = chats = new AgentChat(directory, 'test');
  const { id } = chat.create();
  const { threadId } = await chat.send(id, '第一条合成问题');
  await expect.poll(async () => (await chat.get(id)).busy).toBe(false);

  setFixtureModels(availableModels, { reroutedModel: nativeDefaultModel });
  await chat.send(id, '会被改派的合成问题');
  writeFileSync(rerouteSignal, '', { mode: 0o600 });
  await expect.poll(async () => (await chat.get(id)).busy).toBe(false);
  expect(readFileSync(nativeRequests, 'utf8').split('\n')).toContain('turn/interrupt');
  const result = await chat.get(id);
  expect(result.error).toBe('见岔只允许 gpt-6-luna，已隐藏本轮内容。Codex 已中断本轮。');
  expect(result.messages.map(message => message.text)).toEqual(['第一条合成问题', '合成回答']);

  const native = JSON.parse(readFileSync(join(directory, 'no-project', threadId + '.json'), 'utf8'));
  expect(native.turns).toHaveLength(2);
  expect(native.turns[1].items[1].text).toBe('错误模型的合成回答');
  setFixtureModels(availableModels);
  await chat.close();
  const reopened = chats = new AgentChat(directory, 'test');
  expect(await reopened.get(id)).toMatchObject({ messages: result.messages, error: result.error });
  await expect(reopened.send(id, '改派后继续的合成问题')).rejects.toMatchObject({ code: 'CODEX_HISTORY_UNVERIFIED' });
});

it.each([
  { interruptOutcome: 'interrupted', expected: 'Codex 已中断本轮。' },
  { interruptOutcome: 'completed', expected: 'Codex 已完成本轮。' },
  { interruptOutcome: 'unconfirmed', expected: '原生回合结果未确认。' },
] as const)('改派后按原生终态报告 $interruptOutcome', async ({ interruptOutcome, expected }) => {
  const chat = chats = new AgentChat(directory, 'test');
  setFixtureModels(availableModels, { reroutedModel: nativeDefaultModel, interruptOutcome });
  const { id } = chat.create();
  await chat.send(id, '会被改派的合成问题');
  writeFileSync(rerouteSignal, '', { mode: 0o600 });
  await expect.poll(() => readFileSync(nativeRequests, 'utf8')).toContain('turn/interrupt\n');
  const rejection = { messages: [], error: '见岔只允许 gpt-6-luna，已隐藏本轮内容。原生回合结果未确认。' };
  const reopenedWhileWaiting = new AgentChat(directory, 'test');
  try {
    expect(await chat.get(id)).toMatchObject({ ...rejection, busy: true });
    expect(await reopenedWhileWaiting.get(id)).toMatchObject(rejection);
  } finally {
    await reopenedWhileWaiting.close();
    writeFileSync(resultSignal, '', { mode: 0o600 });
  }
  await expect.poll(async () => (await chat.get(id)).busy).toBe(false);
  const result = await chat.get(id);
  expect(result).toMatchObject({ messages: [], error: `见岔只允许 gpt-6-luna，已隐藏本轮内容。${expected}` });
  await chat.close();
  const reopened = chats = new AgentChat(directory, 'test');
  expect(await reopened.get(id)).toEqual(result);
});

it('终端成功续聊后回看新问答，旧的改派回合仍隐藏且不再提示', async () => {
  const chat = chats = new AgentChat(directory, 'test');
  setFixtureModels(availableModels, { reroutedModel: nativeDefaultModel });
  const { id } = chat.create();
  const { threadId } = await chat.send(id, '被改派的合成问题');
  writeFileSync(rerouteSignal, '', { mode: 0o600 });
  await expect.poll(async () => (await chat.get(id)).busy).toBe(false);
  expect((await chat.get(id)).error).toContain('gpt-6-luna');

  const path = join(directory, 'no-project', threadId + '.json');
  const native = JSON.parse(readFileSync(path, 'utf8'));
  native.turns.push({ id: 'terminal-turn', status: 'completed', items: [
    { id: 'terminal-user', type: 'userMessage', content: [{ type: 'text', text: '终端续聊问题' }] },
    { id: 'terminal-agent', type: 'agentMessage', text: '终端续聊回答' },
  ] });
  writeFileSync(path, JSON.stringify(native));
  const result = await chat.get(id);
  expect(result).toMatchObject({ threadId, busy: false });
  expect(result.messages.map(message => message.text)).toEqual(['终端续聊问题', '终端续聊回答']);
  expect(result.error).toBeUndefined();
  await chat.close();
  const reopened = chats = new AgentChat(directory, 'test');
  expect(await reopened.get(id)).toEqual(result);
});

it('原生结果报告其他模型前，右栏轮询拿不到待核验的回答', async () => {
  const chat = chats = new AgentChat(directory, 'test');
  const app = createWorkspaceApp(mapping!, origin, () => new Response(''), chat);
  const human = mapping!.access.issue('human', ['*']);
  const headers = { Origin: origin, Authorization: 'Bearer ' + human };
  setFixtureModels(availableModels, { completedModel: nativeDefaultModel });
  const { id } = chat.create();
  const question = '结果模型不匹配的合成问题';
  await chat.send(id, question);
  // The fixture has already emitted its answer when the final model check begins.
  await expect.poll(() => readFileSync(nativeRequests, 'utf8')).toContain('thread/read\n');
  try {
    const busy = await app.request(endpoint + '/conversations/' + id, { headers });
    expect(busy.status).toBe(200);
    expect(await busy.json()).toMatchObject({ busy: true, messages: [{ role: 'user', text: question }] });
  } finally {
    writeFileSync(resultSignal, '', { mode: 0o600 });
  }
  await expect.poll(async () => (await chat.get(id)).busy).toBe(false);
  expect(await chat.get(id)).toMatchObject({
    messages: [],
    error: '见岔只允许 gpt-6-luna，已隐藏本轮内容。Codex 已完成本轮。',
  });
  await expect(chat.send(id, '下一条合成问题')).rejects.toMatchObject({ code: 'CODEX_HISTORY_UNVERIFIED' });
});

it('最终读取发现异模后，等待原生连接退出期间已隐藏本轮且可重开', async () => {
  const chat = chats = new AgentChat(directory, 'test');
  const { id } = chat.create();
  await chat.send(id, '上一轮问题');
  await expect.poll(async () => (await chat.get(id)).busy).toBe(false);
  const previous = (await chat.get(id)).messages;
  setFixtureModels(availableModels, { completedModel: nativeDefaultModel, holdClose: true });
  await chat.send(id, '最终读取才发现的异模问题');
  writeFileSync(resultSignal, '');
  await expect.poll(() => existsSync(join(nativeHome, 'writer-closing'))).toBe(true);
  const reopened = new AgentChat(directory, 'test');
  try {
    const rejected = { messages: previous, error: expect.stringContaining('已隐藏本轮内容') };
    expect(await chat.get(id)).toMatchObject({ ...rejected, busy: true });
    await expect(chat.send(id, '关闭期间的重试')).rejects.toMatchObject({ code: 'CODEX_TURN_ACTIVE' });
    expect(await reopened.get(id)).toMatchObject(rejected);
  } finally {
    writeFileSync(join(nativeHome, 'release-writer'), '');
    await reopened.close();
  }
  await expect.poll(async () => (await chat.get(id)).busy).toBe(false);
  expect((await chat.get(id)).error).toContain('Codex 已完成本轮');
});

it.each(['interruptError', 'noReply'] as const)('中断请求 %s 且没有终态通知时，短时结束等待并释放专属连接', async interruptOutcome => {
  const chat = chats = new AgentChat(directory, 'test');
  setFixtureModels(availableModels, { reroutedModel: nativeDefaultModel, interruptOutcome });
  const { id } = chat.create();
  await chat.send(id, '不会收到终态的合成问题');
  writeFileSync(rerouteSignal, '');
  await expect.poll(() => readFileSync(nativeRequests, 'utf8')).toContain('turn/interrupt\n');
  await expect.poll(async () => (await chat.get(id)).busy, { timeout: 4500 }).toBe(false);
  const pid = Number(readFileSync(join(nativeHome, 'writer-closing'), 'utf8'));
  expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }));
  const result = await chat.get(id);
  expect(result).toMatchObject({ messages: [], error: expect.stringContaining('原生回合结果未确认') });
  await chat.close();
  const reopened = chats = new AgentChat(directory, 'test');
  expect(await reopened.get(id)).toEqual(result);
}, 8000);

it('改派超时关闭连接时收到原生中断终态，退出后重开仍显示已中断', async () => {
  const chat = chats = new AgentChat(directory, 'test');
  setFixtureModels(availableModels, { reroutedModel: nativeDefaultModel, interruptOutcome: 'interruptedOnClose', holdClose: true });
  const { id } = chat.create();
  await chat.send(id, '只在关闭时收到终态的合成问题');
  writeFileSync(rerouteSignal, '');
  try {
    await expect.poll(() => existsSync(join(nativeHome, 'writer-closing')), { timeout: 4500 }).toBe(true);
    expect(await chat.get(id)).toMatchObject({ busy: true, messages: [] });
    await expect(chat.send(id, '关闭期间重试')).rejects.toMatchObject({ code: 'CODEX_TURN_ACTIVE' });
  } finally {
    writeFileSync(join(nativeHome, 'release-writer'), '');
  }
  await expect.poll(async () => (await chat.get(id)).busy).toBe(false);
  const result = await chat.get(id);
  expect(result).toMatchObject({ messages: [], error: expect.stringContaining('Codex 已中断本轮') });
  await chat.close();
  const reopened = chats = new AgentChat(directory, 'test');
  expect(await reopened.get(id)).toEqual(result);
}, 8000);

it.each([
  { withPrevious: false, source: 'terminal' },
  { withPrevious: true, source: 'terminal' },
  { withPrevious: true, source: 'workbench' },
])('原生历史没有拒绝轮时保留提示，直到 $source 续聊（含上一轮 $withPrevious）', async ({ withPrevious, source }) => {
  const chat = chats = new AgentChat(directory, 'test');
  const { id } = chat.create();
  if (withPrevious) {
    await chat.send(id, '上一轮合成问题');
    await expect.poll(async () => (await chat.get(id)).busy).toBe(false);
  }
  const previous = (await chat.get(id)).messages;
  setFixtureModels(availableModels, {
    reroutedModel: nativeDefaultModel, interruptOutcome: 'unconfirmed', omitRecordedTurn: true,
  });
  const { threadId } = await chat.send(id, '改派后记录延迟的问题');
  writeFileSync(rerouteSignal, '');
  await expect.poll(() => readFileSync(nativeRequests, 'utf8')).toContain('turn/interrupt\n');
  writeFileSync(resultSignal, '');
  await expect.poll(async () => (await chat.get(id)).busy).toBe(false);
  const result = await chat.get(id);
  expect(result).toMatchObject({ messages: previous, error: expect.stringContaining('原生回合结果未确认') });
  await chat.close();
  const reopened = chats = new AgentChat(directory, 'test');
  expect(await reopened.get(id)).toEqual(result);

  const nextQuestion = '改派后续聊的合成问题';
  const path = join(directory, 'no-project', threadId + '.json');
  const native = JSON.parse(readFileSync(path, 'utf8'));
  if (source === 'workbench') {
    setFixtureModels(availableModels);
    await reopened.send(id, nextQuestion);
    await expect.poll(async () => (await reopened.get(id)).busy).toBe(false);
  } else {
    const laterTurn = { id: 'terminal-turn', status: 'completed', items: [
      { id: 'terminal-user', type: 'userMessage', content: [{ type: 'text', text: nextQuestion }] },
      { id: 'terminal-agent', type: 'agentMessage', text: '合成回答' },
    ] };
    if (withPrevious) {
      // A truncated read provides neither the rejected turn nor its predecessor.
      writeFileSync(path, JSON.stringify({ ...native, turns: [laterTurn] }));
      expect((await reopened.get(id)).error).toEqual(result.error);
    }
    native.turns.push(laterTurn);
    writeFileSync(path, JSON.stringify(native));
  }
  const continued = await reopened.get(id);
  expect(continued.messages.map(message => message.text)).toEqual([...previous.map(message => message.text), nextQuestion, '合成回答']);
  expect(continued.error).toBeUndefined();
  if (source === 'terminal') {
    await expect(reopened.send(id, '终端续聊后重试')).rejects.toMatchObject({ code: 'CODEX_HISTORY_UNVERIFIED' });
  } else {
    writeFileSync(path, JSON.stringify(native)); // Native rollback removes the continuation.
    expect(await reopened.get(id)).toEqual(result);
  }
});

it.each([
  { entry: '查看', withBoundary: false },
  { entry: '发送', withBoundary: false },
  { entry: '查看', withBoundary: true },
])('旧索引首次 $entry 匹配 checkpoint（拒绝前边界 $withBoundary）后，按仍在历史中的续聊显示状态', async ({ entry, withBoundary }) => {
  const chat = chats = new AgentChat(directory, 'test');
  const { id } = chat.create();
  const { threadId } = await chat.send(id, '拒绝前的问题');
  await expect.poll(async () => (await chat.get(id)).busy).toBe(false);
  const path = join(directory, 'no-project', threadId + '.json');
  const beforeContinuation = readFileSync(path);
  await chat.send(id, '旧版已成功续聊的问题');
  await expect.poll(async () => (await chat.get(id)).busy).toBe(false);
  const continued = await chat.get(id);
  const firstContinuation = JSON.parse(readFileSync(path, 'utf8'));
  if (withBoundary) {
    await chat.send(id, '旧版第二次续聊的问题');
    await expect.poll(async () => (await chat.get(id)).busy).toBe(false);
  }
  const legacyDetail = await chat.get(id);
  await chat.close();

  const file = join(directory, 'conversations.json');
  const [saved] = JSON.parse(readFileSync(file, 'utf8'));
  writeFileSync(file, JSON.stringify([{ ...saved, rejectedModelTurnId: 'absent-turn', continuedAfterRejection: true,
    ...(withBoundary ? { rejectedAfterTurnId: firstContinuation.turns[0].id } : {}),
  }]));
  const reopened = chats = new AgentChat(directory, 'test');
  const legacyRecording = readFileSync(path);
  if (entry === '查看') {
    expect(await reopened.get(id)).toEqual(legacyDetail);
  } else {
    await reopened.send(id, '升级后继续提问');
    await expect.poll(async () => (await reopened.get(id)).busy).toBe(false);
  }
  await reopened.close();
  const delayedRejection = { id: 'absent-turn', status: 'completed', items: [
    { id: 'rejected-answer', type: 'agentMessage', text: '延迟写入的异模回答' },
  ] };
  firstContinuation.turns.push(delayedRejection);
  writeFileSync(path, JSON.stringify(firstContinuation));
  const restored = chats = new AgentChat(directory, 'test');
  expect(await restored.get(id)).toEqual(continued);
  await expect(restored.send(id, '追加后重试')).rejects.toMatchObject({ code: 'CODEX_HISTORY_UNVERIFIED' });
  writeFileSync(path, legacyRecording);
  expect(await restored.get(id)).toEqual(legacyDetail);
  writeFileSync(path, beforeContinuation);
  const rejected = await restored.get(id);
  expect(rejected).toMatchObject({
    messages: continued.messages.slice(0, 2), error: expect.stringContaining('原生回合结果未确认'),
  });
  const rolledBack = JSON.parse(beforeContinuation.toString('utf8'));
  rolledBack.turns.push(delayedRejection);
  writeFileSync(path, JSON.stringify(rolledBack));
  expect(await restored.get(id)).toEqual(rejected);
  await expect(restored.send(id, '回退后重试')).rejects.toMatchObject({ code: 'CODEX_HISTORY_UNVERIFIED' });
});

it('旧 checkpoint 与已核验的第二轮续聊共存时，反复回看和重开都保留两份依据', async () => {
  const chat = chats = new AgentChat(directory, 'test');
  const { id } = chat.create();
  const { threadId } = await chat.send(id, '第一轮续聊');
  await expect.poll(async () => (await chat.get(id)).busy).toBe(false);
  const first = await chat.get(id);
  const path = join(directory, 'no-project', threadId + '.json');
  const firstRecording = readFileSync(path);
  const index = join(directory, 'conversations.json');
  const [{ checkpoint: legacyContinuationCheckpoint }] = JSON.parse(readFileSync(index, 'utf8'));
  await chat.send(id, '第二轮续聊');
  await expect.poll(async () => (await chat.get(id)).busy).toBe(false);
  await chat.close();

  const native = JSON.parse(readFileSync(path, 'utf8'));
  const [firstTurn, secondTurn] = native.turns;
  const rejected = { id: 'delayed-rejection', status: 'completed', items: [
    { id: 'rejected-answer', type: 'agentMessage', text: '延迟写入的异模回答' },
  ] };
  const [saved] = JSON.parse(readFileSync(index, 'utf8'));
  writeFileSync(index, JSON.stringify([{ ...saved, rejectedModelTurnId: rejected.id,
    legacyContinuationCheckpoint, verifiedContinuationTurnId: secondTurn.id }]));
  const reopened = chats = new AgentChat(directory, 'test');
  const open = vi.spyOn(fs, 'openSync');
  syncBuiltinESMExports();
  try {
    for (let view = 0; view < 2; view++) {
      expect(await reopened.get(id)).toMatchObject({ busy: false, error: undefined });
    }
    expect(open.mock.calls.filter(([file]) => file === path)).toHaveLength(0);
  } finally {
    open.mockRestore();
    syncBuiltinESMExports();
  }
  writeFileSync(path, firstRecording);
  expect(await reopened.get(id)).toEqual(first);
  expect(await reopened.get(id)).toEqual(first);
  writeFileSync(path, JSON.stringify({ ...native, turns: [firstTurn, rejected] }));
  expect(await reopened.get(id)).toEqual(first);
  await reopened.close();

  const restored = chats = new AgentChat(directory, 'test');
  expect(await restored.get(id)).toEqual(first);
  writeFileSync(path, JSON.stringify({ ...native, turns: [secondTurn, rejected] }));
  const result = await restored.get(id);
  expect(result.messages.map(message => message.text)).toEqual(['第二轮续聊', '合成回答']);
  expect(result.error).toBeUndefined();
  await expect(restored.send(id, '历史变化后重试')).rejects.toMatchObject({ code: 'CODEX_HISTORY_UNVERIFIED' });
  writeFileSync(path, JSON.stringify({ ...native, turns: [rejected] }));
  expect(await restored.get(id)).toMatchObject({ messages: [], error: expect.stringContaining('已隐藏本轮内容') });
});

it('终端活跃时仅在拒绝提示依赖旧 checkpoint 时读取原生记录', async () => {
  const chat = chats = new AgentChat(directory, 'test');
  const { id } = chat.create();
  const { threadId } = await chat.send(id, '旧版续聊');
  await expect.poll(async () => (await chat.get(id)).busy).toBe(false);
  await chat.close();

  const index = join(directory, 'conversations.json');
  const [saved] = JSON.parse(readFileSync(index, 'utf8'));
  writeFileSync(index, JSON.stringify([{ ...saved, rejectedModelTurnId: 'delayed-rejection', continuedAfterRejection: true }]));
  const path = join(directory, 'no-project', threadId + '.json');
  const recorded = readFileSync(path);
  const native = JSON.parse(recorded.toString('utf8'));
  // The fixture process serves thread/read. The parent opens the raw recording only for a fingerprint.
  const recording = join(root, 'native-recording');
  const active = { ...native, path: recording, status: { type: 'active' } };
  const terminal = { ...active, turns: [...native.turns,
    { id: 'delayed-rejection', status: 'interrupted', items: [] },
    { id: 'terminal', status: 'inProgress', items: [] },
  ] };
  writeFileSync(recording, JSON.stringify(terminal));
  writeFileSync(path, JSON.stringify(terminal));
  const reopened = chats = new AgentChat(directory, 'test');
  const open = vi.spyOn(fs, 'openSync');
  syncBuiltinESMExports();
  try {
    for (let poll = 0; poll < 2; poll++) {
      expect(await reopened.get(id)).toMatchObject({ busy: true, error: undefined });
    }
    expect(open.mock.calls.filter(([file]) => file === recording)).toHaveLength(0);

    writeFileSync(recording, recorded);
    writeFileSync(path, JSON.stringify(active));
    open.mockClear();
    expect(await reopened.get(id)).toMatchObject({ busy: true, error: undefined });
    expect(open.mock.calls.some(([file]) => file === recording)).toBe(true);
  } finally {
    open.mockRestore();
    syncBuiltinESMExports();
  }
});

it('旧索引续聊依据暂时无法保存时提示重启风险，再次查看可完成保存', async () => {
  const chat = chats = new AgentChat(directory, 'test');
  const { id } = chat.create();
  await chat.send(id, '拒绝后的首次成功续聊');
  await expect.poll(async () => (await chat.get(id)).busy).toBe(false);
  const continued = await chat.get(id);
  await chat.close();

  const index = join(directory, 'conversations.json');
  const [saved] = JSON.parse(readFileSync(index, 'utf8'));
  writeFileSync(index, JSON.stringify([{ ...saved, rejectedModelTurnId: 'absent-turn', continuedAfterRejection: true }]));
  const reopened = chats = new AgentChat(directory, 'test');
  const restoreIndex = blockIndexWrites();
  try {
    expect(await reopened.get(id)).toMatchObject({ messages: continued.messages, error: expect.stringMatching(/未保存.*重启/) });
  } finally {
    restoreIndex();
  }
  const path = join(directory, 'no-project', saved.threadId + '.json');
  const native = JSON.parse(readFileSync(path, 'utf8'));
  native.turns.push({ id: 'absent-turn', status: 'interrupted', items: [] });
  writeFileSync(path, JSON.stringify(native));
  expect(await reopened.get(id)).toEqual(continued);
  await reopened.close();
  const restored = chats = new AgentChat(directory, 'test');
  expect(await restored.get(id)).toEqual(continued);
  await expect(restored.send(id, '索引恢复后重试')).rejects.toMatchObject({ code: 'CODEX_HISTORY_UNVERIFIED' });
});

it('旧索引缺少续聊标记时，按现有历史显示拒绝原因', async () => {
  const chat = chats = new AgentChat(directory, 'test');
  const { id } = chat.create();
  await chat.send(id, '旧索引中的合成问题');
  await expect.poll(async () => (await chat.get(id)).busy).toBe(false);
  await chat.close();
  const file = join(directory, 'conversations.json');
  const [saved] = JSON.parse(readFileSync(file, 'utf8'));
  writeFileSync(file, JSON.stringify([{ ...saved, rejectedModelTurnId: 'absent-turn' }]));
  const reopened = chats = new AgentChat(directory, 'test');
  expect((await reopened.get(id)).error).toContain('原生回合结果未确认');
  setFixtureModels(availableModels, { omitRecordedTurn: true });
  await reopened.send(id, '原生记录尚缺的续聊');
  await expect.poll(async () => (await reopened.get(id)).busy).toBe(false);
  expect((await reopened.get(id)).error).toContain('原生回合结果未确认');

  setFixtureModels(availableModels);
  const nextQuestion = '旧索引重开后续聊';
  await reopened.send(id, nextQuestion);
  await expect.poll(async () => (await reopened.get(id)).busy).toBe(false);
  const continued = await reopened.get(id);
  expect(continued.messages.map(message => message.text)).toEqual(['旧索引中的合成问题', '合成回答', nextQuestion, '合成回答']);
  expect(continued.error).toBeUndefined();
  const path = join(directory, 'no-project', saved.threadId + '.json');
  const firstContinuation = JSON.parse(readFileSync(path, 'utf8'));
  await reopened.send(id, '第二次续聊');
  await expect.poll(async () => (await reopened.get(id)).busy).toBe(false);
  const bothContinuations = await reopened.get(id);
  expect(bothContinuations.messages.at(-2)?.text).toBe('第二次续聊');
  await reopened.close();
  const restored = chats = new AgentChat(directory, 'test');
  expect(await restored.get(id)).toEqual(bothContinuations);

  const delayedRejection = { id: 'absent-turn', status: 'completed', items: [
    { id: 'rejected-answer', type: 'agentMessage', text: '延迟写入的异模回答' },
  ] };
  firstContinuation.turns.push(delayedRejection);
  writeFileSync(path, JSON.stringify(firstContinuation));
  expect(await restored.get(id)).toEqual(continued);
  await expect(restored.send(id, '历史变化后重试')).rejects.toMatchObject({ code: 'CODEX_HISTORY_UNVERIFIED' });
  writeFileSync(path, JSON.stringify({ ...firstContinuation, turns: [firstContinuation.turns[0], delayedRejection] }));
  expect(await restored.get(id)).toMatchObject({
    messages: continued.messages.slice(0, 2), error: expect.stringContaining('原生回合结果未确认'),
  });
});

function blockIndexWrites() {
  const index = join(directory, 'conversations.json');
  const original = join(root, 'original-index.json');
  renameSync(index, original);
  mkdirSync(index);
  return () => {
    rmdirSync(index);
    renameSync(original, index);
  };
}

it.each(['reroute', 'read'] as const)('在 %s 发现异模时索引写入失败，提示重启风险且继续过滤', async path => {
  const chat = chats = new AgentChat(directory, 'test');
  setFixtureModels(availableModels, path === 'read'
    ? { completedModel: nativeDefaultModel }
    : { reroutedModel: nativeDefaultModel, interruptOutcome: 'interrupted' });
  const { id } = chat.create();
  await chat.send(id, '索引故障时的合成问题');
  const restoreIndex = blockIndexWrites();
  try {
    if (path === 'reroute') {
      writeFileSync(rerouteSignal, '');
      await expect.poll(() => readFileSync(nativeRequests, 'utf8')).toContain('turn/interrupt\n');
      expect(await chat.get(id)).toMatchObject({ busy: true, messages: [], error: expect.stringContaining('重启') });
    }
    writeFileSync(resultSignal, '');
    await expect.poll(async () => (await chat.get(id)).busy).toBe(false);
    await expect(chat.send(id, '保存失败后重试')).rejects.toMatchObject({ code: 'CODEX_HISTORY_UNVERIFIED' });
    const result = await chat.get(id);
    expect(result.messages).toEqual([]);
    expect(result.error).toMatch(/未保存.*重启/);
  } finally {
    restoreIndex();
    writeFileSync(resultSignal, '');
  }
  chat.create(); // The next successful index write includes this conversation, too.
  const saved = await chat.get(id);
  expect(saved.error).toContain('已隐藏本轮内容');
  expect(saved.error).not.toContain('未保存');
  await chat.close();
  const reopened = chats = new AgentChat(directory, 'test');
  expect(await reopened.get(id)).toEqual(saved);
});

it('改派标记第一次未保存时，收尾重试保存未确认的拒绝回合', async () => {
  const chat = chats = new AgentChat(directory, 'test');
  setFixtureModels(availableModels, { reroutedModel: nativeDefaultModel, interruptOutcome: 'unconfirmed' });
  const { id } = chat.create();
  await chat.send(id, '短暂索引故障的合成问题');
  const restoreIndex = blockIndexWrites();
  try {
    writeFileSync(rerouteSignal, '');
    await expect.poll(() => readFileSync(nativeRequests, 'utf8')).toContain('turn/interrupt\n');
    expect((await chat.get(id)).error).toContain('未保存');
  } finally {
    restoreIndex();
    writeFileSync(resultSignal, '');
  }
  await expect.poll(async () => (await chat.get(id)).busy).toBe(false);
  await chat.close();
  const reopened = chats = new AgentChat(directory, 'test');
  expect(await reopened.get(id)).toMatchObject({
    messages: [], error: '见岔只允许 gpt-6-luna，已隐藏本轮内容。原生回合结果未确认。',
  });
});
