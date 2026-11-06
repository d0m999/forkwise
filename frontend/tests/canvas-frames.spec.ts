import { test, expect, type Workspace } from './writing-board-fixture';
import type { Page } from '@playwright/test';
import { createFrameCommand } from '../src/canvas-frame-commands';

test('创作工具拖出空分区，默认名称、透明细边和无卡片控件', async ({ page, workspace }) => {
  await page.getByRole('button', { name: '分区', exact: true }).click();
  await expect(page.getByRole('button', { name: '分区', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('button', { name: '选择', exact: true })).toHaveAttribute('aria-pressed', 'false');
  const pane = page.locator('.react-flow__pane');
  const bounds = (await pane.boundingBox())!;
  await page.mouse.move(bounds.x + 620, bounds.y + 150);
  await page.mouse.down();
  await page.mouse.move(bounds.x + 960, bounds.y + 430, { steps: 6 });
  await page.mouse.up();

  await expect.poll(async () => (await workspace.state()).frames?.length).toBe(1);
  const created = (await workspace.state()).frames![0]!;
  expect(created).toMatchObject({ name: '分区1', background: null, memberItemIds: [] });
  const frame = page.getByRole('group', { name: '分区：分区1', exact: true });
  await expect(frame).toBeVisible();
  await expect(frame).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  await expect(frame).toHaveCSS('border-top-width', '1px');
  await expect(frame).toHaveCSS('overflow', 'visible');
  await expect(frame.getByRole('button', { name: '分区1', exact: true })).toBeVisible();
  await expect(frame.getByRole('button', { name: '编辑正文', exact: true })).toHaveCount(0);
  await expect(frame.locator('.card-resize')).toHaveCount(0);
  expect(await workspace.state()).toMatchObject({ cards: [] });
});

test('分区中文名称和背景经 frame.edit 保存，Enter 返回名称焦点并重开保持', async ({ page, workspace }) => {
  await page.getByRole('button', { name: '分区', exact: true }).click();
  const bounds = (await page.locator('.react-flow__pane').boundingBox())!;
  await page.mouse.move(bounds.x + 620, bounds.y + 150);
  await page.mouse.down();
  await page.mouse.move(bounds.x + 960, bounds.y + 430, { steps: 6 });
  await page.mouse.up();
  await expect.poll(async () => (await workspace.state()).frames?.length).toBe(1);

  const before = (await workspace.state()).frames![0]!;
  const writes: any[] = [];
  page.on('request', request => {
    if (request.url().endsWith('/api/mapping/execute') && request.method() === 'POST') writes.push(request.postDataJSON());
  });
  const trigger = page.getByRole('button', { name: '分区1', exact: true });
  await trigger.dblclick();
  const name = page.getByRole('textbox', { name: '分区名称', exact: true });
  await expect(name).toBeFocused();
  await name.fill('行业研究');
  await page.getByRole('textbox', { name: '分区背景', exact: true }).fill('#eef2ff');
  await name.press('Enter');
  await expect(name).toHaveCount(0);
  await expect(page.getByRole('button', { name: '行业研究', exact: true })).toBeFocused();
  await expect(page.getByRole('status')).toHaveText('已保存到本机');
  const edited = (await workspace.state()).frames![0]!;
  expect(edited).toMatchObject({ name: '行业研究', background: '#eef2ff' });
  expect(writes.map(command => command.type)).toEqual(['frame.edit']);
  expect(writes[0].expected).toBe(before.versionId);

  await workspace.restart();
  await page.reload();
  await expect(page.getByRole('status')).toHaveText('已保存到本机');
  const frame = page.getByRole('group', { name: '分区：行业研究', exact: true });
  await expect(frame).toBeVisible();
  await expect(frame).toHaveCSS('background-color', 'rgb(238, 242, 255)');
  expect((await workspace.state()).frames![0]).toMatchObject({ id: edited.id, name: '行业研究', background: '#eef2ff' });
});

test('拖框只收纳完整顶层对象和完整 Group，部分对象不进入且重开归属一致', async ({ page, workspace }) => {
  const projectId = (await workspace.state()).project.id;
  const execute = (type: string, payload: unknown, expected: unknown = null) => workspace.execute(page,
    { commandId: crypto.randomUUID(), projectId, type, expected, payload });
  await execute('thought.create', { id: 'frame-card', title: '完整卡片', text: '成员正文不被裁剪', x: 100, y: 120 });
  await execute('text.create', { id: 'frame-text', content: { runs: [{ text: '完整组文字' }], fontSize: 18, lineHeight: 1.5,
    align: 'left', widthMode: 'fixed', width: 180 }, pose: { x: 450, y: 140, width: 180, height: 27 } });
  await execute('shape.create', { id: 'frame-group-shape', content: { shapeType: 'rectangle', shortText: '完整组形状' },
    pose: { x: 450, y: 240, width: 180, height: 100 } });
  await execute('shape.create', { id: 'frame-partial-shape', content: { shapeType: 'ellipse', shortText: '部分框入形状' },
    pose: { x: 640, y: 300, width: 180, height: 100 } });
  const initial = await workspace.state();
  const card = initial.cards[0]!, text = initial.texts![0]!, groupShape = initial.shapes!.find(value => value.id === 'frame-group-shape')!;
  const partial = initial.shapes!.find(value => value.id === 'frame-partial-shape')!;
  await execute('group.create', { id: 'frame-group', itemIds: [text.item.id, groupShape.item.id] },
    { groups: { 'frame-group': null }, containment: { [text.item.id]: null, [groupShape.item.id]: null } });
  const grouped = await workspace.state(), group = grouped.groups![0]!;
  await page.reload();
  await expect(page.getByRole('status')).toHaveText('已保存到本机');

  const writes: any[] = [];
  page.on('request', request => {
    if (request.url().endsWith('/api/mapping/execute') && request.method() === 'POST') writes.push(request.postDataJSON());
  });
  await page.getByRole('button', { name: '分区', exact: true }).click();
  const bounds = (await page.locator('.react-flow__pane').boundingBox())!;
  await page.mouse.move(bounds.x + 60, bounds.y + 80);
  await page.mouse.down();
  await page.mouse.move(bounds.x + 680, bounds.y + 400, { steps: 8 });
  await page.mouse.up();
  await expect.poll(async () => (await workspace.state()).frames?.length).toBe(1);
  const created = await workspace.state(), frame = created.frames![0]!;
  expect(frame.memberItemIds).toEqual([card.item.id, group.itemId]);
  expect(created.containment).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: card.item.id, parent: { kind: 'frame', id: frame.id } }),
    expect.objectContaining({ id: group.itemId, parent: { kind: 'frame', id: frame.id } }),
    expect.objectContaining({ id: text.item.id, parent: { kind: 'group', id: group.itemId } }),
    expect.objectContaining({ id: groupShape.item.id, parent: { kind: 'group', id: group.itemId } }),
  ]));
  expect(created.containment!.some(value => value.id === partial.item.id)).toBe(false);
  expect(writes.map(command => command.type)).toEqual(['frame.create']);
  expect(writes[0].payload.itemIds).toEqual([card.item.id, group.itemId]);
  expect(writes[0].expected.groups).toEqual({ [group.id]: group.versionId });

  await page.reload();
  await expect(page.getByRole('status')).toHaveText('已保存到本机');
  const reopened = await workspace.state();
  expect(reopened.frames![0]!.memberItemIds).toEqual([card.item.id, group.itemId]);
  expect(reopened.containment).toEqual(created.containment);
  await expect(page.getByRole('img', { name: '部分框入形状', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '完整卡片', exact: true })).toBeVisible();
});

test('同父多选从正式入口创建分区，直接归属唯一并保存重开', async ({ page, workspace }) => {
  const { place } = await import('./writing-board-fixture');
  await place(page, '选区甲', 100, 120);
  await place(page, '选区乙', 500, 140);
  const before = await workspace.state();
  await page.getByRole('button', { name: '选区甲', exact: true }).click();
  await page.getByRole('button', { name: '选区乙', exact: true }).click({ modifiers: ['Shift'] });
  await expect(page.locator('.react-flow__node.selected')).toHaveCount(2);
  await page.getByRole('button', { name: '创建分区', exact: true }).click();
  await expect.poll(async () => (await workspace.state()).frames?.length).toBe(1);
  await expect(page.getByRole('status')).toHaveText('已保存到本机');
  const created = await workspace.state(), frame = created.frames![0]!;
  expect(frame.name).toBe('分区1');
  expect(frame.memberItemIds).toEqual(before.cards.map(card => card.item.id));
  for (const card of before.cards) {
    expect(created.containment!.filter(value => value.id === card.item.id)).toHaveLength(1);
    expect(created.containment!.find(value => value.id === card.item.id)!.parent).toEqual({ kind: 'frame', id: frame.id });
    expect(frame.pose.x).toBeLessThanOrEqual(card.item.pose.x);
    expect(frame.pose.y).toBeLessThanOrEqual(card.item.pose.y);
    expect(frame.pose.x + frame.pose.width).toBeGreaterThanOrEqual(card.item.pose.x + card.item.pose.width);
    expect(frame.pose.y + frame.pose.height).toBeGreaterThanOrEqual(card.item.pose.y + card.item.pose.height);
  }
  await page.reload();
  await expect(page.getByRole('status')).toHaveText('已保存到本机');
  expect((await workspace.state()).containment).toEqual(created.containment);
  await expect(page.getByRole('group', { name: '分区：分区1', exact: true })).toBeVisible();
});

test('分区名称 Shift+Enter 换行，IME Enter/Esc 不抢输入，Esc 完成并返回焦点', async ({ page, workspace }) => {
  await page.getByRole('button', { name: '分区', exact: true }).click();
  const bounds = (await page.locator('.react-flow__pane').boundingBox())!;
  await page.mouse.move(bounds.x + 620, bounds.y + 180);
  await page.mouse.down();
  await page.mouse.move(bounds.x + 960, bounds.y + 430, { steps: 6 });
  await page.mouse.up();
  await expect.poll(async () => (await workspace.state()).frames?.length).toBe(1);

  await page.getByRole('button', { name: '分区1', exact: true }).dblclick();
  const multiline = page.getByRole('textbox', { name: '分区名称', exact: true });
  await multiline.fill('第一行');
  await multiline.press('Shift+Enter');
  await multiline.pressSequentially('第二行');
  await expect(multiline).toHaveValue('第一行\n第二行');
  await multiline.press('Enter');
  const multilineTrigger = page.getByRole('button', { name: '第一行\n第二行', exact: true });
  await expect(multilineTrigger).toBeFocused();
  await expect.poll(async () => (await workspace.state()).frames![0]!.name).toBe('第一行\n第二行');

  await multilineTrigger.dblclick();
  const name = page.getByRole('textbox', { name: '分区名称', exact: true });
  await name.fill('中文分区');
  const writes: any[] = [];
  page.on('request', request => {
    if (request.url().endsWith('/api/mapping/execute') && request.method() === 'POST') writes.push(request.postDataJSON());
  });
  await name.dispatchEvent('compositionstart');
  await name.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', isComposing: true });
  await name.dispatchEvent('keydown', { key: 'Escape', code: 'Escape', isComposing: true });
  await expect(name).toBeFocused();
  await expect(name).toHaveValue('中文分区');
  expect(writes).toEqual([]);
  expect((await workspace.state()).frames![0]!.name).toBe('第一行\n第二行');
  await name.dispatchEvent('compositionend');
  await name.press('Escape');
  const trigger = page.getByRole('button', { name: '中文分区', exact: true });
  await expect(trigger).toBeFocused();
  await expect.poll(async () => (await workspace.state()).frames![0]!.name).toBe('中文分区');
  expect(writes.map(command => command.type)).toEqual(['frame.edit']);
});

test('既有对象按指针移入分区后更新唯一归属并保存重开', async ({ page, workspace }) => {
  const projectId = (await workspace.state()).project.id;
  await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'thought.create', expected: null,
    payload: { id: 'drop-card', title: '独立移动卡片', text: '正文保持', x: 900, y: 500 } });
  await page.reload();
  await expect(page.getByRole('status')).toHaveText('已保存到本机');
  await page.getByRole('button', { name: '分区', exact: true }).click();
  const bounds = (await page.locator('.react-flow__pane').boundingBox())!;
  await page.mouse.move(bounds.x + 100, bounds.y + 100);
  await page.mouse.down();
  await page.mouse.move(bounds.x + 500, bounds.y + 400, { steps: 6 });
  await page.mouse.up();
  await expect.poll(async () => (await workspace.state()).frames?.length).toBe(1);
  await page.getByRole('button', { name: '选择', exact: true }).click();
  const card = page.getByRole('button', { name: '独立移动卡片', exact: true });
  await card.click();
  const before = await workspace.state(), itemId = before.cards[0]!.item.id;
  const box = (await card.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 - 600, box.y + box.height / 2 - 250, { steps: 8 });
  await page.mouse.up();
  await expect.poll(async () => (await workspace.state()).cards[0]!.item.pose.x).toBe(300);
  const moved = await workspace.state();
  expect(moved.cards[0]!.item.pose.y).toBe(250);
  expect(moved.frames![0]!.memberItemIds).toEqual([itemId]);
  expect(moved.containment!.find(value => value.id === itemId)?.parent).toEqual({ kind: 'frame', id: moved.frames![0]!.id });
  await page.reload();
  await expect(page.getByRole('status')).toHaveText('已保存到本机');
  expect((await workspace.state()).containment!.find(value => value.id === itemId)?.parent).toEqual({ kind: 'frame', id: moved.frames![0]!.id });
});

async function frameWithGroup(page: Page, workspace: Workspace) {
  const projectId = (await workspace.state()).project.id;
  const execute = (type: string, payload: unknown, expected: unknown = null) => workspace.execute(page,
    { commandId: crypto.randomUUID(), projectId, type, expected, payload });
  await execute('thought.create', { id: 'moving-card', title: '移动普通成员', text: '普通成员正文', x: 100, y: 120 });
  await execute('text.create', { id: 'moving-text', content: { runs: [{ text: '移动组文字' }], fontSize: 18, lineHeight: 1.5,
    align: 'left', widthMode: 'fixed', width: 180 }, pose: { x: 450, y: 140, width: 180, height: 27 } });
  await execute('shape.create', { id: 'moving-group-shape', content: { shapeType: 'rectangle', shortText: '移动组形状' },
    pose: { x: 450, y: 240, width: 180, height: 100 } });
  await execute('shape.create', { id: 'moving-loose-shape', content: { shapeType: 'ellipse', shortText: '沿途独立对象' },
    pose: { x: 850, y: 160, width: 180, height: 100 } });
  const initial = await workspace.state(), card = initial.cards[0]!, text = initial.texts![0]!;
  const groupShape = initial.shapes!.find(value => value.id === 'moving-group-shape')!;
  await execute('connector.create', { id: 'moving-member-line', start: { kind: 'bound', itemId: card.item.id, side: 'right' },
    end: { kind: 'bound', itemId: groupShape.item.id, side: 'left' } });
  await execute('group.create', { id: 'moving-group', itemIds: [text.item.id, groupShape.item.id] },
    { groups: { 'moving-group': null }, containment: { [text.item.id]: null, [groupShape.item.id]: null } });
  await page.reload();
  await expect(page.getByRole('status')).toHaveText('已保存到本机');
  await page.getByRole('button', { name: '分区', exact: true }).click();
  const bounds = (await page.locator('.react-flow__pane').boundingBox())!;
  await page.mouse.move(bounds.x + 60, bounds.y + 80);
  await page.mouse.down();
  await page.mouse.move(bounds.x + 680, bounds.y + 400, { steps: 8 });
  await page.mouse.up();
  await expect.poll(async () => (await workspace.state()).frames?.length).toBe(1);
  await expect(page.getByRole('status')).toHaveText('已保存到本机');
  const before = await workspace.state();
  return {
    before,
    frame: before.frames![0]!, group: before.groups![0]!, card: before.cards[0]!, text: before.texts![0]!,
    groupShape: before.shapes!.find(value => value.id === 'moving-group-shape')!,
    loose: before.shapes!.find(value => value.id === 'moving-loose-shape')!,
  };
}

test('拖分区名称统一预览并只发 frame.move，普通成员和整组一次移动且 undo/redo 保持', async ({ page, workspace }) => {
  const f = await frameWithGroup(page, workspace), dx = 140, dy = 90;
  const members = [f.card, f.text, f.groupShape];
  const writes: any[] = [];
  page.on('request', request => {
    if (request.url().endsWith('/api/mapping/execute') && request.method() === 'POST') writes.push(request.postDataJSON());
  });
  const name = page.getByRole('button', { name: '分区1', exact: true });
  const box = (await name.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + dx, box.y + box.height / 2 + dy, { steps: 6 });
  const frame = page.getByRole('group', { name: '分区：分区1', exact: true });
  await expect(frame).toHaveCSS('left', `${f.frame.pose.x + dx}px`);
  await expect(frame).toHaveCSS('top', `${f.frame.pose.y + dy}px`);
  for (const value of members) {
    const node = page.locator('.react-flow__node[data-id="' + value.item.id + '"]');
    await expect.poll(() => node.evaluate(element => new DOMMatrix(getComputedStyle(element).transform).e)).toBe(value.item.pose.x + dx);
    await expect.poll(() => node.evaluate(element => new DOMMatrix(getComputedStyle(element).transform).f)).toBe(value.item.pose.y + dy);
  }
  expect(await workspace.state()).toEqual(f.before);
  expect(writes).toEqual([]);
  await page.mouse.up();
  await expect.poll(async () => (await workspace.state()).frames![0]!.pose.x).toBe(f.frame.pose.x + dx);
  await expect(page.getByRole('status')).toHaveText('已保存到本机');
  expect(writes.map(command => command.type)).toEqual(['frame.move']);
  expect(writes[0].payload).toEqual({ id: f.frame.id, dx, dy });
  const moved = await workspace.state();
  for (const value of members) {
    const current = [...moved.cards, ...moved.texts!, ...moved.shapes!].find(item => item.id === value.id)!;
    expect(current.item.pose).toEqual({ ...value.item.pose, x: value.item.pose.x + dx, y: value.item.pose.y + dy });
    expect(current.item.createdOrder).toBe(value.item.createdOrder);
  }
  expect(moved.shapes!.find(value => value.id === f.loose.id)!.item.pose).toEqual(f.loose.item.pose);
  expect(moved.containment).toEqual(f.before.containment);
  expect(moved.groups).toHaveLength(1);
  expect(moved.groups![0]).toMatchObject({ id: f.group.id, itemId: f.group.itemId, memberItemIds: f.group.memberItemIds,
    createdOrder: f.group.createdOrder, versionId: f.group.versionId,
    bounds: { ...f.group.bounds, x: f.group.bounds.x + dx, y: f.group.bounds.y + dy } });
  expect(moved.connectors).toEqual(f.before.connectors);

  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect.poll(async () => (await workspace.state()).frames![0]!.pose.x).toBe(f.frame.pose.x);
  const undone = await workspace.state();
  for (const value of members) {
    const current = [...undone.cards, ...undone.texts!, ...undone.shapes!].find(item => item.id === value.id)!;
    expect(current.item.pose).toEqual(value.item.pose);
  }
  expect(undone.containment).toEqual(f.before.containment);
  await page.getByRole('button', { name: '重做', exact: true }).click();
  await expect.poll(async () => (await workspace.state()).frames![0]!.pose.x).toBe(f.frame.pose.x + dx);
  await page.reload();
  await expect(page.getByRole('status')).toHaveText('已保存到本机');
  const reopened = await workspace.state();
  expect(reopened.frames![0]!.pose).toEqual({ ...f.frame.pose, x: f.frame.pose.x + dx, y: f.frame.pose.y + dy });
  expect(reopened.containment).toEqual(f.before.containment);
});

test('删除分区只释放直接成员，保留 Group/内容/成员连线，一次 undo 恢复且普通成员可复制', async ({ page, workspace }) => {
  const f = await frameWithGroup(page, workspace), projectId = f.before.project.id;
  const historyUrl = workspace.origin + '/api/mapping/projects/' + projectId + '/history';
  const timeline = await (await page.request.get(historyUrl)).json();
  expect(timeline.undo.at(-1).label).toBe('frame.create');
  const frame = page.getByRole('group', { name: '分区：分区1', exact: true });
  await expect(frame.getByRole('button', { name: '编辑正文', exact: true })).toHaveCount(0);
  await expect(frame.getByRole('button', { name: '层级', exact: true })).toHaveCount(0);
  const writes: any[] = [];
  page.on('request', request => {
    if (request.url().endsWith('/api/mapping/execute') && request.method() === 'POST') writes.push(request.postDataJSON());
  });
  await page.getByRole('button', { name: '分区1', exact: true }).click();
  await page.getByRole('button', { name: '删除分区', exact: true }).click();
  await expect.poll(async () => (await workspace.state()).frames?.length).toBe(0);
  await expect(page.getByRole('status')).toHaveText('已保存到本机');
  expect(writes.map(command => command.type)).toEqual(['frame.delete']);
  const deleted = await workspace.state();
  for (const id of [f.card.item.id, f.group.itemId])
    expect(deleted.containment!.find(value => value.id === id)!.parent).toBeNull();
  for (const id of [f.text.item.id, f.groupShape.item.id])
    expect(deleted.containment!.find(value => value.id === id)!.parent).toEqual({ kind: 'group', id: f.group.itemId });
  expect(deleted.cards).toEqual(f.before.cards);
  expect(deleted.texts).toEqual(f.before.texts);
  expect(deleted.shapes).toEqual(f.before.shapes);
  expect(deleted.groups).toEqual(f.before.groups);
  expect(deleted.connectors).toEqual(f.before.connectors);
  const deletedTimeline = await (await page.request.get(historyUrl)).json();
  expect(deletedTimeline.undo).toHaveLength(timeline.undo.length + 1);
  expect(deletedTimeline.undo.at(-1).label).toBe('frame.delete');

  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect.poll(async () => (await workspace.state()).frames?.length).toBe(1);
  const restored = await workspace.state();
  for (const id of [f.card.item.id, f.group.itemId])
    expect(restored.containment!.find(value => value.id === id)!.parent).toEqual({ kind: 'frame', id: f.frame.id });
  expect(restored.cards).toEqual(f.before.cards);
  expect(restored.texts).toEqual(f.before.texts);
  expect(restored.shapes).toEqual(f.before.shapes);
  expect(restored.groups).toEqual(f.before.groups);
  expect(restored.connectors).toEqual(f.before.connectors);
  await page.reload();
  await expect(page.getByRole('status')).toHaveText('已保存到本机');
  expect((await workspace.state()).containment).toEqual(restored.containment);

  await page.getByRole('button', { name: '移动普通成员', exact: true }).click();
  await page.getByRole('button', { name: '复制', exact: true }).click();
  await page.getByRole('menuitem', { name: '复制副本', exact: true }).click();
  await expect.poll(async () => (await workspace.state()).cards.length).toBe(2);
  const copied = await workspace.state(), copy = copied.cards.find(card => card.id !== f.card.id)!;
  expect(copied.frames).toHaveLength(1);
  expect(copied.containment!.find(value => value.id === f.card.item.id)!.parent).toEqual({ kind: 'frame', id: f.frame.id });
  expect(copied.containment!.find(value => value.id === copy.item.id)?.parent).toEqual({ kind: 'frame', id: f.frame.id });
  expect(copied.groups).toEqual(restored.groups);
  expect(copied.connectors).toEqual(restored.connectors);
});

test('frame.move 明确拒绝时普通成员和 Group 均无半写，历史与重开保持原状态', async ({ page, workspace }) => {
  const f = await frameWithGroup(page, workspace), projectId = f.before.project.id;
  const historyUrl = workspace.origin + '/api/mapping/projects/' + projectId + '/history';
  const timeline = await (await page.request.get(historyUrl)).json(), writes: any[] = [];
  await page.route('**/api/mapping/execute', async route => {
    const command = route.request().postDataJSON(); writes.push(command);
    if (command.type === 'frame.move') {
      await route.fulfill({ status: 409, contentType: 'application/json',
        body: JSON.stringify({ code: 'VERSION_CONFLICT', message: '分区已更新，请重新读取' }) });
      return;
    }
    await route.continue();
  });
  try {
    const name = page.getByRole('button', { name: '分区1', exact: true }), box = (await name.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 100, box.y + box.height / 2 + 60, { steps: 5 });
    await page.mouse.up();
    await expect.poll(() => writes.some(command => command.type === 'frame.move')).toBe(true);
    await expect(page.getByRole('alert').filter({ hasText: '分区已更新，请重新读取' })).toBeVisible();
    expect(writes.map(command => command.type)).toEqual(['frame.move']);
    expect(await workspace.state()).toEqual(f.before);
    expect(await (await page.request.get(historyUrl)).json()).toEqual(timeline);
  } finally {
    await page.unrouteAll({ behavior: 'wait' });
  }
  await page.reload();
  await expect(page.getByRole('status')).toHaveText('已保存到本机');
  expect(await workspace.state()).toEqual(f.before);
});


test('Frame 内单个普通成员 Delete 只删该成员，undo/redo 新版本且重开保持', async ({ page, workspace }) => {
  const f = await frameWithGroup(page, workspace), historyUrl = workspace.origin + '/api/mapping/projects/' + f.before.project.id + '/history';
  const beforeHistory = await (await page.request.get(historyUrl)).json();
  await page.getByRole('button', { name: '移动普通成员', exact: true }).click();
  await page.keyboard.press('Delete');
  await expect.poll(async () => (await workspace.state()).cards.length).toBe(0);
  const deleted = await workspace.state();
  expect(deleted.frames![0]!.memberItemIds).toEqual([f.group.itemId]);
  expect(deleted.groups).toEqual(f.before.groups);
  expect(deleted.texts).toEqual(f.before.texts);
  expect(deleted.shapes).toEqual(f.before.shapes);
  expect((await (await page.request.get(historyUrl)).json()).undo).toHaveLength(beforeHistory.undo.length + 1);
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect.poll(async () => (await workspace.state()).cards.length).toBe(1);
  const restored = await workspace.state();
  expect(restored.cards[0]).toMatchObject({ id: f.card.id, body: { blocks: f.card.body.blocks }, item: { pose: f.card.item.pose } });
  expect(restored.cards[0]!.versionId).not.toBe(f.card.versionId);
  expect([...restored.frames![0]!.memberItemIds].sort()).toEqual([...f.frame.memberItemIds].sort());
  await page.getByRole('button', { name: '重做', exact: true }).click();
  await expect.poll(async () => (await workspace.state()).cards.length).toBe(0);
  const redone = await workspace.state();
  await workspace.restart(); await page.reload();
  await expect(page.getByRole('status')).toHaveText('已保存到本机');
  expect(await workspace.state()).toEqual(redone);
});


test('Frame 内普通成员与整组多选 Delete 一次删除且撤销恢复全部归属', async ({ page, workspace }) => {
  const f = await frameWithGroup(page, workspace), writes: any[] = [];
  await page.getByRole('button', { name: '移动普通成员', exact: true }).click();
  await page.getByRole('img', { name: '移动组形状', exact: true }).click({ modifiers: ['Shift'] });
  await expect(page.locator('.react-flow__node.selected')).toHaveCount(3);
  page.on('request', request => { if (request.url().endsWith('/api/mapping/execute') && request.method() === 'POST') writes.push(request.postDataJSON()); });
  await page.keyboard.press('Delete');
  await expect.poll(async () => (await workspace.state()).cards.length).toBe(0);
  const deleted = await workspace.state();
  expect(deleted.frames![0]!.memberItemIds).toEqual([]);
  expect(deleted.groups).toEqual([]); expect(deleted.texts).toEqual([]);
  expect(deleted.shapes!.map(value => value.id)).toEqual([f.loose.id]);
  expect(deleted.containment).toEqual([]);
  expect(writes.map(command => command.type)).toEqual(['canvas.delete-selection']);
  expect(writes[0].expected.frames).toEqual({ [f.frame.id]: f.frame.versionId });
  expect(writes[0].expected.containment[f.group.itemId]).toBe(f.before.containment!.find(value => value.id === f.group.itemId)!.versionId);
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect.poll(async () => (await workspace.state()).cards.length).toBe(1);
  const restored = await workspace.state();
  expect([...restored.frames![0]!.memberItemIds].sort()).toEqual([...f.frame.memberItemIds].sort());
  expect(restored.groups![0]!.memberItemIds).toEqual(f.group.memberItemIds);
  for (const value of restored.containment!) expect(value.versionId).not.toBe(f.before.containment!.find(old => old.id === value.id)!.versionId);
  await page.getByRole('button', { name: '重做', exact: true }).click();
  await expect.poll(async () => (await workspace.state()).cards.length).toBe(0);
  const redone = await workspace.state(); await workspace.restart(); await page.reload();
  await expect(page.getByRole('status')).toHaveText('已保存到本机');
  expect(await workspace.state()).toEqual(redone);
});


test('Frame 移动真实409后预览归位，明确放弃后可用新版本继续移动', async ({ page, workspace }) => {
  const f = await frameWithGroup(page, workspace), attempts: any[] = [];
  await page.route('**/api/mapping/execute', async route => {
    const command = route.request().postDataJSON();
    if (command.type !== 'frame.move') { await route.continue(); return; }
    if (!attempts.length) await workspace.execute(page, { commandId: crypto.randomUUID(), projectId: f.before.project.id,
      type: 'frame.edit', expected: f.frame.versionId, payload: { id: f.frame.id, name: '对方分区', background: null } });
    const response = await route.fetch(); attempts.push({ command, status: response.status() }); await route.fulfill({ response });
  });
  try {
    const name = page.getByRole('button', { name: '分区1', exact: true }), box = (await name.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 100, box.y + box.height / 2 + 60, { steps: 5 }); await page.mouse.up();
    await expect.poll(() => attempts.map(value => value.status)).toEqual([409]);
    await expect(page.getByRole('alert').filter({ hasText: /分区.*更新/ })).toBeVisible();
    const frame = page.locator('[data-frame-id="' + f.frame.id + '"]');
    await expect(frame).toHaveCSS('left', `${f.frame.pose.x}px`); await expect(frame).toHaveCSS('top', `${f.frame.pose.y}px`);
    for (const value of [f.card, f.text, f.groupShape]) {
      const node = page.locator('.react-flow__node[data-id="' + value.item.id + '"]');
      await expect.poll(() => node.evaluate(element => new DOMMatrix(getComputedStyle(element).transform).e)).toBe(value.item.pose.x);
    }
    const remote = (await workspace.state()).frames![0]!;
    await page.getByRole('button', { name: '放弃本次分区操作', exact: true }).click();
    await expect(page.getByRole('button', { name: '放弃本次分区操作', exact: true })).toHaveCount(0);
    const current = page.getByRole('button', { name: '对方分区', exact: true }), next = (await current.boundingBox())!;
    await page.mouse.move(next.x + next.width / 2, next.y + next.height / 2); await page.mouse.down();
    await page.mouse.move(next.x + next.width / 2 + 40, next.y + next.height / 2 + 20, { steps: 5 }); await page.mouse.up();
    await expect(page.getByRole('status')).toHaveText('已保存到本机');
    await expect.poll(() => attempts.map(value => value.status)).toEqual([409, 200]);
    expect(attempts[1].command.commandId).not.toBe(attempts[0].command.commandId);
    expect(attempts[1].command.expected.frame).toBe(remote.versionId);
    expect((await workspace.state()).frames![0]!.pose).toEqual({ ...f.frame.pose, x: f.frame.pose.x + 40, y: f.frame.pose.y + 20 });
  } finally { await page.unrouteAll({ behavior: 'wait' }); }
});


for (const mode of ['unknown-ack', 'confirmed-read-failure'] as const) {
  test(`Frame 移动 ${mode} 保留原请求，重试不增加历史且清理预览`, async ({ page, workspace }) => {
    const f = await frameWithGroup(page, workspace), attempts: any[] = [];
    let applied = false, failRead = mode === 'confirmed-read-failure';
    await page.route('**/api/mapping/execute', async route => {
      const command = route.request().postDataJSON();
      if (command.type !== 'frame.move') { await route.continue(); return; }
      const response = await route.fetch(); attempts.push({ command, status: response.status() }); applied = true;
      if (mode === 'unknown-ack' && attempts.length === 1) await route.abort('connectionreset');
      else await route.fulfill({ response });
    });
    await page.route('**/api/mapping/projects/' + f.before.project.id + '/map?**', async route => {
      if (!applied || !failRead || new URL(route.request().url()).searchParams.get('view') !== 'index') { await route.continue(); return; }
      const response = await route.fetch(); expect(response.status()).toBe(200); failRead = false; await route.abort('connectionreset');
    });
    try {
      const name = page.getByRole('button', { name: '分区1', exact: true }), box = (await name.boundingBox())!;
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down();
      await page.mouse.move(box.x + box.width / 2 + 80, box.y + box.height / 2 + 40, { steps: 5 }); await page.mouse.up();
      const retry = page.getByRole('button', { name: '重试保存', exact: true }); await expect(retry).toBeVisible();
      const committed = await workspace.state();
      expect(committed.frames![0]!.pose).toEqual({ ...f.frame.pose, x: f.frame.pose.x + 80, y: f.frame.pose.y + 40 });
      const historyUrl = workspace.origin + '/api/mapping/projects/' + f.before.project.id + '/history';
      const history = await (await page.request.get(historyUrl)).json();
      await page.keyboard.press('Escape');
      await retry.click(); await expect(retry).toHaveCount(0);
      expect(attempts).toHaveLength(mode === 'unknown-ack' ? 2 : 1);
      if (mode === 'unknown-ack') expect(attempts[1]).toEqual(attempts[0]);
      expect(await workspace.state()).toEqual(committed);
      expect(await (await page.request.get(historyUrl)).json()).toEqual(history);
      const frame = page.locator('[data-frame-id="' + f.frame.id + '"]');
      await expect(frame).toHaveCSS('left', `${committed.frames![0]!.pose.x}px`);
      await page.getByRole('button', { name: '撤销', exact: true }).click();
      await expect.poll(async () => (await workspace.state()).frames![0]!.pose.x).toBe(f.frame.pose.x);
      await expect(frame).toHaveCSS('left', `${f.frame.pose.x}px`);
    } finally { await page.unrouteAll({ behavior: 'wait' }); }
  });
}

test('拖新分区按 Esc 即取消预览，随后松鼠标不创建对象或历史', async ({ page, workspace }) => {
  const before = await workspace.state(), historyUrl = workspace.origin + '/api/mapping/projects/' + before.project.id + '/history';
  const history = await (await page.request.get(historyUrl)).json(), writes: any[] = [];
  page.on('request', request => { if (request.url().endsWith('/api/mapping/execute') && request.method() === 'POST') writes.push(request.postDataJSON()); });
  await page.getByRole('button', { name: '分区', exact: true }).click();
  const bounds = (await page.locator('.react-flow__pane').boundingBox())!;
  await page.mouse.move(bounds.x + 620, bounds.y + 150); await page.mouse.down();
  await page.mouse.move(bounds.x + 960, bounds.y + 430, { steps: 6 });
  await expect(page.locator('.canvas-frame-preview')).toBeVisible();
  await page.keyboard.press('Escape');
  try { await expect(page.locator('.canvas-frame-preview')).toHaveCount(0); }
  finally { await page.mouse.up(); }
  await page.getByRole('button', { name: '选择', exact: true }).click();
  expect(await workspace.state()).toEqual(before);
  expect(await (await page.request.get(historyUrl)).json()).toEqual(history);
  expect(writes).toEqual([]);
});


test('创建分区回选择工具并选中新框，Frame 选择与普通选区互斥且 Delete 只删框', async ({ page, workspace }) => {
  const f = await frameWithGroup(page, workspace), frame = page.locator('[data-frame-id="' + f.frame.id + '"]');
  await expect(page.getByRole('button', { name: '选择', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('button', { name: '分区', exact: true })).toHaveAttribute('aria-pressed', 'false');
  await expect(frame).toHaveAttribute('data-selected', 'true');
  await page.getByRole('button', { name: '移动普通成员', exact: true }).click();
  await expect(page.locator('.react-flow__node.selected')).toHaveCount(1);
  await expect(frame).toHaveAttribute('data-selected', 'false');
  const name = page.getByRole('button', { name: '分区1', exact: true });
  await name.click();
  await expect(name).toBeFocused();
  await expect(frame).toHaveAttribute('data-selected', 'true');
  await expect(page.locator('.react-flow__node.selected')).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: '分区名称', exact: true })).toHaveCount(0);
  await page.keyboard.press('Escape'); await expect(frame).toHaveAttribute('data-selected', 'false');
  await name.click(); await page.getByRole('button', { name: '重命名分区', exact: true }).click();
  const editor = page.getByRole('textbox', { name: '分区名称', exact: true });
  await editor.press('ControlOrMeta+A'); await editor.press('Delete');
  expect((await workspace.state()).frames).toHaveLength(1);
  await editor.fill('分区1'); await editor.press('Enter');
  await expect(name).toBeFocused();
  const before = await workspace.state();
  await page.getByRole('img', { name: '移动组形状', exact: true }).focus();
  await page.keyboard.press('Delete');
  await expect.poll(async () => (await workspace.state()).frames!.length).toBe(0);
  const deleted = await workspace.state();
  for (const key of ['cards', 'texts', 'shapes', 'groups', 'connectors'] as const) expect(deleted[key]).toEqual(before[key]);
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect.poll(async () => (await workspace.state()).frames!.length).toBe(1);
  const restored = await workspace.state();
  expect([...restored.frames![0]!.memberItemIds].sort()).toEqual([...f.frame.memberItemIds].sort());
  await name.dblclick(); await expect(editor).toBeFocused();
});


test('分区与连线同时选中时 Delete 先删分区并保留连线，再按一次才删连线', async ({ page, workspace }) => {
  const projectId = (await workspace.state()).project.id;
  await workspace.execute(page, createFrameCommand(await workspace.state(), [], { x: 120, y: 160, width: 240, height: 200 }));
  await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'connector.create', expected: null,
    payload: { id: 'free-line', start: { kind: 'free', point: { x: 520, y: 160 } }, end: { kind: 'free', point: { x: 720, y: 160 } } } });
  await page.reload(); await expect(page.getByRole('status')).toHaveText('已保存到本机');
  const line = page.locator('[data-connector-id="free-line"]');
  await line.click(); await expect(line).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: '分区1', exact: true }).click({ modifiers: ['Shift'] });
  await expect(page.locator('[data-frame-id][data-selected=true]')).toHaveCount(1);
  await expect(line).toHaveAttribute('aria-pressed', 'true');
  await page.locator('.canvas').press('Delete');
  await expect.poll(async () => (await workspace.state()).frames!.length).toBe(0);
  expect((await workspace.state()).connectors!.map(value => value.id)).toEqual(['free-line']);
  await expect(page.getByRole('status')).toHaveText('已保存到本机');
  await expect(line).toHaveAttribute('aria-pressed', 'true');
  await page.locator('.canvas').press('Delete');
  await expect.poll(async () => (await workspace.state()).connectors!.length).toBe(0);
});


for (const operation of ['取消组合', '删除组合'] as const) {
  test(`Frame 内${operation}经正式 UI 一次完成，undo/redo 与重开不留悬挂归属`, async ({ page, workspace }) => {
    const f = await frameWithGroup(page, workspace);
    await page.getByRole('img', { name: '移动组形状', exact: true }).click();
    await expect(page.locator('.react-flow__node.selected')).toHaveCount(2);
    await page.getByRole('button', { name: operation, exact: true }).click();
    await expect.poll(async () => (await workspace.state()).groups!.length).toBe(0);
    await expect(page.getByRole('status')).toHaveText('已保存到本机');
    const changed = await workspace.state();
    expect(changed.frames![0]!.memberItemIds).toEqual([f.card.item.id]);
    expect(changed.containment!.some(value => value.id === f.group.itemId)).toBe(false);
    expect(changed.cards).toEqual(f.before.cards);
    if (operation === '取消组合') { expect(changed.texts).toEqual(f.before.texts); expect(changed.shapes).toEqual(f.before.shapes); }
    else { expect(changed.texts).toEqual([]); expect(changed.shapes!.map(value => value.id)).toEqual([f.loose.id]); }
    await page.getByRole('button', { name: '撤销', exact: true }).click();
    await expect.poll(async () => (await workspace.state()).groups!.length).toBe(1);
    const restored = await workspace.state();
    expect([...restored.frames![0]!.memberItemIds].sort()).toEqual([...f.frame.memberItemIds].sort());
    expect(restored.groups![0]!.memberItemIds).toEqual(f.group.memberItemIds);
    expect(restored.groups![0]!.versionId).not.toBe(f.group.versionId);
    await page.getByRole('button', { name: '重做', exact: true }).click();
    await expect.poll(async () => (await workspace.state()).groups!.length).toBe(0);
    const redone = await workspace.state(); await workspace.restart(); await page.reload();
    await expect(page.getByRole('status')).toHaveText('已保存到本机');
    expect(await workspace.state()).toEqual(redone);
  });
}


test('删框释放 Group 后多选删除捕获 null 父归属，不依赖已删 Frame 并可恢复', async ({ page, workspace }) => {
  const f = await frameWithGroup(page, workspace), writes: any[] = [];
  await page.getByRole('button', { name: '删除分区', exact: true }).click();
  await expect.poll(async () => (await workspace.state()).frames!.length).toBe(0);
  const released = await workspace.state(), own = released.containment!.find(value => value.id === f.group.itemId)!;
  expect(own.parent).toBeNull();
  await page.getByRole('button', { name: '移动普通成员', exact: true }).click();
  await page.getByRole('img', { name: '移动组形状', exact: true }).click({ modifiers: ['Shift'] });
  await expect(page.locator('.react-flow__node.selected')).toHaveCount(3);
  page.on('request', request => { if (request.url().endsWith('/api/mapping/execute') && request.method() === 'POST') writes.push(request.postDataJSON()); });
  await page.keyboard.press('Delete');
  await expect.poll(async () => (await workspace.state()).groups!.length).toBe(0);
  expect((await workspace.state()).containment).toEqual([]);
  expect(writes[0].type).toBe('canvas.delete-selection');
  expect(writes[0].expected.containment[f.group.itemId]).toBe(own.versionId);
  expect(writes[0].expected.frames ?? {}).toEqual({});
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect.poll(async () => (await workspace.state()).groups!.length).toBe(1);
  const restored = await workspace.state();
  expect(restored.frames).toEqual([]);
  expect(restored.containment!.find(value => value.id === f.group.itemId)!.parent).toBeNull();
  expect(restored.containment!.find(value => value.id === f.group.itemId)!.versionId).not.toBe(own.versionId);
  await page.getByRole('button', { name: '重做', exact: true }).click();
  await expect.poll(async () => (await workspace.state()).groups!.length).toBe(0);
  const redone = await workspace.state(); await workspace.restart(); await page.reload();
  await expect(page.getByRole('status')).toHaveText('已保存到本机'); expect(await workspace.state()).toEqual(redone);
});


test('正文冲突使 Frame 移动提交前停止时清预览，保留两份正文且解除冲突后可继续', async ({ page, workspace }) => {
  const f = await frameWithGroup(page, workspace), frameWrites: any[] = [];
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  let captured: any, status: number | undefined;
  await page.route('**/api/mapping/execute', async route => {
    const command = route.request().postDataJSON();
    if (command.type !== 'body.edit' || captured) { await route.continue(); return; }
    captured = command; await gate;
    const response = await route.fetch(); status = response.status(); await route.fulfill({ response });
  });
  page.on('request', request => {
    if (request.url().endsWith('/api/mapping/execute') && request.method() === 'POST' && request.postDataJSON().type === 'frame.move') frameWrites.push(request.postDataJSON());
  });
  try {
    await page.getByRole('button', { name: '移动普通成员', exact: true }).click();
    await page.getByRole('button', { name: '编辑正文', exact: true }).click();
    const editor = page.getByRole('textbox', { name: '卡片正文', exact: true });
    await editor.press('End'); await editor.press('Enter'); await page.keyboard.insertText('本地未确认正文');
    await expect.poll(() => !!captured).toBe(true);
    await workspace.execute(page, { commandId: crypto.randomUUID(), projectId: f.before.project.id, type: 'body.edit', expected: f.card.body.versionId,
      payload: { id: f.card.id, blocks: [{ id: f.card.body.blocks[0]!.id, type: 'text', text: '对方已保存的正文' }] } });
    release(); await expect.poll(() => status).toBe(409);
    const conflict = page.getByRole('region', { name: '保存冲突', exact: true }); await expect(conflict).toBeVisible();
    const peer = await workspace.state(), historyUrl = workspace.origin + '/api/mapping/projects/' + f.before.project.id + '/history';
    const history = await (await page.request.get(historyUrl)).json();
    const name = page.getByRole('button', { name: '分区1', exact: true }), box = (await name.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 100, box.y + box.height / 2 + 60, { steps: 5 }); await page.mouse.up();
    const frame = page.locator('[data-frame-id="' + f.frame.id + '"]');
    await expect(frame).toHaveCSS('left', `${f.frame.pose.x}px`); await expect(frame).toHaveCSS('top', `${f.frame.pose.y}px`);
    expect(frameWrites).toEqual([]); expect(await workspace.state()).toEqual(peer);
    expect(await (await page.request.get(historyUrl)).json()).toEqual(history);
    await expect(editor).toContainText('本地未确认正文');
    await expect(conflict.getByRole('textbox', { name: '我的正文', exact: true })).toHaveValue(/本地未确认正文/);
    await expect(conflict.getByRole('textbox', { name: '已保存的正文', exact: true })).toHaveValue('对方已保存的正文');
    await conflict.getByRole('button', { name: '确认保留已保存的正文', exact: true }).click();
    await expect(conflict).toHaveCount(0);
    const next = (await name.boundingBox())!;
    await page.mouse.move(next.x + next.width / 2, next.y + next.height / 2); await page.mouse.down();
    await page.mouse.move(next.x + next.width / 2 + 40, next.y + next.height / 2 + 20, { steps: 5 }); await page.mouse.up();
    await expect.poll(async () => (await workspace.state()).frames![0]!.pose.x).toBe(f.frame.pose.x + 40);
    expect(frameWrites).toHaveLength(1);
  } finally { release(); await page.unrouteAll({ behavior: 'wait' }); }
});


test('分区编辑固定进入时版本，外部同步后旧草稿409保留，明确放弃后可重新编辑', async ({ page, workspace }) => {
  const f = await frameWithGroup(page, workspace);
  await page.getByRole('button', { name: '分区1', exact: true }).dblclick();
  const name = page.getByRole('textbox', { name: '分区名称', exact: true }), background = page.getByRole('textbox', { name: '分区背景', exact: true });
  await name.fill('本地未确认名称'); await background.fill('#ffeecc');
  await workspace.execute(page, { commandId: crypto.randomUUID(), projectId: f.before.project.id, type: 'frame.edit', expected: f.frame.versionId,
    payload: { id: f.frame.id, name: '对方更新名称', background: '#ddeeff' } });
  const peer = await workspace.state(), historyUrl = workspace.origin + '/api/mapping/projects/' + f.before.project.id + '/history';
  const history = await (await page.request.get(historyUrl)).json();
  await expect(page.locator('.workspace')).toHaveAttribute('data-revision', String(peer.project.revision));
  await expect(page.getByRole('group', { name: '分区：对方更新名称', exact: true })).toHaveCSS('background-color', 'rgb(221, 238, 255)');
  await expect(name).toHaveValue('本地未确认名称'); await expect(background).toHaveValue('#ffeecc');
  const response = page.waitForResponse(value => value.url().endsWith('/api/mapping/execute') && value.request().postDataJSON().type === 'frame.edit');
  await name.press('Enter'); const rejected = await response;
  expect(rejected.status()).toBe(409);
  expect(rejected.request().postDataJSON().expected).toBe(f.frame.versionId);
  await expect(name).toHaveValue('本地未确认名称'); await expect(background).toHaveValue('#ffeecc');
  expect(await workspace.state()).toEqual(peer); expect(await (await page.request.get(historyUrl)).json()).toEqual(history);
  await page.getByRole('button', { name: '放弃本次分区操作', exact: true }).click();
  await expect(name).toHaveCount(0);
  const current = page.getByRole('button', { name: '对方更新名称', exact: true }); await expect(current).toBeFocused();
  await current.dblclick(); await expect(background).toHaveValue('#ddeeff');
  await name.fill('重新确认的新名称');
  const accepted = page.waitForResponse(value => value.url().endsWith('/api/mapping/execute') && value.request().postDataJSON().type === 'frame.edit');
  await name.press('Enter'); const saved = await accepted;
  expect(saved.status()).toBe(200); expect(saved.request().postDataJSON().expected).toBe(peer.frames![0]!.versionId);
  await expect(page.getByRole('button', { name: '重新确认的新名称', exact: true })).toBeFocused();
  expect((await workspace.state()).frames![0]).toMatchObject({ name: '重新确认的新名称', background: '#ddeeff' });
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect.poll(async () => (await workspace.state()).frames![0]!.name).toBe('对方更新名称');
  await page.getByRole('button', { name: '重做', exact: true }).click();
  await expect.poll(async () => (await workspace.state()).frames![0]!.name).toBe('重新确认的新名称');
  await workspace.restart(); await page.reload();
  await expect(page.getByRole('status')).toHaveText('已保存到本机');
  expect((await workspace.state()).frames![0]).toMatchObject({ name: '重新确认的新名称', background: '#ddeeff' });
});


test('分区编辑成功 ACK 在途改选空白后结束原会话，不抢回焦点或选择', async ({ page, workspace }) => {
  const f = await frameWithGroup(page, workspace);
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  const attempts: any[] = [];
  await page.route('**/api/mapping/execute', async route => {
    const command = route.request().postDataJSON();
    if (command.type !== 'frame.edit') { await route.continue(); return; }
    const response = await route.fetch(); attempts.push({ command, status: response.status() });
    await gate; await route.fulfill({ response });
  });
  try {
    await page.getByRole('button', { name: '分区1', exact: true }).dblclick();
    const name = page.getByRole('textbox', { name: '分区名称', exact: true }); await name.fill('已确认的分区名称'); await name.press('Enter');
    await expect.poll(() => attempts.length).toBe(1); expect(attempts[0].status).toBe(200);
    const pane = (await page.locator('.react-flow__pane').boundingBox())!;
    await page.mouse.click(pane.x + pane.width - 30, pane.y + pane.height - 60);
    await expect(page.locator('[data-frame-id="' + f.frame.id + '"]')).toHaveAttribute('data-selected', 'false');
    release(); await expect(page.getByRole('status')).toHaveText('已保存到本机');
    await expect(name).toHaveCount(0);
    const trigger = page.getByRole('button', { name: '已确认的分区名称', exact: true });
    await expect(trigger).toBeVisible(); await expect(trigger).not.toBeFocused();
    await expect(page.locator('.react-flow__node.selected')).toHaveCount(0);
    expect(attempts).toHaveLength(1); expect((await workspace.state()).frames![0]!.name).toBe('已确认的分区名称');
  } finally { release(); await page.unrouteAll({ behavior: 'wait' }); }
});


for (const mode of ['unknown-ack', 'confirmed-read-failure'] as const) {
  test(`分区编辑 ${mode} 后改选再重试仍结束原会话，保原请求且不重复写`, async ({ page, workspace }) => {
    const f = await frameWithGroup(page, workspace), attempts: any[] = [];
    let applied = false, failRead = mode === 'confirmed-read-failure';
    await page.route('**/api/mapping/execute', async route => {
      const command = route.request().postDataJSON();
      if (command.type !== 'frame.edit') { await route.continue(); return; }
      const response = await route.fetch(); attempts.push({ command, status: response.status() }); applied = true;
      if (mode === 'unknown-ack' && attempts.length === 1) await route.abort('connectionreset');
      else await route.fulfill({ response });
    });
    await page.route('**/api/mapping/projects/' + f.before.project.id + '/map?**', async route => {
      if (!applied || !failRead || new URL(route.request().url()).searchParams.get('view') !== 'index') { await route.continue(); return; }
      const response = await route.fetch(); expect(response.status()).toBe(200); failRead = false; await route.abort('connectionreset');
    });
    try {
      await page.getByRole('button', { name: '分区1', exact: true }).dblclick();
      const name = page.getByRole('textbox', { name: '分区名称', exact: true }); await name.fill('等待确认的分区'); await name.press('Enter');
      const retry = page.getByRole('button', { name: '重试保存', exact: true }); await expect(retry).toBeVisible();
      const committed = await workspace.state(), historyUrl = workspace.origin + '/api/mapping/projects/' + f.before.project.id + '/history';
      const history = await (await page.request.get(historyUrl)).json();
      const pane = (await page.locator('.react-flow__pane').boundingBox())!;
      await page.mouse.click(pane.x + pane.width - 30, pane.y + pane.height - 60);
      await retry.click(); await expect(retry).toHaveCount(0); await expect(name).toHaveCount(0);
      await expect(page.getByRole('button', { name: '等待确认的分区', exact: true })).not.toBeFocused();
      await expect(page.locator('[data-frame-id="' + f.frame.id + '"]')).toHaveAttribute('data-selected', 'false');
      expect(attempts).toHaveLength(mode === 'unknown-ack' ? 2 : 1);
      if (mode === 'unknown-ack') expect(attempts[1]).toEqual(attempts[0]);
      expect(await workspace.state()).toEqual(committed); expect(await (await page.request.get(historyUrl)).json()).toEqual(history);
    } finally { await page.unrouteAll({ behavior: 'wait' }); }
  });
}

test('分区编辑表单删除 ACK 在途改选，成功结束原会话且 undo 不复现旧编辑器', async ({ page, workspace }) => {
  const f = await frameWithGroup(page, workspace), attempts: any[] = [];
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/mapping/execute', async route => {
    const command = route.request().postDataJSON();
    if (command.type !== 'frame.delete') { await route.continue(); return; }
    const response = await route.fetch(); attempts.push({ command, status: response.status() }); await gate; await route.fulfill({ response });
  });
  try {
    await page.getByRole('button', { name: '分区1', exact: true }).dblclick();
    const name = page.getByRole('textbox', { name: '分区名称', exact: true }); await name.fill('删除前未保存草稿');
    await page.getByRole('button', { name: '删除分区', exact: true }).click();
    await expect.poll(() => attempts.length).toBe(1); expect(attempts[0].status).toBe(200);
    const pane = (await page.locator('.react-flow__pane').boundingBox())!;
    await page.mouse.click(pane.x + pane.width - 30, pane.y + pane.height - 60);
    release(); await expect(page.getByRole('status')).toHaveText('已保存到本机');
    expect((await workspace.state()).frames).toEqual([]);
    await page.getByRole('button', { name: '撤销', exact: true }).click();
    await expect.poll(async () => (await workspace.state()).frames!.length).toBe(1);
    await expect(name).toHaveCount(0); await expect(page.getByRole('button', { name: '分区1', exact: true })).toBeVisible();
    const restored = await workspace.state();
    expect(restored.frames![0]!.name).toBe('分区1');
    for (const key of ['cards', 'texts', 'shapes', 'groups', 'connectors'] as const) expect(restored[key]).toEqual(f.before[key]);
    await expect(page.locator('.react-flow__node.selected')).toHaveCount(0); expect(attempts).toHaveLength(1);
  } finally { release(); await page.unrouteAll({ behavior: 'wait' }); }
});
