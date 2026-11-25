import { test, expect, place } from './writing-board-fixture';
import type { Page } from '@playwright/test';
import type { Command, Receipt } from '../../backend/src/mapping/contracts';

function holdFirstBody(page: Page, cardId: string) {
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  let started = false;
  let receipt: Receipt | undefined;
  const installed = page.route('**/api/mapping/execute', async route => {
    const command = route.request().postDataJSON() as Command;
    if (command.type !== 'body.edit' || command.payload.id !== cardId || started) return route.continue();
    started = true;
    await pending;
    const response = await route.fetch();
    receipt = await response.json();
    await route.fulfill({ response });
  });
  return { installed, release, started: () => started, receipt: () => receipt };
}

for (const kind of ['shape', 'image', 'stroke'] as const) {
  test(`首写随动期间直接删除附着${kind}只采用本次正文回执中的布局版本`, async ({ page, workspace }) => {
    await place(page, '短标题', 40, 95);
    const original = await workspace.state(), projectId = original.project.id, card = original.cards[0]!;
    const write = (type: string, payload: unknown, expected: unknown = null) =>
      workspace.execute(page, { commandId: crypto.randomUUID(), type, projectId, expected, payload });
    const pose = { x: 380, y: 270, width: 160, height: 64 };
    if (kind === 'shape') await write('shape.create', { id: 'annotation', content: { shapeType: 'rectangle', shortText: '附着形状' }, pose });
    if (kind === 'image') {
      const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="64"><rect width="160" height="64"/></svg>';
      await write('asset.save', { id: 'annotation-image', name: '附着图片.svg', mime: 'image/svg+xml', base64: Buffer.from(svg).toString('base64') });
      await write('image.create', { id: 'annotation', content: { assetId: 'annotation-image', crop: { x: 0, y: 0, width: 1, height: 1 } }, pose: { ...pose, rotation: 0 } });
    }
    if (kind === 'stroke') await write('stroke.create', { id: 'annotation', content: { penKind: 'pen',
      path: [{ x: 0, y: 1 }, { x: 150, y: 1 }], color: '#252430', width: 2, opacity: 1 }, pose });
    const key = { shape: 'shapes', image: 'images', stroke: 'strokes' }[kind] as 'shapes' | 'images' | 'strokes';
    const value = (await workspace.state())[key]![0]!;
    await write('attachment.attach', { itemId: value.item.id, targetItemId: card.item.id }, {
      attachment: null, target: { itemId: card.item.id, versionId: card.item.versionId }, containment: null,
    });
    if (kind !== 'stroke') await write('connector.create', { id: 'incident', path: 'straight',
      start: { kind: 'bound', itemId: value.item.id, side: 'right' }, end: { kind: 'bound', itemId: card.item.id, side: 'left' } });
    await page.reload();
    await page.locator('.thought-card').getByRole('button', { name: '编辑正文', exact: true }).click();
    if (kind === 'stroke') await page.getByRole('button', { name: '选择普通笔笔迹', exact: true }).press('Enter');
    else await page.getByRole('img', { name: kind === 'shape' ? '附着形状' : '附着图片.svg', exact: true }).click();
    const label = { shape: '删除形状', image: '删除图片', stroke: '删除笔迹' }[kind];
    const remove = page.getByRole('button', { name: label, exact: true });
    await expect(remove).toBeVisible();
    const before = await workspace.state(), gate = holdFirstBody(page, card.id);
    await gate.installed;
    try {
      await page.getByRole('textbox', { name: '卡片正文', exact: true }).fill('第一段正文');
      await expect.poll(gate.started).toBe(true);
      const response = page.waitForResponse(r => r.url().endsWith('/api/mapping/execute') && r.request().postDataJSON()?.type === kind + '.delete');
      await remove.click();
      expect((await workspace.state())[key]).toEqual(before[key]);
      gate.release();
      const saved = await response;
      expect(saved.status()).toBe(200);
      const deletion = saved.request().postDataJSON();
      const derived = gate.receipt()!.derivedPoseVersions![value.item.id]!;
      expect(derived.before).toBe(value.item.versionId);
      expect(deletion.expected.pose).toBe(derived.after);
      if (kind !== 'stroke') expect(deletion.expected.connectors).toEqual({ incident: before.connectors![0]!.versionId });
      const after = await workspace.state();
      expect(after[key]).toEqual([]);
      expect(after.connectors).toEqual([]);
      expect(after.cards[0]!.item.pose.height).toBe(160);
      expect(after.cards[0]!.body.blocks[0]!.text).toBe('第一段正文');
    } finally { gate.release(); await page.unrouteAll({ behavior: 'wait' }); }
  });
}

test('首写等待回执时向下拉伸卡片，以派生高度为基准且批注只按两次中心变化移动', async ({ page, workspace }) => {
  await place(page, '短标题');
  const state = await workspace.state(), projectId = state.project.id, card = state.cards[0]!;
  await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'shape.create', expected: null,
    payload: { id: 'follower', content: { shapeType: 'rectangle', shortText: '随动' }, pose: { x: 420, y: 310, width: 150, height: 90 } } });
  const follower = (await workspace.state()).shapes![0]!;
  await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'attachment.attach',
    expected: { attachment: null, target: { itemId: card.item.id, versionId: card.item.versionId }, containment: null },
    payload: { itemId: follower.item.id, targetItemId: card.item.id } });
  await page.reload();
  await page.locator('.thought-card').getByRole('button', { name: '编辑正文', exact: true }).click();
  const gate = holdFirstBody(page, card.id);
  await gate.installed;
  try {
    await page.getByRole('textbox', { name: '卡片正文', exact: true }).fill('先保存正文');
    await expect.poll(gate.started).toBe(true);
    await page.getByRole('button', { name: '调整卡片尺寸：下', exact: true }).press('ArrowDown');
    expect((await workspace.state()).cards[0]!.item.pose).toEqual(card.item.pose);
    gate.release();
    await expect(page.getByRole('status')).toHaveText('已保存到本机');
    const after = await workspace.state();
    expect(after.cards[0]!.item.pose).toEqual({ ...card.item.pose, height: 170 });
    expect(after.cards[0]!.item.heightPolicy?.manualHeight).toBe(170);
    expect(after.shapes![0]!.item.pose).toEqual({
      ...follower.item.pose, y: follower.item.pose.y + (170 - card.item.pose.height) / 2,
    });
    expect(after.attachments?.[0]?.target?.itemId).toBe(card.item.id);
  } finally { gate.release(); await page.unrouteAll({ behavior: 'wait' }); }
});

for (const peer of [false, true]) {
  test(peer ? '第三方移动位于捕获和本次首写之间时，首写回执不能跨过第三方版本' :
      '首写发生在另一张卡时取消过期放置依赖但保留实际移动目标', async ({ page, workspace }) => {
    await place(page, '写字板卡', 70, 105);
    await place(page, '另一张卡', 405, 275);
    const before = await workspace.state(), projectId = before.project.id;
    const owner = before.cards.find(card => card.title === '写字板卡')!;
    const target = peer ? owner : before.cards.find(card => card.title === '另一张卡')!;
    await page.locator(`.react-flow__node[data-id="${owner.item.id}"]`).getByRole('button', { name: '编辑正文', exact: true }).click();
    const gate = holdFirstBody(page, owner.id);
    await gate.installed;
    try {
      await page.getByRole('textbox', { name: '卡片正文', exact: true }).fill('等待确认的首写');
      await expect.poll(gate.started).toBe(true);
      await page.locator(`.react-flow__node[data-id="${target.item.id}"]`)
        .getByRole('button', { name: '移动卡片：方向键调整位置', exact: true }).press('ArrowRight');
      const overwrite = { x: target.item.pose.x + 50, y: target.item.pose.y + 25 };
      if (peer) await workspace.execute(page, { commandId: crypto.randomUUID(), type: 'pose.move', projectId,
        expected: target.item.versionId, payload: { id: target.id, ...overwrite } });
      gate.release();
      if (peer) await expect(page.getByRole('alert')).toContainText('布局已更新');
      else await expect(page.getByRole('status')).toHaveText('已保存到本机');
      const result = await workspace.state();
      const updated = result.cards.find(card => card.id === target.id)!;
      expect(result.cards.find(card => card.id === owner.id)!.item.pose.height).toBe(160);
      expect(updated.item.pose).toEqual(peer
        ? { ...target.item.pose, ...overwrite, height: 160 }
        : { ...target.item.pose, x: target.item.pose.x + 10 });
    } finally { gate.release(); await page.unrouteAll({ behavior: 'wait' }); }
  });
}
