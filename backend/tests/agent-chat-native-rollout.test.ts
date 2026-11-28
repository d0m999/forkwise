import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createReadStream, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, onTestFinished, vi } from 'vitest';
import { AgentChat } from '../src/agent-chat/chat.js';
import { CodexConnection } from '../src/agent-chat/codex.js';

const binary = process.env.FORKWISE_TEST_CODEX_BINARY;
const shell = '/bin/zsh';
const apiKey = 'synthetic-local-only';

async function executableState(path: string) {
  const target = realpathSync(path);
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(target)) hash.update(chunk);
  return { target, mode: statSync(target).mode & 0o7777, sha256: hash.digest('hex') };
}

function respond(res: ServerResponse, turn: number) {
  const text = `合成回答 ${turn}`;
  const message = { type: 'message', id: `msg_${turn}`, role: 'assistant', phase: 'final_answer',
    status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] };
  const emit = (type: string, fields: object) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`);
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  emit('response.created', { response: { id: `resp_${turn}`, status: 'in_progress' } });
  emit('response.output_item.added', { output_index: 0, item: { ...message, status: 'in_progress', content: [] } });
  emit('response.output_text.delta', { output_index: 0, content_index: 0, item_id: message.id, delta: text });
  emit('response.output_item.done', { output_index: 0, item: message });
  emit('response.completed', { response: { id: `resp_${turn}`, status: 'completed', output: [message],
    usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14 } } });
  res.end();
}

it.skipIf(!binary).each(['default', 'none'])('Codex 0.172.0（Personality %s）首轮历史延迟后可在同一会话续发', async personality => {
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
  for (const [name, value] of Object.entries({ HOME: home, CODEX_HOME: native, CODEX_SQLITE_HOME: sqlite, TMPDIR: tmp,
    SHELL: shell, FORKWISE_CODEX_BINARY: realpathSync(binary!) })) vi.stubEnv(name, value);
  for (const name of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY']) {
    const value = name === 'NO_PROXY' ? '127.0.0.1' : 'http://127.0.0.1:1';
    vi.stubEnv(name, value);
    vi.stubEnv(name.toLowerCase(), value);
  }
  expect(execFileSync(binary!, ['--version'], { cwd: root, encoding: 'utf8',
    env: { HOME: home, CODEX_HOME: native, CODEX_SQLITE_HOME: sqlite, TMPDIR: tmp } }).trim()).toBe('codex-cli 0.172.0');

  let requests = 0;
  let release!: () => void;
  const firstReadReady = new Promise<void>(resolve => { release = resolve; });
  const server = createServer(async (req, res) => {
    req.resume();
    if (req.method !== 'POST' || req.url !== '/v1/responses') { res.writeHead(404).end(); return; }
    if (req.headers.authorization !== `Bearer ${apiKey}`) { res.writeHead(401).end(); return; }
    const turn = ++requests;
    if (turn === 1) await firstReadReady;
    respond(res, turn);
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
${personality === 'none' ? 'personality = "none"' : ''}
model_reasoning_effort = "low"
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

  // Hold the first response until the same native writer can show its live turn.
  // Deliver that exact snapshot on the first finish read, then pass every RPC through.
  const call = CodexConnection.prototype.call;
  type NativeRead = { thread: { turns: { id: string; status: string }[] } };
  let stale: { writer: CodexConnection; read: NativeRead } | undefined;
  let delivered = false;
  const spy = vi.spyOn(CodexConnection.prototype, 'call').mockImplementation(async function (this: CodexConnection, method, params) {
    if (method === 'thread/read' && stale?.writer === this && !delivered) {
      delivered = true;
      return stale.read;
    }
    const result = await call.call(this, method, params);
    if (method === 'turn/start' && !stale) {
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
  const chat = new AgentChat(root, '0.1.0-fixture');
  onTestFinished(async () => { release(); await chat.close(); });
  const { id } = chat.create();
  const first = await chat.send(id, '合成问题 1');
  release();
  await expect.poll(async () => (await chat.get(id)).busy, { timeout: 10_000 }).toBe(false);
  expect(delivered).toBe(true);
  expect(first.threadId).toBeTruthy();
  expect(await chat.get(id)).toMatchObject({ error: undefined, messages: [
    { role: 'user', text: '合成问题 1' }, { role: 'assistant', text: '合成回答 1' },
  ] });

  const sessions = join(native, 'sessions');
  const files = readdirSync(sessions, { encoding: 'utf8', recursive: true }).filter(file => file.endsWith(`-${first.threadId}.jsonl`));
  expect(files).toHaveLength(1);
  const records = readFileSync(join(sessions, files[0]!), 'utf8').trimEnd().split('\n').map(line => JSON.parse(line));
  expect(records.map(line => line.type)).toEqual(expect.arrayContaining(['world_state', 'turn_context', 'token_usage_record']));
  expect(records.find(line => line.payload.type === 'token_count')?.payload.info.last_token_usage)
    .toMatchObject({ input_tokens: 10, output_tokens: 4, total_tokens: 14 });

  expect(await chat.send(id, '合成问题 2')).toMatchObject({ threadId: first.threadId });
  await expect.poll(async () => (await chat.get(id)).busy, { timeout: 10_000 }).toBe(false);
  expect(await chat.get(id)).toMatchObject({ threadId: first.threadId, error: undefined, messages: [
    { role: 'user', text: '合成问题 1' }, { role: 'assistant', text: '合成回答 1' },
    { role: 'user', text: '合成问题 2' }, { role: 'assistant', text: '合成回答 2' },
  ] });
  expect(requests).toBe(2);
}, 45_000);
