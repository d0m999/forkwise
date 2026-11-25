import { expect, it } from 'vitest';
import { command, contentFixture, patch } from './fixtures/agent-content.js';

it('授权 Mapping 首写原子保存正文和 160 高度，随动一次且可一并撤销重做和重开读回', async () => {
  const f = await contentFixture();
  const card = f.card();
  f.apply('body.edit', card.body.versionId, {
    id: card.id, blocks: [{ ...card.body.blocks[0]!, text: '' }],
  });
  const empty = f.card();
  f.apply('card.layout', {
    thought: empty.versionId, body: empty.body.versionId, pose: empty.item.versionId, appearance: null,
  }, { id: empty.id, necessaryHeight: 52 });
  const compact = f.card();
  expect(compact.item.pose.height).toBe(52);

  f.apply('text.create', null, {
    id: 'note', content: { runs: [{ text: '随动批注' }], fontSize: 16, lineHeight: 1.5, align: 'left', widthMode: 'fixed', width: 80 },
    pose: { x: 40, y: 130, width: 80, height: 24 },
  });
  const note = () => f.state().texts![0]!;
  f.apply('attachment.attach', {
    attachment: null, target: { itemId: compact.item.id, versionId: compact.item.versionId }, containment: null,
  }, { itemId: note().item.id, targetItemId: compact.item.id });
  const originalNote = note();
  const neighbor = f.card('second');

  const token = f.issue([f.grant({ range: { start: 0, end: 0 } })]);
  const request = patch(compact.body.versionId, { range: { start: 0, end: 0 }, text: '库存回落' });
  const written = await f.post(request, token);
  expect(written.status).toBe(200);
  expect(f.card().body.blocks[0]?.text).toBe('库存回落');
  expect(f.card().item.pose).toEqual({ ...compact.item.pose, height: 160 });
  expect(note().item.pose).toEqual({ ...originalNote.item.pose, y: originalNote.item.pose.y + 54 });
  expect(f.card('second')).toEqual(neighbor);
  const saved = { card: f.card(), note: note(), revision: f.history().revision };
  expect(written.body).toMatchObject({ revision: saved.revision });
  expect(written.body.changedIds).toEqual(expect.arrayContaining([compact.body.id, compact.item.id, originalNote.item.id]));
  expect(f.mapping.observe({ projectId: 'p', afterRevision: saved.revision - 1 }, f.human).changes).toEqual([
    expect.objectContaining({ revision: saved.revision, domains: expect.arrayContaining([
      { id: compact.body.id, domain: 'body' }, { id: compact.item.id, domain: 'pose' }, { id: originalNote.item.id, domain: 'pose' },
    ]) }),
  ]);
  await f.restart();
  expect({ card: f.card(), note: note(), revision: f.history().revision }).toEqual(saved);
  expect(await f.post(request, token)).toEqual(written);
  expect(note()).toEqual(saved.note);

  for (const [type, expectedCard, expectedNote] of [
    ['history.undo', compact, originalNote],
    ['history.redo', saved.card, saved.note],
  ] as const) {
    expect((await f.post(command(type, f.history().revision, {}))).status).toBe(200);
    expect(f.card().body.blocks).toEqual(expectedCard.body.blocks);
    expect(f.card().item.pose).toEqual(expectedCard.item.pose);
    expect(note().item.pose).toEqual(expectedNote.item.pose);
    expect(f.card('second')).toEqual(neighbor);
  }

  const groupedEdit = (text: string) => f.mapping.execute({
    ...command('body.edit', f.card().body.versionId, { id: compact.id, text }),
    editGroup: 'continuous-body-edit',
  }, f.human);
  const actions = f.history().undo.length;
  groupedEdit('继续写，预览高度保持不变');
  expect(note().item.pose).toEqual(saved.note.item.pose);
  groupedEdit('');
  expect(f.history().undo).toHaveLength(actions + 1);
  expect(f.card().item.pose).toEqual(compact.item.pose);
  expect(note().item.pose).toEqual(originalNote.item.pose);
  for (const [type, expectedCard, expectedNote] of [
    ['history.undo', saved.card, saved.note],
    ['history.redo', compact, originalNote],
  ] as const) {
    f.apply(type, f.history().revision, {});
    expect(f.card().body.blocks).toEqual(expectedCard.body.blocks);
    expect(f.card().item.pose).toEqual(expectedCard.item.pose);
    expect(note().item.pose).toEqual(expectedNote.item.pose);
  }
});

it('正文和开启预览保留手调高度以及无高度策略的旧卡兼容下限', async () => {
  const f = await contentFixture();
  for (const id of ['manual', 'legacy']) {
    f.apply('thought.create', null, { id, title: '短标题', text: '', x: 10, y: 20 });
    let card = f.card(id);
    if (id === 'manual') {
      f.apply('pose.batch', { [id]: card.item.versionId }, {
        poses: [{ id, ...card.item.pose, height: 96 }],
      });
    } else {
      // Seed a pre-policy record in this fixture's temporary database.
      delete card.item.heightPolicy;
      card.item.pose.height = 96;
      f.mapping.access.db.prepare('UPDATE mapping_cards SET value=? WHERE project_id=? AND id=?').run(JSON.stringify(card), 'p', id);
    }
    card = f.card(id);
    const appearance = (showPreview: boolean) => f.apply('card.appearance', f.card(id).appearance?.versionId ?? null,
      { id, titleColor: '#edf1fa', showPreview });
    appearance(false);
    f.apply('body.edit', f.card(id).body.versionId, { id, text: '关闭预览也能完整保存正文' });
    const saved = f.card(id);
    expect(saved.item).toEqual(card.item);
    appearance(true);
    expect(f.card(id).body).toEqual(saved.body);
    expect(f.card(id).item).toEqual(card.item);
    f.apply('body.edit', f.card(id).body.versionId, { id, text: '' });
    expect(f.card(id).item).toEqual(card.item);
  }
});

it('重新开启预览保留已保存的非零预留高度', async () => {
  const f = await contentFixture();
  const hidden = f.card();
  f.apply('card.appearance', null, { id: hidden.id, titleColor: '#edf1fa', showPreview: false });
  const existing = f.card();
  existing.item.heightPolicy!.previewFloor = 184;
  existing.item.heightPolicy!.necessaryHeight = 59;
  existing.item.pose.height = 184;
  f.mapping.access.db.prepare('UPDATE mapping_cards SET value=? WHERE project_id=? AND id=?').run(JSON.stringify(existing), 'p', existing.id);
  f.apply('card.appearance', existing.appearance!.versionId, { id: existing.id, titleColor: '#edf1fa', showPreview: true });
  expect(f.card().appearance?.showPreview).toBe(true);
  expect(f.card().body).toEqual(existing.body);
  expect(f.card().item).toEqual(existing.item);
});
