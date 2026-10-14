import { expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, createConnection, type Socket } from 'node:net';

it('SIGTERM 关闭实际本机服务与已连接但尚未发送HTTP请求的自有socket', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'forkwise-host-close-'));
  const probe = createServer();
  let child: ChildProcess | undefined, socket: Socket | undefined;
  let exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }> | undefined;
  try {
    const port = await new Promise<number>((resolve) =>
      probe.listen(0, '127.0.0.1', () => {
        const p = (probe.address() as { port: number }).port;
        probe.close(() => resolve(p));
      }),
    );
    child = spawn(process.execPath, ['dist/src/workspace-server.js'], {
      env: { ...process.env, FORKWISE_DATA_DIR: directory, FORKWISE_PORT: String(port) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    exit = new Promise((resolve) =>
      child!.once('exit', (code, signal) => resolve({ code, signal })),
    );
    await new Promise<void>((resolve, reject) => {
      child!.once('exit', (code) => reject(new Error('服务提前退出' + code)));
      child!.stdout!.on('data', (b) => {
        if (String(b).includes('开放工作台')) resolve();
      });
      child!.stderr!.on('data', (b) => process.stderr.write(b));
    });
    socket = createConnection({ host: '127.0.0.1', port });
    await new Promise<void>((resolve, reject) => {
      socket!.once('connect', resolve);
      socket!.once('error', reject);
    });
    child.kill('SIGTERM');
    let timer: ReturnType<typeof setTimeout> | undefined;
    const observed = await Promise.race([
      exit,
      new Promise<'STILL_RUNNING'>((resolve) => {
        timer = setTimeout(() => resolve('STILL_RUNNING'), 1500);
      }),
    ]);
    if (timer) clearTimeout(timer);
    expect(observed).toEqual({ code: 0, signal: null });
    expect(socket.destroyed || child.exitCode === 0).toBe(true);
  } finally {
    socket?.destroy();
    if (child?.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    if (exit) await exit;
    if (probe.listening) await new Promise<void>((resolve) => probe.close(() => resolve()));
    rmSync(directory, { recursive: true, force: true });
  }
}, 10000);
