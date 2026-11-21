import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';

it.each(['数据目录', 'local-access.json', 'session.key'])(
  '旧服务在创建进程锁及恢复数据库之前拒绝权限过宽的%s',
  (entry) => {
    const root = mkdtempSync(join(tmpdir(), 'forkwise-legacy-startup-'));
    const directory = join(root, 'data');
    try {
      mkdirSync(directory, { mode: 0o700 });
      const accessPath = join(directory, 'local-access.json');
      const keyPath = join(directory, 'session.key');
      const fixtureKey = Buffer.alloc(32, 1);
      writeFileSync(accessPath, 'fixture', { mode: 0o600 });
      writeFileSync(keyPath, fixtureKey, { mode: 0o600 });
      // A pending, invalid restore record keeps this fixture from activating any database.
      writeFileSync(join(directory, 'restore-activation.json'), '{}', { mode: 0o600 });
      const path = entry === '数据目录' ? directory : join(directory, entry);
      const mode = entry === '数据目录' ? 0o755 : 0o644;
      chmodSync(path, mode);
      const entries = readdirSync(directory).sort();

      const result = spawnSync(process.execPath, ['--import', 'tsx', 'src/server.ts'], {
        env: { PATH: process.env.PATH, FORKWISE_DATA_DIR: directory },
        encoding: 'utf8',
        timeout: 10_000,
      });

      expect(result.status, result.error?.message).toBe(1);
      expect(result.stderr).toContain(entry + '必须');
      expect(readdirSync(directory).sort()).toEqual(entries);
      expect(lstatSync(path).mode & 0o777).toBe(mode);
      expect(readFileSync(accessPath, 'utf8')).toBe('fixture');
      expect(readFileSync(keyPath).equals(fixtureKey)).toBe(true);
    } finally {
      rmSync(root, { recursive: true });
    }
  },
);

it('旧服务首次启动生成私有凭证，带原数据库和旧配置重开时沿用密钥并更新入口', async () => {
  const root = mkdtempSync(join(tmpdir(), 'forkwise-legacy-reopen-'));
  const directory = join(root, 'data');
  try {
    const probe = createServer();
    probe.listen(0, '127.0.0.1');
    await once(probe, 'listening');
    const port = (probe.address() as AddressInfo).port;
    const closed = once(probe, 'close');
    probe.close();
    await closed;
    const origin = `http://127.0.0.1:${port}`;
    const accessPath = join(directory, 'local-access.json');
    const keyPath = join(directory, 'session.key');
    let priorToken: string | undefined;
    let priorKey: Buffer | undefined;
    for (let start = 0; start < 2; start++) {
      const server = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], {
        env: { PATH: process.env.PATH, FORKWISE_DATA_DIR: directory, FORKWISE_PORT: String(port) },
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 8_000,
        killSignal: 'SIGKILL',
      });
      const exit = once(server, 'exit');
      try {
        const [message] = await Promise.race([
          once(server.stdout, 'data'),
          exit.then(() => {
            throw new Error('旧服务启动提前退出');
          }),
        ]);
        expect(String(message)).toContain('后端已监听');
        await vi.waitFor(
          async () => {
            const response = await fetch(origin, {
              headers: { Connection: 'close' },
              signal: AbortSignal.timeout(3_000),
            });
            expect(response.status).toBe(200);
            await response.arrayBuffer();
          },
          { timeout: 3_000 },
        );
      } finally {
        server.kill('SIGTERM');
        await exit;
      }
      expect(server.exitCode).toBe(0);

      expect(lstatSync(directory).mode & 0o777).toBe(0o700);
      expect(lstatSync(accessPath).mode & 0o777).toBe(0o600);
      expect(lstatSync(keyPath).mode & 0o777).toBe(0o600);
      expect(existsSync(join(directory, 'server.pid'))).toBe(false);
      const access = JSON.parse(readFileSync(accessPath, 'utf8'));
      expect(access.origin).toBe(origin);
      expect(typeof access.token === 'string' && access.token.length > 0).toBe(true);
      expect(access.url === `${origin}/#token=${access.token}`).toBe(true);
      expect(access.token !== priorToken).toBe(true);
      const key = readFileSync(keyPath);
      expect(key.length).toBe(32);
      if (priorKey) expect(key.equals(priorKey)).toBe(true);
      priorKey = key;
      priorToken = access.token;
      if (start === 0) writeFileSync(join(directory, 'metrics.json'), '["样例"]', { mode: 0o600 });
    }
  } finally {
    rmSync(root, { recursive: true });
  }
}, 20_000);
