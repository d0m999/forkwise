import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serve } from '@hono/node-server';
import { afterEach } from 'vitest';
import type { CommitOptions } from '../../src/mapping/mapping.js';
import { createWorkspaceApp } from '../../src/mapping/http.js';
import { openMapping } from '../../src/mapping/storage.js';
import type { ContentDelegation, LayoutDelegation } from '../../src/services/access.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

export function grant(projectId = 'p', fields: Partial<ContentDelegation> = {}): ContentDelegation {
  return {
    projectId, operations: ['body.patch'], objectKinds: ['card'],
    objectIds: ['card'], blockIds: ['paragraph'], ...fields,
  };
}

export function command(type: string, expected: unknown, payload: unknown, projectId = 'p') {
  return { type, projectId, commandId: randomUUID(), expected, payload };
}

export function patch(expected: string, fields: Record<string, unknown> = {}) {
  return {
    ...command('body.patch', expected, undefined),
    payload: { id: 'card', blockId: 'paragraph', range: { start: 0, end: 1 }, text: '新', ...fields },
  };
}

function openDisk(directory: string, checkpoint: CommitOptions['checkpoint']) {
  return openMapping(directory, checkpoint ? { checkpoint } : {});
}

export async function contentFixture(checkpoint?: CommitOptions['checkpoint']) {
  const directory = mkdtempSync(join(tmpdir(), 'forkwise-body-patch-'));
  let mapping = openDisk(directory, checkpoint);
  let app: ReturnType<typeof createWorkspaceApp>;
  let origin: string;
  let server: ReturnType<typeof serve>;
  async function start() {
    server = serve({ hostname: '127.0.0.1', port: 0, fetch: (request) => app.fetch(request) });
    await once(server, 'listening');
    origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    app = createWorkspaceApp(mapping, origin, () => new Response(''));
  }
  async function stop() {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
      if ('closeAllConnections' in server) server.closeAllConnections();
    });
    mapping.close();
  }
  await start();
  cleanups.push(async () => {
    await stop();
    rmSync(directory, { recursive: true });
  });
  const humanToken = mapping.access.issue('human', ['*']);
  const human = mapping.access.authenticate(humanToken);
  async function request(path: string, token = humanToken, body?: unknown) {
    return fetch(origin + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${token}`, Origin: origin, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }
  async function post(body: unknown, token = humanToken) {
    const response = await request('/api/mapping/execute', token, body);
    return { status: response.status, body: await response.json() };
  }
  const state = (projectId = 'p') => mapping.read({ type: 'project', projectId }, human);
  const card = (id = 'card', projectId = 'p') => state(projectId).cards.find((entry) => entry.id === id)!;
  const history = (projectId = 'p') => mapping.read({ type: 'history', projectId }, human);
  const apply = (type: string, expected: unknown, payload: unknown, projectId = 'p') =>
    mapping.execute(command(type, expected, payload, projectId), human);
  for (const [projectId, id, blockId] of [['p', 'card', 'paragraph'], ['p', 'second', 'second-block'], ['q', 'foreign', 'foreign-block']]) {
    if (projectId === 'q' || id === 'card') apply('project.create', null, { name: projectId }, projectId);
    apply('thought.create', null, { id, title: `卡片 ${id}`, text: '', x: 40, y: 50 }, projectId);
    apply('body.edit', card(id, projectId).body.versionId,
      { id, blocks: [{ id: blockId, type: 'text', text: '中文😀e\u0301结束' }] }, projectId);
  }
  const snapshot = (projectId = 'p') => ({
    state: state(projectId),
    history: history(projectId),
    receipts: mapping.access.db
      .prepare('SELECT command_id, receipt FROM mapping_receipts WHERE project_id=? ORDER BY command_id')
      .all(projectId),
    changes: mapping.access.db
      .prepare('SELECT revision, receipt FROM mapping_changes WHERE project_id=? ORDER BY revision')
      .all(projectId),
    versions: mapping.access.db.prepare(
      'SELECT domain, id, version_id FROM mapping_versions WHERE project_id=? ORDER BY domain, id, version_id',
    ).all(projectId),
  });
  return {
    directory, humanToken, human, state, card, history, apply, snapshot, post, request,
    get mapping() { return mapping; },
    get origin() { return origin; },
    issue(content?: ContentDelegation[], layout?: LayoutDelegation[], projects = ['p'], ttl = 60_000) {
      return mapping.access.issue('agent', projects, ttl, randomUUID(), projects, layout, content);
    },
    async restart() {
      await stop();
      mapping = openDisk(directory, checkpoint);
      await start();
    },
  };
}

export type ContentFixture = Awaited<ReturnType<typeof contentFixture>>;
