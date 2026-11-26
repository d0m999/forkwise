import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AgentChat, openAgentChatDirectory } from '../src/agent-chat/chat.js';
import { ChatGptAuthorization } from '../src/agent-chat/siwc.js';
import { DomainError } from '../src/domain/errors.js';
import { createWorkspaceApp } from '../src/mapping/http.js';
import { openMapping } from '../src/mapping/storage.js';

const origin = 'http://127.0.0.1:18923';
let root: string;
let directory: string;
let chats: AgentChat | undefined;
let mapping: ReturnType<typeof openMapping> | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'forkwise-agent-chat-'));
  const workspace = join(root, 'workspace');
  mapping = openMapping(workspace);
  directory = openAgentChatDirectory(workspace);
  const executable = join(root, 'codex-test.mjs');
  writeFileSync(executable, `#!${process.execPath}
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const print = event => process.stdout.write(JSON.stringify(event) + '\\n');
const load = id => JSON.parse(readFileSync(join(process.cwd(), id + '.json'), 'utf8'));
for await (const line of createInterface({input: process.stdin})) {
  const {id, method, params} = JSON.parse(line);
  const respond = result => print({id, result});
  if (method === 'initialize') {
    respond({});
  } else if (method === 'thread/start') {
    const id = randomUUID();
    respond({thread: {id, path: null, turns: [], status: {type: 'idle'}}, model: params.model, modelProvider: params.modelProvider});
  } else if (method === 'thread/resume') {
    respond({thread: load(params.threadId), model: params.model, modelProvider: params.modelProvider});
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
    writeFileSync(path, JSON.stringify({id: threadId, path, turns, status: {type: 'idle'}, model: 'gpt-6.2-sol'}), {mode: 0o600});
    print({method: 'turn/completed', params: {threadId, turn}});
  }
}
`, { mode: 0o700 });
  vi.stubEnv('FORKWISE_CODEX_BINARY', executable);
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
  chats = new AgentChat(directory, 'test', async () => 'synthetic-test-token');
  const first = chats.create();
  expect(await chats.get(first.id)).toMatchObject({ threadId: null, busy: false, messages: [] });
  const started = await chats.send(first.id, '第一个合成问题');
  expect(started.threadId).toEqual(expect.any(String));
  const chat = chats;
  await expect.poll(async () => (await chat.get(first.id)).busy).toBe(false);
  const completed = await chats.get(first.id);
  expect(completed).toMatchObject({ threadId: started.threadId, model: 'gpt-6.2-sol' });
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
  const chat = chats = new AgentChat(directory, 'test', async () => 'synthetic-test-token');
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

it('正式路由要求本人身份，未授权时没有原生进程或项目数据入口', async () => {
  const authorization = new ChatGptAuthorization(directory, origin);
  chats = new AgentChat(directory, 'test', () => authorization.token());
  const app = createWorkspaceApp(mapping!, origin, () => new Response(''), { chat: chats, authorization });
  const agent = mapping!.access.issue('agent', []);
  const human = mapping!.access.issue('human', ['*']);
  const endpoint = '/api/agent-chat';
  expect((await app.request(origin + endpoint + '/status')).status).toBe(401);
  expect((await app.request(origin + endpoint + '/conversations', { headers: { Authorization: 'Bearer ' + agent } })).status).toBe(403);
  const headers = { Origin: origin, Authorization: 'Bearer ' + human, 'Content-Type': 'application/json' };
  const create = await app.request(origin + endpoint + '/conversations', { method: 'POST', headers, body: '{}' });
  const { id } = await create.json() as { id: string };
  const send = await app.request(origin + endpoint + '/conversations/' + id + '/turns', {
    method: 'POST', headers, body: JSON.stringify({ text: '独立测试' }),
  });
  expect(send.status).toBe(401);
  expect(readdirSync(join(directory, 'no-project'))).toEqual([]);
  const invalidCallback = await app.request(origin + '/auth/callback?state=invalid', { headers: { 'Sec-Fetch-Site': 'cross-site' } });
  expect(invalidCallback.status).toBe(303);
  expect(invalidCallback.headers.get('location')).toBe('/auth/result?state=failed');
  expect((await app.request(origin + endpoint + '/status', { headers: { ...headers, 'Sec-Fetch-Site': 'cross-site' } })).status).toBe(403);
  expect((await app.request(origin + endpoint + '/status', { headers })).status).toBe(200);
  await expect(new AgentChat(directory, 'test', async () => {
    throw new DomainError('UNUSED', '未授权', 401);
  }).get(id)).resolves.toMatchObject({ threadId: null, messages: [] });
});
