import { serve } from '@hono/node-server';
import { appendFileSync } from 'node:fs';
import { createWorkspaceApp } from '../src/mapping/http.js';
import type { groupFixture } from './group-fixture.js';
export function protocolResource(event: string) {
  const log = process.env.FORKWISE_ISSUE28_RESOURCE_LOG;
  if (log) appendFileSync(log, JSON.stringify({ event, pid: process.pid, at: new Date().toISOString() }) + '\n');
}
export function groupHttp(f: ReturnType<typeof groupFixture>) {
  let server: ReturnType<typeof serve> | undefined, origin = '';
  const token = f.mapping.access.issue('human', ['*']);
  return {
    get origin() { return origin; },
    async start() {
      let app: ReturnType<typeof createWorkspaceApp>;
      server = serve({ hostname: '127.0.0.1', port: 0, fetch: request => app.fetch(request) });
      await new Promise<void>((resolve, reject) => { server!.once('listening', resolve); server!.once('error', reject); });
      origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      app = createWorkspaceApp(f.mapping, origin, () => new Response(''));
      protocolResource('group-http-listening');
    },
    async close() {
      if (!server) return;
      const current = server; server = undefined;
      await new Promise<void>((resolve, reject) => current.close(error => error ? reject(error) : resolve()));
      protocolResource('group-http-closed');
    },
    get(path: string, auth = token) { return fetch(origin + path, { headers: { Authorization: `Bearer ${auth}` } }); },
  };
}
