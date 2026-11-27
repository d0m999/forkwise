import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { z } from 'zod';
import { DomainError } from '../domain/errors.js';
import { codexProxyEnvironment } from './mac-proxy.js';

const codexName = '见岔（Forkwise）';
export const codexStorageEnvironment = ['CODEX_HOME', 'CODEX_SQLITE_HOME'] as const;
const accountResult = z.object({ account: z.object({ type: z.string().min(1) }).nullable() });

const rpcMessage = z.object({
  id: z.union([z.number(), z.string()]).optional(),
  result: z.unknown().optional(),
  error: z.unknown().optional(),
  method: z.string().optional(),
  params: z.unknown().optional(),
});

const rpcError = () => new DomainError('CODEX_UNAVAILABLE', '无法连接本机 Codex，请检查安装及网络后重试。', 503);
const rpcTimeout = () => new DomainError('CODEX_TIMEOUT', '本机 Codex 等待超时。请先重新读取原生会话，再决定是否重发。', 503);

export function codexBinary(): string {
  if (process.env.FORKWISE_CODEX_BINARY) return process.env.FORKWISE_CODEX_BINARY;
  const common = [join(homedir(), '.local', 'bin', 'codex'), '/opt/homebrew/bin/codex', '/usr/local/bin/codex'];
  return common.find(existsSync) ?? 'codex';
}

export class CodexConnection {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly exited: Promise<void>;
  private sequence = 0;
  private stopped = false;
  private readonly pending = new Map<number, {
    accept: (value: unknown) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();

  constructor(
    cwd: string,
    onEvent: (method: string, params: unknown) => void,
    onClose: () => void,
  ) {
    const proxy = codexProxyEnvironment();
    // Codex loads its own login and configuration. Workbench credentials
    // and unrelated provider keys stay outside the child environment.
    const env: NodeJS.ProcessEnv = {};
    for (const key of ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'TMPDIR', ...codexStorageEnvironment,
      'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy']) {
      if (proxy[key] !== undefined) env[key] = proxy[key];
    }
    this.child = spawn(codexBinary(), ['app-server', '--listen', 'stdio://'], {
      cwd, env, stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child.stderr.resume();
    this.child.stdin.on('error', () => this.rejectPending(rpcError()));
    this.child.on('error', () => this.rejectPending(rpcError()));
    this.exited = new Promise(resolve => this.child.once('close', () => {
      this.stopped = true;
      this.rejectPending(rpcError());
      onClose();
      resolve();
    }));
    createInterface({ input: this.child.stdout, crlfDelay: Infinity }).on('line', line => {
      let raw: unknown;
      try { raw = JSON.parse(line); } catch { return; }
      const parsed = rpcMessage.safeParse(raw);
      if (!parsed.success) return;
      const { id, method, params, result, error } = parsed.data;
      if (method && id !== undefined) {
        // #72 will present native requests to the user. Until then, deny
        // unsupported requests through the protocol, without approving tools.
        this.write({ id, error: { code: -32601, message: 'This client cannot handle this request.' } });
        return;
      }
      if (method) {
        onEvent(method, params);
        return;
      }
      if (typeof id !== 'number') return;
      const request = this.pending.get(id);
      if (!request) return;
      this.pending.delete(id);
      clearTimeout(request.timer);
      if (error !== undefined) request.reject(rpcError());
      else request.accept(result);
    });
  }

  private rejectPending(error: Error) {
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
  }

  private write(message: object) {
    if (!this.stopped && this.child.stdin.writable) this.child.stdin.write(JSON.stringify(message) + '\n');
  }

  async initialize(version: string) {
    await this.call('initialize', { clientInfo: { name: 'forkwise', title: codexName, version } });
    this.write({ method: 'initialized' });
  }

  async loggedIn() {
    const result = accountResult.safeParse(await this.call('account/read', { refreshToken: false }));
    if (!result.success) throw rpcError();
    return result.data.account !== null;
  }

  call(method: string, params: object): Promise<unknown> {
    if (this.stopped || !this.child.stdin.writable) return Promise.reject(rpcError());
    const id = ++this.sequence;
    return new Promise((accept, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(rpcTimeout());
      }, 30_000);
      this.pending.set(id, { accept, reject, timer });
      this.write({ id, method, params });
    });
  }

  async close() {
    if (!this.stopped) this.child.stdin.end();
    const terminate = setTimeout(() => { if (!this.stopped) this.child.kill('SIGTERM'); }, 1500);
    const kill = setTimeout(() => { if (!this.stopped) this.child.kill('SIGKILL'); }, 3000);
    try { await this.exited; } finally { clearTimeout(terminate); clearTimeout(kill); }
  }
}
