import { test, expect, type Workspace } from './writing-board-fixture';
import type { Page } from '@playwright/test';
import { createCanvas } from '../../backend/node_modules/@napi-rs/canvas/index.js';

test('混合多选建成持久组合，组外点成员选整组并一次原子拖动，同快照重开保留边界', async ({ page, workspace }) => {
  const projectId = (await workspace.state()).project.id;
  await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'thought.create', expected: null,
    payload: { id: 'group-card', title: '组内卡片', text: '独立正文保留', x: 100, y: 160 } });
  await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'shape.create', expected: null,
    payload: { id: 'group-shape', content: { shapeType: 'ellipse', shortText: '组内形状' }, pose: { x: 420, y: 200, width: 180, height: 100 } } });
  await page.reload(); await expect(page.getByRole('status')).toHaveText('已保存到本机');
  const card = page.getByRole('button', { name: '组内卡片', exact: true });
  const shape = page.getByRole('img', { name: '组内形状', exact: true });
  await expect(card).toBeVisible(); await expect(shape).toBeVisible();
  const ready = await workspace.state();
  expect(ready.cards.map(c => c.id)).toEqual(['group-card']);
  expect(ready.shapes!.map(s => s.id)).toEqual(['group-shape']);
  await shape.click(); await card.click({ modifiers: ['Shift'] });
  await expect(page.locator('.react-flow__node.selected')).toHaveCount(2);
  await page.getByRole('button', { name: '组合所选对象', exact: true }).click();
  await expect.poll(async () => (await workspace.state()).groups?.length).toBe(1);
  const grouped = await workspace.state(), group = grouped.groups![0]!;
  expect(group.memberItemIds).toEqual([grouped.cards[0]!.item.id, grouped.shapes![0]!.item.id]);
  expect(group.id).not.toBe(group.itemId);
  const outline = page.getByRole('group', { name: '组合', exact: true });
  await expect(outline).toHaveCount(1);
  await expect(page.getByRole('button', { name: '进入组合', exact: true })).toBeVisible();
  await page.locator('.react-flow__pane').click({ position: { x: 900, y: 500 } });
  await shape.click();
  await expect(page.locator('.react-flow__node.selected')).toHaveCount(2);
  await expect(page.getByRole('button', { name: '进入组合', exact: true })).toBeVisible();
  const writes: any[] = [];
  page.on('request', request => {
    if (request.url().endsWith('/api/mapping/execute') && request.method() === 'POST') writes.push(request.postDataJSON());
  });
  const zoom = await page.locator('.react-flow__viewport').evaluate(el => new DOMMatrix(getComputedStyle(el).transform).a);
  expect(zoom).toBe(1);
  const box = (await shape.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 80, box.y + box.height / 2 + 50, { steps: 5 });
  for (const value of [grouped.cards[0]!, grouped.shapes![0]!]) {
    const node = page.locator('.react-flow__node[data-id="' + value.item.id + '"]');
    await expect.poll(() => node.evaluate(el => new DOMMatrix(getComputedStyle(el).transform).e)).toBeCloseTo(value.item.pose.x + 80, 4);
  }
  expect(await workspace.state()).toEqual(grouped);
  await page.mouse.up();
  await expect.poll(async () => (await workspace.state()).shapes![0]!.item.pose.x).toBe(500);
  await expect(page.getByRole('status')).toHaveText('已保存到本机');
  const moved = await workspace.state();
  expect(moved.cards[0]!.item.pose).toEqual({ ...grouped.cards[0]!.item.pose, x: 180, y: 210 });
  expect(moved.project.revision).toBe(grouped.project.revision + 1);
  expect(writes).toHaveLength(1);
  expect(writes[0]).toMatchObject({ type: 'canvas.move-selection', payload: { groupIds: [group.id], directItemIds: [], dx: 80, dy: 50 } });
  expect(moved.containment).toEqual(grouped.containment);
  await page.reload(); await expect(outline).toHaveCount(1);
  expect(await workspace.state()).toEqual(moved);
});

test('单Shape五步80px拖动沿原shape owner保留完整pointerdown位移', async ({ page, workspace }) => {
  const projectId = (await workspace.state()).project.id;
  await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'shape.create', expected: null,
    payload: { id: 'single-shape', content: { shapeType: 'rectangle', shortText: '单独移动形状' }, pose: { x: 300, y: 180, width: 180, height: 100 } } });
  await page.reload(); await expect(page.getByRole('status')).toHaveText('已保存到本机');
  const visual = page.getByRole('img', { name: '单独移动形状', exact: true });
  await visual.click();
  const before = await workspace.state();
  expect(before.shapes).toHaveLength(1);
  expect(before.shapes![0]!.item.pose).toEqual({ x: 300, y: 180, width: 180, height: 100 });
  const writes: any[] = [];
  page.on('request', request => { if (request.url().endsWith('/api/mapping/execute') && request.method() === 'POST') writes.push(request.postDataJSON()); });
  const box = (await visual.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 80, box.y + box.height / 2 + 50, { steps: 5 });
  const node = page.locator('.react-flow__node[data-id="' + before.shapes![0]!.item.id + '"]');
  await expect.poll(() => node.evaluate(el => new DOMMatrix(getComputedStyle(el).transform).e)).toBeCloseTo(380, 4);
  await expect.poll(() => node.evaluate(el => new DOMMatrix(getComputedStyle(el).transform).f)).toBeCloseTo(230, 4);
  expect(await workspace.state()).toEqual(before);
  await page.mouse.up();
  await expect.poll(async () => (await workspace.state()).shapes![0]!.item.pose).toEqual({ x: 380, y: 230, width: 180, height: 100 });
  expect(writes).toHaveLength(1); expect(writes[0].type).toBe('shape.move');
});

for (const kind of ['card', 'text', 'image', 'cards'] as const) {
  test(`旧${kind}保存owner五步完整位移，一次提交并撤销重做保内容`, async ({ page, workspace }) => {
    const projectId = (await workspace.state()).project.id;
    const execute = (type: string, payload: unknown) => workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type, expected: null, payload });
    if (kind === 'card' || kind === 'cards') {
      await execute('thought.create', { id: 'one', title: '单卡一', text: '保留原正文', x: 100, y: 160 });
      if (kind === 'cards') await execute('thought.create', { id: 'two', title: '单卡二', text: '第二段原文', x: 500, y: 160 });
    } else if (kind === 'text') {
      await execute('text.create', { id: 'one', content: { runs: [{ text: '单独移动文字' }], fontSize: 18, lineHeight: 1.5,
        align: 'left', widthMode: 'fixed', width: 180 }, pose: { x: 300, y: 180, width: 180, height: 27 } });
    } else {
      await execute('asset.save', { id: 'asset', name: '单独移动图片.png', mime: 'image/png', base64: createCanvas(2, 3).toBuffer('image/png').toString('base64') });
      await execute('image.create', { id: 'one', content: { assetId: 'asset', crop: { x: 0, y: 0, width: 1, height: 1 } }, pose: { x: 300, y: 180, width: 180, height: 100, rotation: 90 } });
    }
    const layouts = (kind === 'card' || kind === 'cards') ? ['one', ...(kind === 'cards' ? ['two'] : [])].map(id =>
      page.waitForResponse(response => response.url().endsWith('/api/mapping/execute') && response.request().postDataJSON()?.type === 'card.layout' && response.request().postDataJSON()?.payload.id === id)) : [];
    await page.reload();
    for (const layout of layouts) expect((await layout).status()).toBe(200);
    await expect(page.getByRole('status')).toHaveText('已保存到本机');
    const visual = kind === 'text' ? page.getByText('单独移动文字', { exact: true }) : kind === 'image'
      ? page.getByRole('img', { name: '单独移动图片.png', exact: true }) : page.getByRole('button', { name: '单卡一', exact: true });
    await visual.click();
    if (kind === 'cards') await page.getByRole('button', { name: '单卡二', exact: true }).click({ modifiers: ['Shift'] });
    await expect(page.locator('.react-flow__node.selected')).toHaveCount(kind === 'cards' ? 2 : 1);
    const before = await workspace.state(), members = (s: typeof before) => [...s.cards, ...(s.texts ?? []), ...(s.images ?? [])];
    expect(members(before).map(v => [v.id, v.item.pose.x, v.item.pose.y])).toEqual(kind === 'cards' ? [['one', 100, 160], ['two', 500, 160]] : [['one', kind === 'card' ? 100 : 300, kind === 'card' ? 160 : 180]]);
    const writes: any[] = [];
    page.on('request', request => { if (request.url().endsWith('/api/mapping/execute') && request.method() === 'POST') writes.push(request.postDataJSON()); });
    const box = (await visual.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 80, box.y + box.height / 2 + 50, { steps: 5 });
    for (const value of members(before)) {
      const node = page.locator('.react-flow__node[data-id="' + value.item.id + '"]');
      await expect.poll(() => node.evaluate(el => new DOMMatrix(getComputedStyle(el).transform).e)).toBeCloseTo(value.item.pose.x + 80, 4);
      await expect.poll(() => node.evaluate(el => new DOMMatrix(getComputedStyle(el).transform).f)).toBeCloseTo(value.item.pose.y + 50, 4);
    }
    expect(await workspace.state()).toEqual(before);
    await page.mouse.up();
    await expect.poll(async () => members(await workspace.state()).map(v => [v.item.pose.x, v.item.pose.y])).toEqual(members(before).map(v => [v.item.pose.x + 80, v.item.pose.y + 50]));
    await expect(page.getByRole('status')).toHaveText('已保存到本机');
    expect(writes).toHaveLength(1);
    expect(writes[0].type).toBe(kind === 'image' ? 'canvas.move' : kind === 'text' ? 'text.move' : kind === 'card' ? 'pose.move' : 'pose.batch');
    await page.getByRole('button', { name: '撤销', exact: true }).click();
    await expect.poll(async () => members(await workspace.state()).map(v => v.item.pose)).toEqual(members(before).map(v => v.item.pose));
    await page.getByRole('button', { name: '重做', exact: true }).click();
    await expect.poll(async () => members(await workspace.state()).map(v => [v.item.pose.x, v.item.pose.y])).toEqual(members(before).map(v => [v.item.pose.x + 80, v.item.pose.y + 50]));
    const final = await workspace.state();
    for (const value of members(final)) {
      const origin = members(before).find(v => v.id === value.id)!;
      expect(value).toEqual({ ...origin, item: { ...origin.item, versionId: value.item.versionId, pose: { ...origin.item.pose, x: origin.item.pose.x + 80, y: origin.item.pose.y + 50 } } });
    }
  });
}

async function pointerGroup(page: Page, workspace: Workspace) {
  const projectId = (await workspace.state()).project.id;
  const execute = (type: string, payload: unknown, expected: unknown = null) => workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type, expected, payload });
  await execute('thought.create', { id: 'pointer-card', title: '指针卡片', text: '保留原文', x: 100, y: 160 });
  await execute('shape.create', { id: 'pointer-shape', content: { shapeType: 'ellipse', shortText: '指针形状' }, pose: { x: 420, y: 200, width: 180, height: 100 } });
  const initial = await workspace.state(), ids = [initial.cards[0]!.item.id, initial.shapes![0]!.item.id];
  await execute('group.create', { id: 'pointer-group', itemIds: ids }, { groups: { 'pointer-group': null }, containment: Object.fromEntries(ids.map(id => [id, null])) });
  const layout = page.waitForResponse(r => r.url().endsWith('/api/mapping/execute') && r.request().postDataJSON()?.type === 'card.layout');
  await page.reload(); expect((await layout).status()).toBe(200);
  await expect(page.getByRole('status')).toHaveText('已保存到本机');
  const visual = page.getByRole('img', { name: '指针形状', exact: true }); await visual.click();
  await expect(page.locator('.react-flow__node.selected')).toHaveCount(2);
  const before = await workspace.state();
  expect(before.groups![0]!.memberItemIds).toEqual(ids);
  expect(before.cards[0]!.item.pose).toMatchObject({ x: 100, y: 160 });
  expect(before.shapes![0]!.item.pose).toEqual({ x: 420, y: 200, width: 180, height: 100 });
  return { visual, before };
}

for (const zoomed of [false, true]) {
  test(`Group单步大位移在${zoomed ? '缩小后' : 'zoom1'}保完整delta，取消尾随与零位移不写`, async ({ page, workspace }) => {
    const { visual, before } = await pointerGroup(page, workspace);
    const zoomValue = () => page.locator('.react-flow__viewport').evaluate(el => {
      const getMap = (el as Element & { computedStyleMap?: () => { get(name: string): unknown } }).computedStyleMap;
      if (typeof getMap !== 'function') throw new Error('当前浏览器无法提供TypedOM缩放测量');
      const value = getMap.call(el).get('transform') as { toMatrix?: () => DOMMatrix } | undefined;
      if (!value || typeof value.toMatrix !== 'function') throw new Error('viewport变换没有TypedOM矩阵');
      const zoom = value.toMatrix().a;
      if (!Number.isFinite(zoom) || zoom <= 0) throw new Error('viewport缩放测量无效');
      return zoom;
    });
    let zoom = await zoomValue();
    if (zoomed) {
      await page.getByRole('button', { name: '缩小', exact: true }).click();
      let previous = 1, stable = 0;
      await expect.poll(async () => { zoom = await zoomValue(); stable = Math.abs(previous - zoom) < 1e-9 ? stable + 1 : 0; previous = zoom; return zoom < 1 && stable >= 2; }).toBe(true);
    } else expect(zoom).toBe(1);
    const box = (await visual.boundingBox())!, x = box.x + box.width / 2, y = box.y + box.height / 2;
    await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.move(x + 120, y + 75, { steps: 1 });
    for (const value of [before.cards[0]!, before.shapes![0]!]) {
      const node = page.locator('.react-flow__node[data-id="' + value.item.id + '"]');
      await expect.poll(() => node.evaluate(el => new DOMMatrix(getComputedStyle(el).transform).e)).toBeCloseTo(value.item.pose.x + 120 / zoom, 4);
      await expect.poll(() => node.evaluate(el => new DOMMatrix(getComputedStyle(el).transform).f)).toBeCloseTo(value.item.pose.y + 75 / zoom, 4);
    }
    expect(await workspace.state()).toEqual(before); await page.mouse.up();
    await expect.poll(async () => (await workspace.state()).cards[0]!.item.pose.x).toBeCloseTo(100 + 120 / zoom, 4);
    await expect(page.getByRole('status')).toHaveText('已保存到本机');
    const moved = await workspace.state(); expect(moved.project.revision).toBe(before.project.revision + 1);
    await page.getByRole('button', { name: '撤销', exact: true }).click();
    await expect.poll(async () => (await workspace.state()).cards[0]!.item.pose.x).toBe(100);
    await page.getByRole('button', { name: '重做', exact: true }).click();
    await expect.poll(async () => (await workspace.state()).cards[0]!.item.pose.x).toBeCloseTo(moved.cards[0]!.item.pose.x, 4);
    await expect(page.getByRole('status')).toHaveText('已保存到本机');
    const saved = await workspace.state(), next = (await visual.boundingBox())!, start = { x: next.x + next.width / 2, y: next.y + next.height / 2 };
    const writes: unknown[] = [];
    page.on('request', request => { if (request.url().endsWith('/api/mapping/execute') && request.method() === 'POST') writes.push(request.postDataJSON()); });
    await page.mouse.move(start.x, start.y); await page.mouse.down(); await page.mouse.move(start.x + 32, start.y + 24, { steps: 2 });
    await page.keyboard.press('Escape'); await page.mouse.move(start.x + 50, start.y + 40); await page.mouse.up();
    expect(await workspace.state()).toEqual(saved); expect(writes).toEqual([]);
    await expect(page.locator('.react-flow__node.selected')).toHaveCount(2);
    const zero = (await visual.boundingBox())!, zx = zero.x + zero.width / 2, zy = zero.y + zero.height / 2;
    await page.mouse.move(zx, zy); await page.mouse.down(); await page.mouse.move(zx + 20, zy + 10); await page.mouse.move(zx, zy); await page.mouse.up();
    expect(await workspace.state()).toEqual(saved); expect(writes).toEqual([]);
  });
}
