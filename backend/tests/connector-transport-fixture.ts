import { serve } from '@hono/node-server';
import { appendFileSync } from 'node:fs';
import { createWorkspaceApp } from '../src/mapping/http.js';
import type { lifecycleFixture } from './connector-lifecycle-fixture.js';

export function resource(event: string, fields: Record<string, unknown>) {
  const path = process.env.FORKWISE_ISSUE10_RESOURCE_LOG;
  if (path) appendFileSync(path, JSON.stringify({ at: new Date().toISOString(), event, ownerPid: process.pid, inProcess: true, ...fields }) + '\n');
}
export function connectorTransport(f: ReturnType<typeof lifecycleFixture>) {
  let server: ReturnType<typeof serve> | undefined;
  let origin = '';
  async function start() {
    let app: ReturnType<typeof createWorkspaceApp>;
    server = serve({ hostname: '127.0.0.1', port: 0, fetch: request => app.fetch(request) });
    await new Promise<void>((resolve, reject) => { server!.once('listening', resolve); server!.once('error', reject); });
    const port = (server.address() as { port: number }).port;
    origin = `http://127.0.0.1:${port}`;
    app = createWorkspaceApp(f.mapping, origin, () => new Response(''));
    resource('listening', { kind: 'http-server', port, host: '127.0.0.1' });
  }
  async function close() {
    if (!server) return;
    const current = server; server = undefined;
    const port = (current.address() as { port: number }).port;
    await new Promise<void>((resolve, reject) => current.close(error => {
      resource('close-callback', { kind: 'http-server', port, error: error?.message ?? null });
      if (error) reject(error); else resolve();
    }));
  }
  return { start, close, get origin() { return origin; },
    get: (path: string, token = f.token) => fetch(origin + path, { headers: { Authorization: `Bearer ${token}` } }),
  };
}
