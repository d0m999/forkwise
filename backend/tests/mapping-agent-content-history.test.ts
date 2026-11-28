import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { SECRET_KEYS } from '../src/mapping/secret-keys.js';
import { readZip } from '../src/mapping/zip-store.js';
import { command, contentFixture, patch } from './fixtures/agent-content.js';

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==';
const imageTask = {
  id: 'image-task', type: 'imageTask', ticket: 'original-image-ticket',
  name: '原图.png', mime: 'image/png', base64: png, byteLength: Buffer.from(png, 'base64').length,
  width: 1, height: 1, status: 'queued',
};

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

it('撤销删除恢复已失败的图片任务后，撤销和重做正文补丁保留该失败状态', async () => {
  const f = await contentFixture();
  const paragraph = f.card().body.blocks[0]!;
  expect((await f.post(command('body.edit', f.card().body.versionId, {
    id: 'card', blocks: [paragraph, imageTask],
  }))).status).toBe(200);
  const token = f.issue([f.grant()]);
  const patchedText = '新文😀e\u0301结束';
  expect((await f.post(patch(f.card().body.versionId), token)).status).toBe(200);
  expect(f.card().body.blocks).toEqual([{ ...paragraph, text: patchedText }, imageTask]);
  expect((await f.post(command('body.edit', f.card().body.versionId, {
    id: 'card', blocks: [{ ...paragraph, text: patchedText }],
  }))).status).toBe(200);

  const history = f.history();
  expect(history.undo.at(-1)?.label).toBe('body.edit');
  expect((await f.post(command('history.undo', history.revision, {}))).status).toBe(200);
  const failedImage = f.card().body.blocks[1];
  expect(failedImage).toMatchObject({ ...imageTask, status: 'failed' });

  await f.restart();
  for (const [direction, text] of [['undo', paragraph.text], ['redo', patchedText]] as const) {
    const current = f.history();
    expect(current[direction].at(-1)?.label).toBe('body.patch');
    expect((await f.post(command(`history.${direction}`, current.revision, {}))).status).toBe(200);
    expect(f.card().body.blocks).toEqual([{ ...paragraph, text }, failedImage]);
  }
  expect(await f.post(command('media.fail', imageTask.ticket, {
    id: 'card', blockId: imageTask.id, reason: '晚到结果',
  }))).toMatchObject({ status: 409, body: { code: 'MEDIA_TASK_STALE' } });
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

it('隔离导入后正文补丁、卡面测量及补丁撤销重做均不激活原媒体票据', async () => {
  const source = await contentFixture();
  const created = await source.post(command('thought.create', null, {
    id: 'media-card', title: '待处理图片卡', text: '正文', x: 40, y: 50,
  }));
  expect(created.status).toBe(200);
  const sourceCard = source.card('media-card');
  expect((await source.post(command('text.create', null, {
    id: 'note', content: { runs: [{ text: '随动批注' }], fontSize: 16, lineHeight: 1.5, align: 'left', widthMode: 'fixed', width: 80 },
    pose: { x: 40, y: 130, width: 80, height: 24 },
  }))).status).toBe(200);
  const sourceNote = source.state().texts![0]!;
  expect((await source.post(command('attachment.attach', {
    attachment: null, target: { itemId: sourceCard.item.id, versionId: sourceCard.item.versionId }, containment: null,
  }, { itemId: sourceNote.item.id, targetItemId: sourceCard.item.id }))).status).toBe(200);
  const saved = await source.post(command('body.edit', sourceCard.body.versionId, {
    id: sourceCard.id, blocks: [...sourceCard.body.blocks, imageTask],
  }));
  expect(saved.status).toBe(200);
  const exported = await source.request(`/api/mapping/projects/p/export.package?revision=${saved.body.revision}`);
  expect(exported.status).toBe(200);
  const destination = await contentFixture();
  const projectId = 'restored';
  const imported = await destination.post(command('project.import', null, {
    name: '隔离恢复', base64: Buffer.from(await exported.arrayBuffer()).toString('base64'),
  }, projectId));
  expect(imported.status).toBe(200);
  const cardId = destination.state(projectId).cards.find(card => card.title === sourceCard.title)!.id;
  const card = () => destination.card(cardId, projectId);
  const note = () => destination.state(projectId).texts![0]!;
  const tickets = () => destination.mapping.access.db.prepare(
    'SELECT ticket, state FROM mapping_media_tickets WHERE project_id=?',
  ).all(projectId);
  expect(tickets()).toEqual([]);
  expect(card().body.blocks[1]).toEqual(imageTask);

  const paragraph = card().body.blocks[0]!;
  const grant = destination.grant({
    projectId, cardId, blockId: paragraph.id, bodyVersionId: card().body.versionId,
    range: { start: 0, end: 2 },
  });
  const token = destination.issue([grant], undefined, [projectId]);
  const result = await destination.post(command('body.patch', grant.bodyVersionId, {
    id: cardId, blockId: grant.blockId, range: grant.range, text: '',
  }, projectId), token);
  expect(result.status).toBe(200);
  const patchedParagraph = { ...paragraph, text: '' };
  expect(card().body.blocks).toEqual([patchedParagraph, imageTask]);
  expect(tickets()).toEqual([]);

  // An intervening edit means the measurement cannot fold into the patch's history entry.
  const { project } = destination.state(projectId);
  expect((await destination.post(command('project.rename', project.versionId, { name: '新名称' }, projectId))).status).toBe(200);
  const measured = card();
  const heightBefore = measured.item.pose.height;
  const heightAfter = 48;
  expect(heightBefore).toBeGreaterThan(heightAfter);
  const beforeNote = note();
  const yBefore = beforeNote.item.pose.y;
  const yAfter = yBefore + (heightAfter - heightBefore) / 2;
  const layout = await destination.post({ ...command('card.layout', {
    thought: measured.versionId, body: measured.body.versionId, pose: measured.item.versionId,
    appearance: measured.appearance?.versionId ?? null, cardTags: measured.cardTags?.versionId ?? null,
  }, { id: cardId, necessaryHeight: heightAfter }, projectId),
    followers: [{ kind: 'text', id: beforeNote.id, itemId: beforeNote.item.id, x: beforeNote.item.pose.x, y: yAfter }],
    expectedFollowers: { [beforeNote.item.id]: beforeNote.item.versionId },
  });
  expect(layout.status).toBe(200);
  expect(card().item.pose.height).toBe(heightAfter);
  expect(note().item.pose.y).toBe(yAfter);
  expect(card().body.blocks).toEqual([patchedParagraph, imageTask]);
  expect(tickets()).toEqual([]);

  await destination.restart();
  for (const [direction, label, expected, height, y] of [
    ['undo', 'card.layout', patchedParagraph, heightBefore, yBefore],
    ['undo', 'project.rename', patchedParagraph, heightBefore, yBefore],
    ['undo', 'body.patch', paragraph, heightBefore, yBefore],
    ['redo', 'body.patch', patchedParagraph, heightBefore, yBefore],
    ['redo', 'project.rename', patchedParagraph, heightBefore, yBefore],
    ['redo', 'card.layout', patchedParagraph, heightAfter, yAfter],
  ] as const) {
    const history = destination.history(projectId);
    const action = history[direction].at(-1)!;
    expect(action.label).toBe(label);
    const travelled = await destination.post(command(`history.${direction}`, history.revision, { actionId: action.id }, projectId));
    expect(travelled.status).toBe(200);
    expect(card().body.blocks).toEqual([expected, imageTask]);
    expect(card().item.pose.height).toBe(height);
    expect(note().item.pose.y).toBe(y);
    expect(tickets()).toEqual([]);
  }
  const before = destination.snapshot(projectId);
  expect(await destination.post(command('media.fail', imageTask.ticket, {
    id: cardId, blockId: imageTask.id, reason: '导入前的请求已结束',
  }, projectId))).toMatchObject({ status: 409, body: { code: 'MEDIA_TASK_STALE' } });
  expect(destination.snapshot(projectId)).toEqual(before);
});
