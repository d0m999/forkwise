import { once } from 'node:events';
import { existsSync, lstatSync } from 'node:fs';
import { dirname } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { openTerminalSocket } from '../src/agent-chat/terminal-socket.js';

const active: Awaited<ReturnType<typeof openTerminalSocket>>[] = [];

async function start(...args: Parameters<typeof openTerminalSocket>) {
  const terminal = await openTerminalSocket(...args);
  active.push(terminal);
  return terminal;
}

async function connect(url: string, origin?: string) {
  const options = origin === undefined ? {} : { headers: { Origin: origin } };
  const peer = new WebSocket(url.replace('unix:', 'ws+unix:') + ':/', options);
  await once(peer, 'open');
  return peer;
}

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(active.splice(0).map(terminal => terminal.close()));
});

it('只接受一个无 Origin 的本机终端，断开只清理当前终端的 socket', async () => {
  const closed = vi.fn();
  const otherClosed = vi.fn();
  const terminal = await start(async () => null, closed);
  const other = await start(async () => null, otherClosed);
  expect(terminal.url).toMatch(/^unix:\/\/\/[^\s]+$/);
  const path = terminal.url.slice('unix://'.length);
  expect(lstatSync(dirname(path)).mode & 0o777).toBe(0o700);
  expect(lstatSync(path).isSocket()).toBe(true);
  expect(lstatSync(path).mode & 0o777).toBe(0o600);

  await expect(connect(terminal.url, 'https://fixture.invalid')).rejects.toThrow('Unexpected server response: 403');
  await expect(connect(terminal.url, '')).rejects.toThrow('Unexpected server response: 403');
  const peer = await connect(terminal.url);
  await expect(connect(terminal.url)).rejects.toThrow('Unexpected server response: 403');
  peer.close();
  await expect.poll(() => closed.mock.calls.length).toBe(1);
  await terminal.close();
  expect(closed).toHaveBeenCalledTimes(1);
  expect(existsSync(dirname(path))).toBe(false);

  expect(otherClosed).not.toHaveBeenCalled();
  const otherPeer = await connect(other.url);
  const disconnected = once(otherPeer, 'close');
  await other.close();
  await disconnected;
  expect(otherClosed).toHaveBeenCalledOnce();
});

it('按接收顺序处理原生请求和通知，并使用固定错误响应畸形输入', async () => {
  let releaseFirst = () => {};
  const firstPending = new Promise<void>(resolve => { releaseFirst = resolve; });
  const received: string[] = [];
  const terminal = await start(async (method, params, notify) => {
    received.push(method);
    if (method === 'initialize') await firstPending;
    if (method === 'initialized') notify('fixture/ready', { ready: true });
    if (method === 'fixture/fail') throw new Error('私有错误详情');
    return params;
  }, () => {});
  const peer = await connect(terminal.url);
  const messages: unknown[] = [];
  peer.on('message', data => messages.push(JSON.parse(data.toString())));
  peer.send(JSON.stringify({ id: 0, method: 'initialize', params: { version: 'fixture' } }));
  peer.send(JSON.stringify({ method: 'initialized' }));
  peer.send(JSON.stringify({ jsonrpc: '2.0', id: 'error', method: 'fixture/fail', params: '私有请求详情' }));
  peer.send('{"私有畸形数据"');
  peer.send(JSON.stringify({ jsonrpc: '2.0', id: [], method: 'invalid' }));

  await expect.poll(() => received).toEqual(['initialize']);
  releaseFirst();
  await expect.poll(() => messages).toEqual([
    { id: 0, result: { version: 'fixture' } },
    { method: 'fixture/ready', params: { ready: true } },
    { jsonrpc: '2.0', id: 'error', error: { code: -32000, message: '见岔无法处理此终端请求。' } },
    { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } },
    { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } },
  ]);
  expect(received).toEqual(['initialize', 'initialized', 'fixture/fail']);

  const disconnected = once(peer, 'close');
  peer.send(Buffer.from('{"method":"invalid"}'));
  await expect(disconnected).resolves.toMatchObject([1003, expect.any(Buffer)]);
});

it('开放三分钟且无人连接后清理临时 socket', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  let release = () => {};
  const closed = new Promise<void>(resolve => { release = resolve; });
  const terminal = await start(async () => null, release);
  const path = terminal.url.slice('unix://'.length);
  await vi.advanceTimersByTimeAsync(3 * 60_000 - 1);
  expect(existsSync(path)).toBe(true);
  await vi.advanceTimersByTimeAsync(1);
  await closed;
  await terminal.close();
  expect(existsSync(dirname(path))).toBe(false);
});

it('请求超时返回固定错误并清理连接，队列中的后续请求不再执行', async () => {
  let release = () => {};
  const started = new Promise<void>(resolve => { release = resolve; });
  const handle = vi.fn(async () => {
    release();
    await new Promise<never>(() => {});
  });
  const closed = vi.fn();
  const terminal = await start(handle, closed);
  const peer = await connect(terminal.url);
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const message = once(peer, 'message');
  const disconnected = once(peer, 'close');
  peer.send(JSON.stringify({ id: 0, method: 'turn/start' }));
  peer.send(JSON.stringify({ id: 1, method: 'turn/start' }));

  await started;
  await vi.advanceTimersByTimeAsync(60_000);
  const [raw] = await message;
  expect(JSON.parse(raw.toString())).toMatchObject({ id: 0, error: { code: -32000 } });
  await disconnected;
  await terminal.close();
  expect(closed).toHaveBeenCalledOnce();
  expect(handle).toHaveBeenCalledOnce();
});
