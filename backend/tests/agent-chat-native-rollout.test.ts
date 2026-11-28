import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createReadStream, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { expect, it, onTestFinished, vi } from 'vitest';
import WebSocket from 'ws';
import { AgentChat } from '../src/agent-chat/chat.js';
import { CodexConnection } from '../src/agent-chat/codex.js';

const binary = process.env.FORKWISE_TEST_CODEX_BINARY;
const apiKey = 'synthetic-local-only';

async function executableState(path: string) {
  const target = realpathSync(path);
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(target)) hash.update(chunk);
  return { target, mode: statSync(target).mode & 0o7777, sha256: hash.digest('hex') };
}

function respond(res: ServerResponse, turn: number, quotaPercent?: number) {
  const text = `合成回答 ${turn}`;
  const message = { type: 'message', id: `msg_${turn}`, role: 'assistant', phase: 'final_answer',
    status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] };
  const emit = (type: string, fields: object) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`);
  res.writeHead(200, { 'Content-Type': 'text/event-stream',
    ...(quotaPercent !== undefined ? {
      'x-codex-primary-used-percent': Object.is(quotaPercent, -0) ? '-0' : String(quotaPercent),
      'x-codex-primary-window-minutes': '300',
      'x-codex-primary-reset-at': '1800000000',
      'x-codex-secondary-used-percent': '25', 'x-codex-secondary-window-minutes': '10080', 'x-codex-secondary-reset-at': '1800000100',
    } : {}),
  });
  emit('response.created', { response: { id: `resp_${turn}`, status: 'in_progress' } });
  emit('response.output_item.added', { output_index: 0, item: { ...message, status: 'in_progress', content: [] } });
  emit('response.output_text.delta', { output_index: 0, content_index: 0, item_id: message.id, delta: text });
  emit('response.output_item.done', { output_index: 0, item: message });
  emit('response.completed', { response: { id: `resp_${turn}`, status: 'completed', output: [message],
    usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14 } } });
  res.end();
}

type TerminalFrame = { id?: number; method?: string; result?: unknown; params?: unknown };

async function connectTerminal(chat: AgentChat, id: string) {
  const { command } = await chat.terminal(id);
  const path = /--remote 'unix:\/\/([^']+)'/.exec(command)?.[1];
  expect(path).toBeDefined();
  const socket = new WebSocket(`ws+unix:${path}:/`, { handshakeTimeout: 3_000 });
  const frames: TerminalFrame[] = [];
  socket.on('message', raw => frames.push(JSON.parse(raw.toString()) as TerminalFrame));
  onTestFinished(() => socket.terminate());
  await once(socket, 'open');
  let sequence = 0;
  async function waitFor(predicate: (frame: TerminalFrame) => boolean) {
    return vi.waitFor(() => {
      const frame = frames.find(predicate);
      expect(frame).toBeDefined();
      return frame!;
    }, { timeout: 5_000 });
  }
  const request = (method: string, params: object) => {
    const requestId = ++sequence;
    socket.send(JSON.stringify({ id: requestId, method, params }));
    return waitFor(frame => frame.id === requestId);
  };
  expect(await request('initialize', { clientInfo: { name: 'codex-tui', version: 'test' } })).toHaveProperty('result');
  socket.send(JSON.stringify({ method: 'initialized' }));
  return { request, waitFor };
}

type Scenario = {
  name: string;
  personality?: 'none';
  unspecifiedEffort?: boolean;
  quotaPercent?: number;
  parentShell?: 'absent' | 'different';
  directory?: string;
  terminal?: 'high' | 'interrupt';
  alterRecording?: (recording: string) => string;
};

it.skipIf(!binary).each<Scenario>([
  { name: '默认设置' },
  { name: '无 Personality', personality: 'none' },
  { name: '未指定推理强度', unspecifiedEffort: true },
  { name: '主窗口和次窗口均有配额', quotaPercent: 13.5 },
  { name: '配额百分比使用科学记数法', quotaPercent: 1e-6 },
  { name: '配额百分比使用正指数时可继续发送', quotaPercent: 1e16 },
  { name: '配额百分比保留负零', quotaPercent: -0 },
  { name: '父进程无 SHELL', parentShell: 'absent' },
  { name: '父进程 SHELL 与登录 shell 不一致', parentShell: 'different' },
  { name: '工作目录含 XML 特殊字符', directory: "A&B<C>\"D'" },
  { name: '终端将推理强度从 low 改为 high', terminal: 'high' },
  { name: '终端中断回合', terminal: 'interrupt' },
  { name: '配额记录含重复键时拒绝续发', quotaPercent: 13.5,
    alterRecording: recording => recording.replace('"used_percent":13.5,', '"used_percent":0.0,"used_percent":13.5,') },
  { name: '配额百分比含异常精度时拒绝续发', quotaPercent: 13.5,
    alterRecording: recording => recording.replace('"used_percent":25.0,', '"used_percent":25.0000000000000001,') },
  { name: '调整配额字段顺序后仍拒绝异常百分比格式', quotaPercent: 13.5,
    alterRecording: recording => recording.replace('"used_percent":25.0,"window_minutes":10080,',
      '"window_minutes":10080,"used_percent":25,') },
  { name: '中断标记来自其他回合时拒绝续发', terminal: 'interrupt',
    alterRecording: recording => recording.replace(
      /("turn_id":")[^"]+(","create_time":[^,]+,"content_item_kinds":\["generic\.turn_aborted"\])/,
      '$1foreign-turn$2') },
])('Codex 0.172.0 延迟回读（$name）', async scenario => {
  let loginShell = '';
  try { loginShell = userInfo().shell ?? ''; } catch { /* Numeric UIDs may have no passwd entry. */ }
  const fallbackShells = process.platform === 'darwin' ? ['/bin/zsh', '/bin/bash'] : ['/bin/bash', '/bin/zsh'];
  const shell = loginShell || fallbackShells.find(existsSync) || '/bin/sh';
  const otherShell = shell === '/bin/bash' ? '/bin/zsh' : '/bin/bash';
  const executables = [binary!, process.execPath, shell];
  const before = await Promise.all(executables.map(executableState));
  onTestFinished(async () => expect(await Promise.all(executables.map(executableState))).toEqual(before));
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'fw-native-')));
  onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, 'home'), native = join(root, 'codex'), sqlite = join(root, 'sqlite'), tmp = join(root, 'tmp');
  for (const dir of [home, native, sqlite, tmp]) mkdirSync(dir, { mode: 0o700 });
  onTestFinished(() => { vi.unstubAllEnvs(); });
  // The service may run in UTC while its native child uses the local system zone.
  vi.stubEnv('TZ', 'UTC');
  vi.stubEnv('SHELL', scenario.parentShell === 'absent' ? undefined : scenario.parentShell === 'different' ? otherShell : shell);
  for (const [name, value] of Object.entries({ HOME: home, CODEX_HOME: native, CODEX_SQLITE_HOME: sqlite, TMPDIR: tmp,
    FORKWISE_CODEX_BINARY: realpathSync(binary!) })) vi.stubEnv(name, value);
  for (const name of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY']) {
    const value = name === 'NO_PROXY' ? '127.0.0.1' : 'http://127.0.0.1:1';
    vi.stubEnv(name, value);
    vi.stubEnv(name.toLowerCase(), value);
  }
  expect(execFileSync(binary!, ['--version'], { cwd: root, encoding: 'utf8',
    env: { HOME: home, CODEX_HOME: native, CODEX_SQLITE_HOME: sqlite, TMPDIR: tmp } }).trim()).toBe('codex-cli 0.172.0');

  let requests = 0;
  let release!: () => void;
  const delayedTurn = scenario.terminal ? 2 : 1;
  const delayedReadReady = new Promise<void>(resolve => { release = resolve; });
  const server = createServer(async (req, res) => {
    req.resume();
    if (req.method !== 'POST' || req.url !== '/v1/responses') { res.writeHead(404).end(); return; }
    if (req.headers.authorization !== `Bearer ${apiKey}`) { res.writeHead(401).end(); return; }
    const turn = ++requests;
    if (turn === delayedTurn) await delayedReadReady;
    if (!res.destroyed) respond(res, turn, scenario.quotaPercent);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  onTestFinished(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });
  writeFileSync(join(native, 'auth.json'), JSON.stringify({ auth_mode: 'apikey', OPENAI_API_KEY: apiKey }), { mode: 0o600 });
  writeFileSync(join(native, 'config.toml'), `model = "gpt-6-luna"
model_provider = "synthetic"
${scenario.personality === 'none' ? 'personality = "none"' : ''}
${scenario.unspecifiedEffort ? '' : 'model_reasoning_effort = "low"'}
cli_auth_credentials_store = "file"
[model_providers.synthetic]
name = "Synthetic"
base_url = "http://127.0.0.1:${(server.address() as AddressInfo).port}/v1"
wire_api = "responses"
requires_openai_auth = true
supports_websockets = false
request_max_retries = 0
stream_max_retries = 0
[analytics]
enabled = false
`);

  // Hold the selected response until the same native writer can show its live turn.
  // Deliver that exact snapshot on the first finish read, then pass every RPC through.
  const call = CodexConnection.prototype.call;
  type NativeRead = { thread: { path: string; turns: { id: string; status: string }[] } };
  let stale: { writer: CodexConnection; read: NativeRead } | undefined;
  let delivered = false;
  let starts = 0;
  const spy = vi.spyOn(CodexConnection.prototype, 'call').mockImplementation(async function (this: CodexConnection, method, params) {
    if (method === 'thread/read' && stale?.writer === this && !delivered) {
      delivered = true;
      return stale.read;
    }
    const result = await call.call(this, method, params);
    if (method === 'thread/start' && scenario.unspecifiedEffort) {
      expect(result).toMatchObject({ reasoningEffort: null });
    }
    if (method === 'thread/read' && stale?.writer === this && delivered && scenario.alterRecording) {
      const { thread } = result as NativeRead;
      if (thread.turns.at(-1)?.status !== 'inProgress') {
        await vi.waitFor(() => {
          const recording = readFileSync(thread.path, 'utf8');
          expect(recording.trimEnd().split('\n').at(-1)).toContain(scenario.terminal ? '"turn_aborted"' : '"task_complete"');
          const altered = scenario.alterRecording!(recording);
          expect(altered).not.toBe(recording);
          writeFileSync(thread.path, altered);
        }, { timeout: 10_000 });
      }
    }
    if (method === 'turn/start' && ++starts === delayedTurn) {
      const turnId = (result as { turn: { id: string } }).turn.id;
      const { threadId } = params as { threadId: string };
      await vi.waitFor(async () => {
        const read = await call.call(this, 'thread/read', { threadId, includeTurns: true }) as NativeRead;
        expect(read.thread.turns.at(-1)).toMatchObject({ id: turnId, status: 'inProgress' });
        stale = { writer: this, read };
      }, { timeout: 5_000 });
    }
    return result;
  });
  onTestFinished(() => spy.mockRestore());
  const directory = scenario.directory ? join(root, scenario.directory) : root;
  if (scenario.directory) mkdirSync(directory, { mode: 0o700 });
  const chat = new AgentChat(directory, '0.1.0-fixture');
  onTestFinished(async () => { release(); await chat.close(); });
  const { id } = chat.create();
  const first = await chat.send(id, '合成问题 1');
  if (!scenario.terminal) release();
  await expect.poll(async () => (await chat.get(id)).busy, { timeout: 10_000 }).toBe(false);
  expect(first.threadId).toBeTruthy();
  let terminalCompletion: TerminalFrame | undefined;
  const interrupted = scenario.terminal === 'interrupt';
  if (scenario.terminal) {
    const terminal = await connectTerminal(chat, id);
    expect(await terminal.request('thread/resume', { threadId: first.threadId }))
      .toMatchObject({ result: { thread: { id: first.threadId }, reasoningEffort: 'low' } });
    const start = await terminal.request('turn/start', { threadId: first.threadId,
      ...(scenario.terminal === 'high' ? { effort: 'high' } : {}), input: [{ type: 'text', text: '终端合成问题' }] });
    expect(start).toMatchObject({ result: { turn: { id: expect.any(String) } } });
    const { id: turnId } = (start.result as { turn: { id: string } }).turn;
    if (interrupted) {
      await expect.poll(() => requests, { timeout: 10_000 }).toBe(2);
      expect(await terminal.request('turn/interrupt', { threadId: first.threadId, turnId })).toHaveProperty('result');
    } else {
      release();
    }
    terminalCompletion = await terminal.waitFor(frame => ['turn/completed', 'error'].includes(frame.method ?? ''));
    await expect.poll(async () => (await chat.get(id)).busy, { timeout: 10_000 }).toBe(false);
  }
  expect(delivered).toBe(true);

  const sessions = join(native, 'sessions');
  const files = readdirSync(sessions, { encoding: 'utf8', recursive: true }).filter(file => file.endsWith(`-${first.threadId}.jsonl`));
  expect(files).toHaveLength(1);
  const records = readFileSync(join(sessions, files[0]!), 'utf8').trimEnd().split('\n').map(line => JSON.parse(line));
  expect(records.map(line => line.type)).toEqual(expect.arrayContaining(['world_state', 'turn_context', 'token_usage_record']));
  const tokenCountWithUsage = records.find(line => line.payload.type === 'token_count' && line.payload.info?.last_token_usage);
  expect(tokenCountWithUsage?.payload.info.last_token_usage)
    .toMatchObject({ input_tokens: 10, output_tokens: 4, total_tokens: 14 });
  if (scenario.unspecifiedEffort) expect(records.find(line => line.type === 'turn_context')?.payload).not.toHaveProperty('effort');
  if (scenario.quotaPercent !== undefined) expect(records.find(line => line.payload.type === 'token_count')?.payload.rate_limits)
    .toMatchObject({ primary: { used_percent: scenario.quotaPercent, window_minutes: 300, resets_at: 1800000000 },
      secondary: { used_percent: 25, window_minutes: 10080, resets_at: 1800000100 } });
  if (scenario.terminal === 'high') expect(records.filter(line => line.payload.type === 'thread_settings_applied').at(-1)?.payload)
    .toMatchObject({ thread_settings: { reasoning_effort: 'high' } });
  if (interrupted) expect(records.some(line =>
    line.payload.internal_chat_message_metadata_passthrough?.content_item_kinds.includes('generic.turn_aborted'))).toBe(true);

  const messages = [{ role: 'user', text: '合成问题 1' }, { role: 'assistant', text: '合成回答 1' }];
  if (scenario.terminal) messages.push({ role: 'user', text: '终端合成问题' });
  if (scenario.terminal === 'high') messages.push({ role: 'assistant', text: '合成回答 2' });
  if (scenario.alterRecording) {
    expect(await chat.get(id)).toMatchObject({ error: expect.stringContaining('无法核实来源'), messages });
    await expect(chat.send(id, '来源未知后的合成问题')).rejects.toMatchObject({ code: 'CODEX_HISTORY_UNVERIFIED' });
    expect(requests).toBe(delayedTurn);
    return;
  }
  expect(await chat.get(id)).toMatchObject({ error: interrupted ? '此回合已中断。' : undefined, messages });
  if (scenario.terminal) expect(terminalCompletion).toMatchObject({
    method: 'turn/completed', params: { threadId: first.threadId, turn: { status: interrupted ? 'interrupted' : 'completed' } },
  });

  expect(await chat.send(id, '合成问题 2')).toMatchObject({ threadId: first.threadId });
  await expect.poll(async () => (await chat.get(id)).busy, { timeout: 10_000 }).toBe(false);
  const expectedRequests = scenario.terminal ? 3 : 2;
  expect(await chat.get(id)).toMatchObject({ threadId: first.threadId, error: undefined, messages: [
    ...messages, { role: 'user', text: '合成问题 2' }, { role: 'assistant', text: `合成回答 ${expectedRequests}` },
  ] });
  expect(requests).toBe(expectedRequests);
}, 45_000);
