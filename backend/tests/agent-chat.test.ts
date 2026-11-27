import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AgentChat, openAgentChatDirectory } from '../src/agent-chat/chat.js';
import { createWorkspaceApp } from '../src/mapping/http.js';
import { openMapping } from '../src/mapping/storage.js';

const origin = 'http://127.0.0.1:18923';
const endpoint = origin + '/api/agent-chat';
const model = 'codex-fixture-model';
let root: string;
let directory: string;
let nativeHome: string;
let nativeAccount: string;
let chats: AgentChat | undefined;
let mapping: ReturnType<typeof openMapping> | undefined;

beforeEach(() => {
  root = mkdtempSync(join(realpathSync(tmpdir()), 'forkwise-agent-chat-'));
  const workspace = join(root, 'workspace');
  mapping = openMapping(workspace);
  directory = openAgentChatDirectory(workspace);
  nativeHome = join(root, 'codex');
  nativeAccount = join(nativeHome, 'native-account.json');
  mkdirSync(nativeHome, { mode: 0o700 });
  writeFileSync(nativeAccount, JSON.stringify({ expiresAt: Date.now() + 60_000 }), { mode: 0o600 });
  const executable = join(root, 'codex-test.mjs');
  writeFileSync(executable, `#!${process.execPath}
import assert from 'node:assert/strict';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
assert.deepEqual(process.argv.slice(2), ['app-server', '--listen', 'stdio://']);
assert.equal(process.env.CODEX_HOME, ${JSON.stringify(nativeHome)});
assert.equal(process.env.ACCESS_TOKEN, undefined);
assert.equal(process.env.OPENAI_API_KEY, undefined);
const accountPath = join(process.env.CODEX_HOME, 'native-account.json');
const model = ${JSON.stringify(model)};
const print = event => process.stdout.write(JSON.stringify(event) + '\\n');
const load = id => JSON.parse(readFileSync(join(process.cwd(), id + '.json'), 'utf8'));
let authenticated = false;
for await (const line of createInterface({input: process.stdin})) {
  const {id, method, params} = JSON.parse(line);
  const respond = result => print({id, result});
  if (method === 'initialize') {
    writeFileSync(join(process.env.CODEX_HOME, 'started'), '');
    respond({});
  } else if (method === 'account/read') {
    assert.deepEqual(params, { refreshToken: false });
    authenticated = existsSync(accountPath) &&
      JSON.parse(readFileSync(accountPath, 'utf8')).expiresAt > Date.now();
    respond({ account: authenticated ? { type: 'chatgpt', email: 'fixture@example.com', planType: 'plus' } : null });
  } else if (method === 'thread/start') {
    assert.equal(authenticated, true);
    assert.deepEqual(params, { cwd: process.cwd() });
    const id = randomUUID();
    respond({thread: {id, path: null, turns: [], status: {type: 'idle'}}, model});
  } else if (method === 'thread/resume') {
    assert.equal(authenticated, true);
    assert.deepEqual(params, { threadId: params.threadId, excludeTurns: true, cwd: process.cwd() });
    respond({thread: load(params.threadId), model});
  } else if (method === 'thread/read') {
    respond({thread: load(params.threadId)});
  } else if (method === 'turn/start') {
    const threadId = params.threadId;
    const path = join(process.cwd(), threadId + '.json');
    let turns = [];
    try { turns = load(threadId).turns; } catch {}
    const turnId = randomUUID();
    const itemId = randomUUID();
    respond({turn: {id: turnId, status: 'inProgress'}});
    print({method: 'item/agentMessage/delta', params: {threadId, itemId, delta: '合成回答'}});
    const turn = {id: turnId, status: 'completed', items: [
      {id: randomUUID(), type: 'userMessage', content: params.input},
      {id: itemId, type: 'agentMessage', text: '合成回答'}
    ]};
    turns.push(turn);
    writeFileSync(path, JSON.stringify({id: threadId, path, turns, status: {type: 'idle'}, model}), {mode: 0o600});
    print({method: 'turn/completed', params: {threadId, turn}});
  }
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
  expect(await emptyStatus.json()).toEqual({ loggedIn: false, message: expect.stringContaining('codex login') });

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
  expect(await loginStatus.json()).toEqual({ loggedIn: true });
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
  expect(await expiredStatus.json()).toEqual({ loggedIn: false, message: expect.stringContaining('codex login') });
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
