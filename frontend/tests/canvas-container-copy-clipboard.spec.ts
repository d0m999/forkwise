import { expect, test } from './writing-board-fixture';
import { createFrameCommand } from '../src/canvas-frame-commands';
import { canvasClipboardGuard, expectedContainerClipboard } from './container-copy-clipboard-fixture';

test('真实画布剪贴板冻结整组三层Frame，源随后改写和删除仍paste原树，连续落点24px并undo/redo重开', async ({ page, workspace }, info) => {
  const projectId = (await workspace.state()).project.id;
  await workspace.execute(page, { commandId: 'seed-card', projectId, type: 'canvas.paste', expected: null, payload: { translation: { x: 0, y: 0 },
    objects: [{ kind: 'card', copyId: 'frozen-card', stack: 1, title: '冻结研究', blocks: [{ id: 'p', type: 'text', text: '需求增长' }, { id: 'vendor', type: 'vendorWidget', schemaVersion: 7, contentVersion: 'v4', keep: true }],
      tagIds: null, appearance: null, pose: { x: 120, y: 250, width: 280, height: 160 } }], connectors: [] } });
  await workspace.execute(page, { commandId: 'seed-shape', projectId, type: 'shape.create', expected: null, payload: { id: 'frozen-shape', content: { shapeType: 'ellipse', shortText: '说明' }, pose: { x: 450, y: 250, width: 100, height: 60 } } });
  let state = await workspace.state();
  const memberIds = [state.cards[0]!.item.id, state.shapes![0]!.item.id];
  await workspace.execute(page, { commandId: 'seed-group', projectId, type: 'group.create', expected: { groups: { bundle: null }, containment: Object.fromEntries(memberIds.map(id => [id, null])) }, payload: { id: 'bundle', itemIds: memberIds } });
  state = await workspace.state();
  const inner = createFrameCommand(state, [state.groups![0]!.itemId], { x: 80, y: 220, width: 540, height: 260 });
  await workspace.execute(page, inner);
  const middle = createFrameCommand(await workspace.state(), [inner.payload.id], { x: 60, y: 190, width: 600, height: 340 });
  await workspace.execute(page, middle);
  const outer = createFrameCommand(await workspace.state(), [middle.payload.id], { x: 40, y: 160, width: 660, height: 420 });
  await workspace.execute(page, outer);
  await page.reload(); await expect(page.getByRole('status')).toHaveText('已保存到本机');
  await page.getByRole('button', { name: '分区3', exact: true }).click();
  state = await workspace.state();
  const expectedDocument = expectedContainerClipboard(state, [outer.payload.id], [...memberIds, state.groups![0]!.itemId, inner.payload.id, middle.payload.id, outer.payload.id]);
  const raw = JSON.stringify(expectedDocument), text = '冻结研究\n说明\n组合\n分区1\n分区2\n分区3';
  const guard = await canvasClipboardGuard(page, info, projectId, expectedDocument, text, workspace.origin);
  try {
    await page.keyboard.press('Meta+c');
    await expect.poll(async () => page.evaluate(async () => {
      const item = (await navigator.clipboard.read()).find(v => v.types.includes('web application/x-forkwise-canvas'));
      return item ? await (await item.getType('web application/x-forkwise-canvas')).text() : '';
    })).toBe(raw);
    expect(await guard.copied()).toBe(raw);
    // Change the source after C, then remove all its containers and content via
    // public history. The saved clipboard remains the sole paste input.
    const card = state.cards[0]!;
    await workspace.execute(page, { commandId: 'source-later', projectId, type: 'body.edit', expected: card.body.versionId,
      payload: { id: card.id, blocks: card.body.blocks.map(v => v.type === 'text' ? { ...v, text: '需求下降' } : v) } });
    for (let i = 0; i < 7; i++) {
      const current = await workspace.state();
      await workspace.execute(page, { commandId: `remove-source-${i}`, projectId, type: 'history.undo', expected: current.project.revision, payload: {} });
    }
    const empty = await workspace.state(); expect(empty.cards).toHaveLength(0); expect(empty.frames).toHaveLength(0);
    await page.reload(); await expect(page.getByRole('status')).toHaveText('已保存到本机');
    const pane = (await page.locator('.react-flow__pane').boundingBox())!;
    await page.mouse.move(pane.x + 750, pane.y + 470);
    await page.locator('.canvas').press('Meta+v');
    await expect.poll(async () => (await workspace.state()).frames!.length).toBe(3);
    let copied = await workspace.state();
    const copiedCard = copied.cards[0]!, copiedGroup = copied.groups![0]!, copiedFrames = copied.frames!;
    expect(copiedCard.body.blocks[0]!.text).toBe('需求增长');
    expect(copiedCard.body.blocks[1]).toMatchObject({ type: 'vendorWidget', schemaVersion: 7, contentVersion: 'v4', keep: true });
    expect(copiedCard.body.id).not.toBe(card.body.id);
    expect(copiedFrames.map(v => v.name)).toEqual(['分区1', '分区2', '分区3']);
    expect(copied.containment!.find(v => v.id === copiedGroup.itemId)!.parent).toEqual({ kind: 'frame', id: copiedFrames[0]!.id });
    expect(copied.containment!.find(v => v.id === copiedFrames[0]!.id)!.parent).toEqual({ kind: 'frame', id: copiedFrames[1]!.id });
    expect(copied.containment!.find(v => v.id === copiedFrames[1]!.id)!.parent).toEqual({ kind: 'frame', id: copiedFrames[2]!.id });
    await expect.poll(async () => page.locator('[data-frame-id][data-selected=true]').getAttribute('data-frame-id')).toBe(copiedFrames[2]!.id);
    await expect(page.locator('.react-flow__node.selected')).toHaveCount(0);
    await page.locator('.canvas').press('Meta+v');
    await expect.poll(async () => (await workspace.state()).frames!.length).toBe(6);
    copied = await workspace.state();
    expect(copied.cards[1]!.item.pose.x).toBeCloseTo(copiedCard.item.pose.x + 24, 5);
    expect(copied.cards[1]!.item.pose.y).toBeCloseTo(copiedCard.item.pose.y + 24, 5);
    const saved = copied;
    await page.getByRole('button', { name: '撤销', exact: true }).click();
    await expect.poll(async () => (await workspace.state()).frames!.length).toBe(3);
    await page.getByRole('button', { name: '重做', exact: true }).click();
    await expect.poll(async () => (await workspace.state()).frames!.length).toBe(6);
    expect((await workspace.state()).frames!.map(v => v.id)).toEqual(saved.frames!.map(v => v.id));
    await workspace.restart(); await page.reload(); await expect(page.getByRole('status')).toHaveText('已保存到本机');
    const reopened = await workspace.state();
    expect(reopened.cards.map(v => v.body.blocks.map(b => b.text))).toEqual([['需求增长', undefined], ['需求增长', undefined]]);
    expect(reopened.frames!.map(v => v.id)).toEqual(saved.frames!.map(v => v.id));
  } finally { await guard.restore(); }
});
