import { chmod, mkdtemp, rmdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import type { Socket } from 'node:net';
import WebSocket, { WebSocketServer } from 'ws';
import { z } from 'zod';

const connectTimeout = 3 * 60_000;
const requestTimeout = 60_000;
const maxPayload = 1024 * 1024;
const incoming = z.object({
  jsonrpc: z.literal('2.0').optional(),
  id: z.union([z.string(), z.int(), z.null()]).optional(),
  method: z.string().min(1),
  params: z.unknown().optional(),
});

type Notify = (method: string, params: unknown) => void;

export async function openTerminalSocket(
  handle: (method: string, params: unknown, notify: Notify) => Promise<unknown>,
  onClose: () => void | Promise<void>,
): Promise<{ url: string; close: () => Promise<void> }> {
  // macOS limits the filesystem address of a Unix socket to about 100 bytes.
  const directory = await mkdtemp('/tmp/forkwise-');
  const path = join(directory, 'codex.sock');
  const sockets = new Set<Socket>();
  const websocket = new WebSocketServer({ noServer: true, clientTracking: false, maxPayload });
  const server = createServer({ headersTimeout: 5_000, connectionsCheckingInterval: 1_000 }, (_request, response) => {
    response.writeHead(404, { Connection: 'close' }).end();
  });
  let client: WebSocket | undefined;
  let closing: Promise<void> | undefined;
  let expires: ReturnType<typeof setTimeout> | undefined;
  let cancelRequest: (() => void) | undefined;
  let ready = false;

  const close = () => closing ??= (async () => {
    clearTimeout(expires);
    cancelRequest?.();
    client?.terminate();
    for (const socket of sockets) socket.destroy();
    websocket.close();
    if (ready) await onClose();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rmdir(directory);
  })();
  const stop = () => { void close().catch(() => {}); };
  server.on('connection', socket => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    if (closing) socket.destroy();
  });
  server.on('upgrade', (request, socket, head) => {
    if (!ready || closing || client || request.headers.origin !== undefined) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    websocket.handleUpgrade(request, socket, head, peer => {
      client = peer;
      clearTimeout(expires);
      peer.on('error', stop);
      peer.once('close', stop);

      let queue = Promise.resolve();
      let pending = 0;
      let version: '2.0' | undefined;
      const send = (message: object) => {
        if (closing || peer.readyState !== WebSocket.OPEN) return;
        if (peer.bufferedAmount > maxPayload) {
          stop();
          return;
        }
        peer.send(JSON.stringify({ jsonrpc: version, ...message }), error => { if (error) stop(); });
      };
      const notify: Notify = (method, params) => {
        try { send({ method, params }); } catch { stop(); }
      };
      const fail = (id: string | number | null, code: number, message: string) => send({ id, error: { code, message } });

      peer.on('message', (raw, binary) => {
        if (binary || pending >= 32) {
          peer.close(binary ? 1003 : 1008);
          return;
        }
        pending++;
        queue = queue.then(async () => {
          if (closing || peer.readyState !== WebSocket.OPEN) return;
          let value: unknown;
          try { value = JSON.parse(raw.toString()); } catch {
            fail(null, -32700, 'Parse error');
            return;
          }
          const request = incoming.safeParse(value);
          if (!request.success) {
            fail(null, -32600, 'Invalid Request');
            return;
          }
          const { jsonrpc, id, method, params } = request.data;
          version = jsonrpc;

          let deadline: ReturnType<typeof setTimeout> | undefined;
          let timedOut = false;
          try {
            const result = await Promise.race([handle(method, params, notify), new Promise<never>((_resolve, reject) => {
              cancelRequest = () => reject(new Error('Terminal connection closed'));
              deadline = setTimeout(() => {
                timedOut = true;
                reject(new Error('Terminal RPC timed out'));
              }, requestTimeout);
            })]);
            if (id !== undefined) send({ id, result: result ?? null });
          } catch {
            if (id !== undefined) fail(id, -32000, '见岔无法处理此终端请求。');
            if (timedOut) peer.close(1011);
          } finally {
            clearTimeout(deadline);
            cancelRequest = undefined;
          }
        }).catch(stop).finally(() => { pending--; });
      });
    });
  });

  try {
    await chmod(directory, 0o700);
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(path, () => {
        server.off('error', reject);
        server.on('error', stop);
        resolve();
      });
    });
    await chmod(path, 0o600);
  } catch (error) {
    await close().catch(() => {});
    throw error;
  }
  expires = setTimeout(stop, connectTimeout);
  ready = true;
  return { url: `unix://${path}`, close };
}
