import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { SECRET_KEYS } from '../src/mapping/secret-keys.js';
import { readZip } from '../src/mapping/zip-store.js';
import { command, contentFixture, patch } from './fixtures/agent-content.js';

it('AC6 按项目时间顺序撤销人类 C、Agent B，且可按顺序重做', async () => {
  const f = await contentFixture();
  expect((await f.post(command('body.edit', f.card().body.versionId, { id: 'card', text: 'A' }))).status).toBe(200);
  const token = f.issue([f.grant()]);
  expect((await f.post(patch(f.card().body.versionId, { text: 'B' }), token)).status).toBe(200);
  expect((await f.post(command('body.edit', f.card().body.versionId, { id: 'card', text: 'C' }))).status).toBe(200);
  const view = await f.request('/api/mapping/projects/p/history', token);
  expect(view.status).toBe(200);
  const visible = await view.json();
  expect(visible.undo.slice(-3).map((entry: { label: string }) => entry.label)).toEqual(['body.edit', 'body.patch', 'body.edit']);
  expect(visible.undo.at(-2)).toMatchObject({ label: 'body.patch', actor: { type: 'agent' }, target: { id: 'card' } });
  expect(visible.undo.at(-2)).not.toHaveProperty('session');
  expect(visible.undo.at(-2)).not.toHaveProperty('tokenHash');
  for (const type of ['history.undo', 'history.redo']) {
    const before = f.snapshot();
    expect(await f.post(command(type, f.history().revision, {}), token)).toMatchObject({
      status: 403, body: { code: 'HUMAN_REQUIRED' },
    });
    expect(f.snapshot()).toEqual(before);
  }
  for (const [type, text] of [['history.undo', 'B'], ['history.undo', 'A'], ['history.redo', 'B'], ['history.redo', 'C']]) {
    const result = await f.post(command(type!, f.history().revision, {}));
    expect(result.status).toBe(200);
    expect(f.card().body.blocks[0]?.text).toBe(text);
  }
});

it('AC6 项目包通过真实 verifier，隔离导入保全正文、对象和历史归档', async () => {
  const source = await contentFixture();
  const token = source.issue([source.grant()]);
  const patched = await source.post(patch(source.card().body.versionId), token);
  expect(patched.status).toBe(200);
  const exportResponse = await source.request(`/api/mapping/projects/p/export.package?revision=${patched.body.revision}`);
  expect(exportResponse.status).toBe(200);
  const bytes = Buffer.from(await exportResponse.arrayBuffer());
  const temp = mkdtempSync(join(tmpdir(), 'forkwise-body-package-'));
  try {
    const packagePath = join(temp, 'body-patch.zip');
    writeFileSync(packagePath, bytes, { mode: 0o600 });
    const verifier = spawnSync('npx', ['tsx', '../scripts/verify-package.ts', packagePath], {
      encoding: 'utf8', timeout: 20_000,
    });
    expect(verifier.status, verifier.error?.message ?? verifier.stdout + verifier.stderr).toBe(0);

    const entries = readZip(bytes);
    const manifest = JSON.parse(entries.get('forkwise-project.json')!.toString('utf8'));
    expect(manifest.mapping.history.undo).toContainEqual(expect.objectContaining({
      label: 'body.patch', actor: expect.objectContaining({ type: 'agent' }),
    }));
    const secretHits: string[] = [];
    const inspect = (value: unknown, path: string) => {
      if (!value || typeof value !== 'object') return;
      for (const [key, entry] of Object.entries(value)) {
        const child = `${path}.${key}`;
        if (SECRET_KEYS.has(key)) secretHits.push(child);
        inspect(entry, child);
      }
    };
    for (const [name, entry] of entries) {
      if (name.endsWith('.json')) inspect(JSON.parse(entry.toString('utf8')), name);
      expect(entry.includes(Buffer.from(token))).toBe(false);
    }
    expect(secretHits).toEqual([]);
    const destination = await contentFixture();
    expect(destination.directory).not.toBe(source.directory);
    const restored = await destination.post(command('project.import', null, {
      name: '正文补丁往返', base64: bytes.toString('base64'),
    }, 'restored'));
    expect(restored).toMatchObject({ status: 200 });
    const contents = (state: ReturnType<typeof source.state>) =>
      state.cards.map(card => ({
        title: card.title, pose: card.item.pose, text: card.body.blocks.map(block => block.text),
      }));
    expect(contents(destination.state('restored'))).toEqual(contents(source.state()));
    expect(destination.history('restored')).toMatchObject({ undo: [], redo: [] });
    const archive = destination.mapping.access.db.prepare(
      'SELECT history FROM mapping_import_archive WHERE project_id=?',
    ).get('restored') as { history: string };
    expect(JSON.parse(archive.history)).toEqual(manifest.mapping.history);
    console.log(`package=${packagePath} verifier_exit_code=${verifier.status} secret_hits=${secretHits.length} import_roundtrip=PASS`);
  } finally {
    rmSync(temp, { recursive: true });
  }
}, 30_000);
