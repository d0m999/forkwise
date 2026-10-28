import { test, expect, type Workspace } from './writing-board-fixture';
import type { Page, Locator } from '@playwright/test';
import type { ProjectState } from '../src/api';
import { fiveMembers } from './group-selection-fixture';
import { trustedMouse, nodePoint, history, zoom } from './group-gesture-fixture';

function members(state: ProjectState) {
  return [...state.cards, ...(state.texts ?? []), ...(state.shapes ?? []), ...(state.images ?? []), ...(state.strokes ?? [])];
}

async function moveAndCheck(page: Page, workspace: Workspace, before: ProjectState, timeline: any,
  anchor: Locator, itemIds: string[], dx: number, dy: number, type: 'canvas.move-selection' | 'pose.move', far = false, groupMove = false) {
  const commands: any[] = [];
  page.on('request', request => { if (request.url().endsWith('/api/mapping/execute') && request.method() === 'POST') commands.push(request.postDataJSON()); });
  const origin = members(before), expectedPoses = origin.map(value => itemIds.includes(value.item.id)
    ? { ...value.item.pose, x: value.item.pose.x + dx, y: value.item.pose.y + dy } : value.item.pose);
  expect(await zoom(page)).toBe(1);
  const box = (await anchor.boundingBox())!, point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  const mouse = await trustedMouse(page);
  try {
    await mouse.start(point); await mouse.move({ x: point.x + dx, y: point.y + dy });
    for (const [index, value] of origin.entries()) {
      await expect.poll(async () => (await nodePoint(page, value.item.id)).x).toBeCloseTo(expectedPoses[index]!.x, 4);
      await expect.poll(async () => (await nodePoint(page, value.item.id)).y).toBeCloseTo(expectedPoses[index]!.y, 4);
    }
    if (far) {
      expect(before.groups![0]!.bounds).toEqual({ x: 100, y: 120, width: 780, height: 420 });
      await expect.poll(() => page.getByRole('group', { name: '组合', exact: true })
        .evaluate(el => Number.parseFloat((el as HTMLElement).style.width))).toBe(1200);
    }
    expect(await workspace.state()).toEqual(before); expect(commands).toEqual([]);
    await mouse.up({ x: point.x + dx, y: point.y + dy }); await mouse.trace();
  } finally { await mouse.close(); }
  await expect.poll(async () => members(await workspace.state()).map(value => value.item.pose)).toEqual(expectedPoses);
  await expect(page.getByRole('status')).toHaveText('已保存到本机');
  const after = await workspace.state();
  for (const [index, value] of members(after).entries()) {
    const old = origin[index]!;
    if (itemIds.includes(value.item.id)) {
      expect(value.item.versionId).not.toBe(old.item.versionId);
      expect(value).toEqual({ ...old, item: { ...old.item, versionId: value.item.versionId, pose: expectedPoses[index] } });
    } else expect(value).toEqual(old);
  }
  expect(after.containment).toEqual(before.containment);
  expect(after.groups!.map(({ bounds, ...group }) => group)).toEqual(before.groups!.map(({ bounds, ...group }) => group));
  if (far) expect(after.groups![0]!.bounds).toEqual({ x: 100, y: 120, width: 1180, height: 420 });
  if (groupMove) expect(after.groups![0]!.bounds).toEqual({ x: 140, y: 140, width: 780, height: 420 });
  expect(after.project.revision).toBe(before.project.revision + 1); expect(commands).toHaveLength(1);
  expect(commands[0].type).toBe(type);
  if (type === 'canvas.move-selection') {
    expect(commands[0].payload).toEqual({ groupIds: groupMove ? ['selection-group'] : [], directItemIds: groupMove ? [] : itemIds, dx, dy });
    expect(commands[0].expected).toEqual({ groups: groupMove ? { 'selection-group': before.groups![0]!.versionId } : {},
      containment: Object.fromEntries(itemIds.map(id => [id, before.containment!.find(value => value.id === id)!.versionId])),
      poses: Object.fromEntries(itemIds.map(id => [id, origin.find(value => value.item.id === id)!.item.versionId])) });
  }
  expect((await history(page, workspace, before.project.id)).undo).toHaveLength(timeline.undo.length + 1);
  await expect(page.locator('.react-flow__node.selected')).toHaveCount(itemIds.length);
  for (const id of itemIds) await expect(page.locator('.react-flow__node[data-id="' + id + '"]')).toHaveClass(/selected/);
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect.poll(async () => members(await workspace.state()).map(value => value.item.pose)).toEqual(origin.map(value => value.item.pose));
  const undone = await workspace.state();
  expect(undone.containment).toEqual(before.containment); expect(undone.groups).toEqual(before.groups);
  await page.getByRole('button', { name: '重做', exact: true }).click();
  await expect.poll(async () => members(await workspace.state()).map(value => value.item.pose)).toEqual(expectedPoses);
  const redone = await workspace.state();
  for (const [index, value] of members(redone).entries()) {
    const old = origin[index]!;
    expect(value).toEqual({ ...old, item: { ...old.item, versionId: value.item.versionId, pose: expectedPoses[index] } });
  }
  expect(redone.containment).toEqual(before.containment);
  expect(commands.map(command => command.type)).toEqual([type, 'history.undo', 'history.redo']);
}

for (const kind of ['card', 'text', 'shape', 'image', 'stroke'] as const) {
  test(`成员移动${kind}：完成直选后只移动该成员并一次撤销重做`, async ({ page, workspace }) => {
    const { items, visuals, before, timeline } = await fiveMembers(page, workspace);
    await visuals[kind].click(); await expect(page.locator('.react-flow__node.selected')).toHaveCount(5);
    await visuals[kind].click(); await expect(page.locator('.react-flow__node.selected')).toHaveCount(1);
    await expect(page.locator('.react-flow__node[data-id="' + items[kind].item.id + '"]')).toHaveClass(/selected/);
    expect(await workspace.state()).toEqual(before);
    await moveAndCheck(page, workspace, before, timeline, visuals[kind], [items[kind].item.id], 40, 20, 'canvas.move-selection');
  });
}

test('成员移动Stroke与Card：Shift直选混合只移动二者', async ({ page, workspace }) => {
  const { items, visuals, before, timeline } = await fiveMembers(page, workspace);
  await visuals.stroke.click(); await expect(page.locator('.react-flow__node.selected')).toHaveCount(5);
  await visuals.stroke.click(); await expect(page.locator('.react-flow__node.selected')).toHaveCount(1);
  await visuals.card.click({ modifiers: ['Shift'] }); await expect(page.locator('.react-flow__node.selected')).toHaveCount(2);
  for (const value of [items.stroke, items.card]) await expect(page.locator('.react-flow__node[data-id="' + value.item.id + '"]')).toHaveClass(/selected/);
  expect(await workspace.state()).toEqual(before);
  await moveAndCheck(page, workspace, before, timeline, visuals.card, [items.stroke.item.id, items.card.item.id], 40, 20, 'canvas.move-selection');
});

for (const input of ['menu-stroke', 'menu-shape', 'selected-stroke-to-shape'] as const) {
  test(`捕获Step2 ${input}：未选成员直接起拖定位完整Group`, async ({ page, workspace }) => {
    const { items, visuals, before, timeline } = await fiveMembers(page, workspace);
    if (input === 'selected-stroke-to-shape') {
      await visuals.stroke.click(); await expect(page.locator('.react-flow__node.selected')).toHaveCount(5);
      await visuals.stroke.click(); await expect(page.locator('.react-flow__node.selected')).toHaveCount(1);
      await expect(page.locator('.react-flow__node[data-id="' + items.stroke.item.id + '"]')).toHaveClass(/selected/);
    } else {
      await visuals.shape.click(); await page.getByRole('button', { name: '进入组合', exact: true }).click();
      await expect(page.locator('.react-flow__node.selected')).toHaveCount(0);
    }
    expect(await workspace.state()).toEqual(before);
    const anchor = input === 'menu-stroke' ? visuals.stroke : visuals.shape;
    await moveAndCheck(page, workspace, before, timeline, anchor, Object.values(items).map(value => value.item.id), 40, 20,
      'canvas.move-selection', false, true);
    await expect(page.getByRole('group', { name: '组合', exact: true })).toHaveAttribute('data-selected', 'true');
  });
}

test('捕获Step2 menu-empty取消：恢复零选择和entered，尾随move/up无效且独立click只选成员', async ({ page, workspace }) => {
  const { items, visuals, before, timeline } = await fiveMembers(page, workspace);
  await visuals.shape.click(); await page.getByRole('button', { name: '进入组合', exact: true }).click();
  await expect(page.locator('.react-flow__node.selected')).toHaveCount(0);
  const commands: any[] = [];
  page.on('request', request => { if (request.url().endsWith('/api/mapping/execute') && request.method() === 'POST') commands.push(request.postDataJSON()); });
  expect(await zoom(page)).toBe(1);
  const box = (await visuals.stroke.boundingBox())!, point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  const mouse = await trustedMouse(page);
  try {
    await mouse.start(point); await mouse.move({ x: point.x + 40, y: point.y + 20 });
    for (const value of Object.values(items)) {
      await expect.poll(async () => (await nodePoint(page, value.item.id)).x).toBeCloseTo(value.item.pose.x + 40, 4);
      await expect.poll(async () => (await nodePoint(page, value.item.id)).y).toBeCloseTo(value.item.pose.y + 20, 4);
    }
    await expect(page.locator('.react-flow__node.selected')).toHaveCount(5);
    expect(await workspace.state()).toEqual(before); expect(commands).toEqual([]);
    await page.keyboard.press('Escape');
    await expect(page.locator('.react-flow__node.selected')).toHaveCount(0);
    for (const value of Object.values(items)) await expect.poll(() => nodePoint(page, value.item.id)).toEqual({ x: value.item.pose.x, y: value.item.pose.y });
    expect(await workspace.state()).toEqual(before); expect(commands).toEqual([]);
    await mouse.move({ x: point.x + 90, y: point.y + 60 }); await mouse.up({ x: point.x + 90, y: point.y + 60 });
    const trace = await page.evaluate(() => (window as typeof window & { issue28MouseTrace: { type: string; buttons: number; trusted: boolean }[] }).issue28MouseTrace);
    console.log('ISSUE28_CAPTURE_CANCEL_TRACE', JSON.stringify(trace));
    expect(trace.every(event => event.trusted)).toBe(true);
    expect(trace.filter(event => event.type === 'mousemove' && event.buttons === 1)).toHaveLength(2);
  } finally { await mouse.close(); }
  await expect(page.locator('.react-flow__node.selected')).toHaveCount(0);
  for (const value of Object.values(items)) await expect.poll(() => nodePoint(page, value.item.id)).toEqual({ x: value.item.pose.x, y: value.item.pose.y });
  expect(await workspace.state()).toEqual(before); expect(commands).toEqual([]);
  expect(await history(page, workspace, before.project.id)).toEqual(timeline);
  await visuals.shape.click();
  await expect(page.locator('.react-flow__node.selected')).toHaveCount(1);
  await expect(page.locator('.react-flow__node[data-id="' + items.shape.item.id + '"]')).toHaveClass(/selected/);
  await expect(page.getByRole('group', { name: '组合', exact: true })).toHaveAttribute('data-selected', 'false');
  expect(await workspace.state()).toEqual(before); expect(commands).toEqual([]);
  expect(await history(page, workspace, before.project.id)).toEqual(timeline);
});

test('成员移动Shape远离外框：保归属内容顺序并扩张派生bounds', async ({ page, workspace }) => {
  const { items, visuals, before, timeline } = await fiveMembers(page, workspace);
  await visuals.shape.click(); await visuals.shape.click();
  await expect(page.locator('.react-flow__node.selected')).toHaveCount(1);
  expect(before.shapes![0]!.item.pose).toEqual({ x: 720, y: 120, width: 160, height: 100 });
  await moveAndCheck(page, workspace, before, timeline, visuals.shape, [items.shape.item.id], 400, 0, 'canvas.move-selection', true);
});

test('旧Stroke直选后从looseCard直接起拖沿原owner，不先click替换选择', async ({ page, workspace }) => {
  const { visuals } = await fiveMembers(page, workspace);
  const projectId = (await workspace.state()).project.id;
  const layout = page.waitForResponse(response => response.url().endsWith('/api/mapping/execute') && response.request().postDataJSON()?.type === 'card.layout' && response.request().postDataJSON()?.payload.id === 'loose-fallback-card');
  await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'thought.create', expected: null,
    payload: { id: 'loose-fallback-card', title: '原owner独立卡', text: '原owner正文', x: 1020, y: 600 } });
  await page.reload(); expect((await layout).status()).toBe(200);
  await expect(page.getByRole('status')).toHaveText('已保存到本机');
  const card = page.getByRole('button', { name: '原owner独立卡', exact: true }); await expect(card).toBeVisible();
  const before = await workspace.state(), loose = before.cards.find(value => value.id === 'loose-fallback-card')!;
  expect(loose.item.pose).toMatchObject({ x: 1020, y: 600 });
  expect(before.containment!.some(value => value.id === loose.item.id)).toBe(false);
  const timeline = await history(page, workspace, projectId);
  await visuals.stroke.click(); await expect(page.locator('.react-flow__node.selected')).toHaveCount(5);
  await visuals.stroke.click(); await expect(page.locator('.react-flow__node.selected')).toHaveCount(1);
  await expect(page.getByRole('button', { name: '选择普通笔笔迹', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await moveAndCheck(page, workspace, before, timeline, card, [loose.item.id], -80, -40, 'pose.move');
});
