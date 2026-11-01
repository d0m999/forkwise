import { test, expect, type Workspace } from './writing-board-fixture';
import type { Page } from '@playwright/test';

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
  await trigger.click();
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

  await page.getByRole('button', { name: '分区1', exact: true }).click();
  const multiline = page.getByRole('textbox', { name: '分区名称', exact: true });
  await multiline.fill('第一行');
  await multiline.press('Shift+Enter');
  await multiline.pressSequentially('第二行');
  await expect(multiline).toHaveValue('第一行\n第二行');
  await multiline.press('Enter');
  const multilineTrigger = page.getByRole('button', { name: '第一行\n第二行', exact: true });
  await expect(multilineTrigger).toBeFocused();
  await expect.poll(async () => (await workspace.state()).frames![0]!.name).toBe('第一行\n第二行');

  await multilineTrigger.click();
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

test('既有对象移入分区几何范围不自动改变归属', async ({ page, workspace }) => {
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
  expect(moved.frames![0]!.memberItemIds).toEqual([]);
  expect(moved.containment!.some(value => value.id === itemId)).toBe(false);
  await page.reload();
  await expect(page.getByRole('status')).toHaveText('已保存到本机');
  expect((await workspace.state()).containment!.some(value => value.id === itemId)).toBe(false);
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
  expect(copied.containment!.some(value => value.id === copy.item.id)).toBe(false);
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
