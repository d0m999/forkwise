import { test, expect, type Workspace } from './writing-board-fixture';
import type { Page } from '@playwright/test';
import { fiveMembers } from './group-selection-fixture';

async function frames(page: Page) {
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}
async function selected(page: Page, ids: string[]) {
  await expect.poll(() => page.locator('.react-flow__node.selected').evaluateAll(nodes => nodes.map(node => (node as HTMLElement).dataset.id!).sort())).toEqual([...ids].sort());
}
async function seed(page: Page, workspace: Workspace, extra: 'one' | 'line' | null = null) {
  const f = await fiveMembers(page, workspace), projectId = f.before.project.id;
  if (extra === 'one') {
    for (const [id, x] of [['esc-b', 100], ['esc-c', 440]] as const)
      await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'thought.create', expected: null,
        payload: { id, title: id, text: '', x, y: 650 } });
    const initial = await workspace.state(), b = initial.cards.find(value => value.id === 'esc-b')!, c = initial.cards.find(value => value.id === 'esc-c')!;
    expect(initial.containment!.some(value => [b.item.id, c.item.id].includes(value.id))).toBe(false);
    await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'group.create',
      expected: { groups: { 'esc-single': null }, containment: { [b.item.id]: null, [c.item.id]: null } },
      payload: { id: 'esc-single', itemIds: [b.item.id, c.item.id] } });
    const created = await workspace.state(), group = created.groups!.find(value => value.id === 'esc-single')!, membership = created.containment!.find(value => value.id === c.item.id)!;
    expect(membership.parent).toEqual({ kind: 'group', id: group.itemId });
    await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'group.remove-member',
      expected: { group: group.versionId, containment: membership.versionId }, payload: { id: group.id, itemId: c.item.id } });
    const released = await workspace.state(); expect(released.groups!.find(value => value.id === group.id)!.memberItemIds).toEqual([b.item.id]);
    expect(released.containment!.find(value => value.id === c.item.id)!.parent).toBeNull();
  }
  if (extra === 'line') {
    const created = await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'connector.create', expected: null,
      payload: { id: 'esc-line', path: 'curve', start: { kind: 'free', point: { x: 120, y: 600 } }, end: { kind: 'free', point: { x: 900, y: 700 } } } });
    await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'connector.label', expected: created.connectorVersions['esc-line'],
      payload: { id: 'esc-line', label: { text: 'Esc连线', position: 0.25, fontSize: 16, color: '#252933', bold: false } } });
  }
  if (extra) await page.reload();
  await frames(page); await expect(page.getByRole('status')).toHaveText('已保存到本机');
  const before = await workspace.state(), timeline = await (await page.request.get(workspace.origin + '/api/mapping/projects/' + projectId + '/history')).json(), commands: any[] = [];
  page.on('request', request => { if (request.url().endsWith('/api/mapping/execute') && request.method() === 'POST') commands.push(request.postDataJSON()); });
  return { ...f, projectId, before, timeline, commands, line: page.locator('.canvas-connector[data-connector-id="esc-line"]') };
}
async function unchanged(page: Page, workspace: Workspace, f: Awaited<ReturnType<typeof seed>>) {
  expect(f.commands).toEqual([]); expect(await workspace.state()).toEqual(f.before);
  expect(await (await page.request.get(workspace.origin + '/api/mapping/projects/' + f.projectId + '/history')).json()).toEqual(f.timeline);
}

for (const mode of ['Group', 'member', 'entered', 'bodyboard'] as const) {
  test(`idle Esc一次清${mode}选择和entered，下一成员click回wholeGroup`, async ({ page, workspace }) => {
    const f = await seed(page, workspace); await f.visuals.shape.click();
    if (mode === 'member') await f.visuals.shape.click();
    if (mode === 'entered') await page.getByRole('button', { name: '进入组合', exact: true }).click();
    if (mode === 'bodyboard') {
      await page.getByRole('button', { name: '编辑正文', exact: true }).click();
      await expect(page.getByRole('complementary', { name: '写字板', exact: true })).toBeVisible();
      await f.visuals.card.focus(); await expect(f.visuals.card).toBeFocused();
    } else if (mode !== 'entered') await f.visuals.shape.focus();
    await selected(page, mode === 'entered' ? [] : mode === 'member' ? [f.items.shape.item.id] : mode === 'bodyboard' ? [f.items.card.item.id] : Object.values(f.items).map(value => value.item.id));
    await page.keyboard.press('Escape'); await frames(page); await selected(page, []);
    if (mode === 'bodyboard') await expect(page.getByRole('complementary', { name: '写字板', exact: true })).toBeVisible();
    await f.visuals.shape.click(); await selected(page, Object.values(f.items).map(value => value.item.id));
    await expect(page.getByRole('button', { name: '进入组合', exact: true })).toBeVisible(); await unchanged(page, workspace, f);
  });
}
test('idle Esc清一成员Group整体选区，不解组不删内容', async ({ page, workspace }) => {
  const f = await seed(page, workspace, 'one'), visual = page.getByRole('button', { name: 'esc-b', exact: true });
  await visual.click(); await visual.focus(); await selected(page, [f.before.cards.find(value => value.id === 'esc-b')!.item.id]);
  await expect(page.getByRole('button', { name: '进入组合', exact: true })).toBeVisible();
  await page.keyboard.press('Escape'); await frames(page); await selected(page, []); await unchanged(page, workspace, f);
});
test('idle Esc一次清connector与可达共存的member选择', async ({ page, workspace }) => {
  const f = await seed(page, workspace, 'line');
  await f.line.click(); await expect(f.line).toHaveAttribute('aria-pressed', 'true');
  await f.visuals.shape.click(); await f.visuals.shape.click(); await selected(page, [f.items.shape.item.id]);
  await expect(f.line).toHaveAttribute('aria-pressed', 'true'); await f.visuals.shape.focus();
  await page.keyboard.press('Escape'); await frames(page);
  await expect(f.line).toHaveAttribute('aria-pressed', 'false'); await selected(page, []);
  await f.visuals.shape.click(); await selected(page, Object.values(f.items).map(value => value.item.id)); await unchanged(page, workspace, f);
});
test('idle connector独选Esc清线选区且没有领域写入', async ({ page, workspace }) => {
  const f = await seed(page, workspace, 'line'); await f.line.click(); await expect(f.line).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('Escape'); await frames(page); await expect(f.line).toHaveAttribute('aria-pressed', 'false'); await selected(page, []);
  await unchanged(page, workspace, f);
});

for (const kind of ['image', 'shape', 'text'] as const) {
  test(`${kind}成员resize首Esc取消保选和尾随零写，第二idle Esc才清`, async ({ page, workspace }) => {
    const f = await seed(page, workspace); await f.visuals[kind].click(); await f.visuals[kind].click();
    const id = f.items[kind].item.id, node = page.locator('.react-flow__node[data-id="' + id + '"]');
    await selected(page, [id]);
    const origin = (await node.boundingBox())!, handle = page.getByRole('button', { name: '调整' + (kind === 'image' ? '图片' : kind === 'shape' ? '形状' : '文字') + '尺寸：右下', exact: true }), box = (await handle.boundingBox())!;
    const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 }; let pressed = false;
    try {
      await page.mouse.move(point.x, point.y); await page.mouse.down(); pressed = true;
      await page.mouse.move(point.x + 36, point.y + 24, { steps: 4 });
      await expect.poll(async () => (await node.boundingBox())!.width).not.toBe(origin.width);
      await unchanged(page, workspace, f);
      await page.keyboard.press('Escape'); await expect.poll(() => node.boundingBox()).toEqual(origin); await selected(page, [id]);
      await page.mouse.move(point.x + 60, point.y + 40); await page.mouse.up(); pressed = false;
      await expect.poll(() => node.boundingBox()).toEqual(origin); await selected(page, [id]); await unchanged(page, workspace, f);
      await page.keyboard.press('Escape'); await frames(page); await selected(page, []); await unchanged(page, workspace, f);
    } finally { if (pressed) await page.mouse.up(); }
  });
}
test('labeldrag首Esc只取消预览保线选区，晚到up零写，第二idle才清', async ({ page, workspace }) => {
  const f = await seed(page, workspace, 'line'), label = page.getByRole('button', { name: '连线文字', exact: true });
  const initial = (await label.boundingBox())!, target = await f.line.locator('path').evaluate(element => {
    const path = element as SVGPathElement, point = path.getPointAtLength(path.getTotalLength() * 0.82), screen = new DOMPoint(point.x, point.y).matrixTransform(path.getScreenCTM()!);
    return { x: screen.x, y: screen.y };
  });
  let pressed = false;
  try {
    await label.hover(); await page.mouse.down(); pressed = true; await page.mouse.move(target.x, target.y, { steps: 8 });
    await expect.poll(async () => (await label.boundingBox())!.x).not.toBe(initial.x);
    await expect(f.line).toHaveAttribute('aria-pressed', 'true'); await unchanged(page, workspace, f);
    await page.keyboard.press('Escape'); await expect.poll(() => label.boundingBox()).toEqual(initial);
    await expect(f.line).toHaveAttribute('aria-pressed', 'true');
    await page.mouse.move(target.x + 15, target.y + 15); await page.mouse.up(); pressed = false;
    await expect.poll(() => label.boundingBox()).toEqual(initial); await unchanged(page, workspace, f);
    await page.keyboard.press('Escape'); await frames(page); await expect(f.line).toHaveAttribute('aria-pressed', 'false'); await unchanged(page, workspace, f);
  } finally { if (pressed) await page.mouse.up(); }
});

for (const editing of [false, true]) {
  test(`${editing ? '编辑' : '静态'}文字颜色面板首Esc只关闭颜色，保成员和原编辑owner`, async ({ page, workspace }) => {
    const f = await seed(page, workspace);
    if (editing) await f.visuals.text.dblclick();
    else { await f.visuals.text.click(); await f.visuals.text.click(); }
    await selected(page, [f.items.text.item.id]);
    const editor = page.getByRole('textbox', { name: '独立文字', exact: true });
    if (editing) await expect(editor).toBeVisible();
    await page.getByRole('toolbar', { name: '独立文字样式', exact: true }).getByRole('button', { name: '文字颜色', exact: true }).click();
    await expect(page.locator('.text-color-panel')).toBeVisible(); await page.keyboard.press('Escape'); await frames(page);
    if (editing) await expect(editor).toBeVisible();
    await expect(page.locator('.text-color-panel')).toHaveCount(0); await selected(page, [f.items.text.item.id]); await unchanged(page, workspace, f);
  });
}
test('Card更多菜单Esc只关菜单保成员，不穿透清选', async ({ page, workspace }) => {
  const f = await seed(page, workspace); await f.visuals.card.click(); await f.visuals.card.click(); await selected(page, [f.items.card.item.id]);
  await page.getByRole('toolbar', { name: '卡片操作', exact: true }).getByRole('button', { name: '更多', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '更多', exact: true })).toBeVisible();
  await page.keyboard.press('Escape'); await frames(page); await expect(page.getByRole('dialog', { name: '更多', exact: true })).toHaveCount(0);
  await selected(page, [f.items.card.item.id]); await unchanged(page, workspace, f);
});
test('label文字编辑Esc沿原保存结束语义，保留线选择', async ({ page, workspace }) => {
  const f = await seed(page, workspace, 'line'); await page.getByRole('button', { name: '连线文字', exact: true }).dblclick();
  const editor = page.getByRole('textbox', { name: '连线文字', exact: true }); await expect(editor).toBeFocused();
  await expect(f.line).toHaveAttribute('aria-pressed', 'true'); await editor.fill('Esc保存标签'); await editor.press('Escape');
  await expect(editor).toHaveCount(0); await expect(page.getByRole('status')).toHaveText('已保存到本机'); await frames(page);
  await expect(f.line).toHaveAttribute('aria-pressed', 'true');
  const after = await workspace.state(); expect(after.connectors![0]!.label!.text).toBe('Esc保存标签');
  expect(after.groups).toEqual(f.before.groups); expect(after.containment).toEqual(f.before.containment);
  expect(f.commands.map(command => command.type)).toEqual(['connector.label']);
  expect((await (await page.request.get(workspace.origin + '/api/mapping/projects/' + f.projectId + '/history')).json()).undo).toHaveLength(f.timeline.undo.length + 1);
});
test('图片crop内Esc仅撤销裁剪preview保成员，原项目与history不写', async ({ page, workspace }) => {
  const f = await seed(page, workspace); await f.visuals.image.click(); await f.visuals.image.click(); await selected(page, [f.items.image.item.id]);
  await page.getByRole('toolbar', { name: '图片操作', exact: true }).getByRole('button', { name: '裁剪', exact: true }).click();
  const crop = page.getByRole('region', { name: '图片裁剪', exact: true }); await expect(crop).toBeVisible();
  await crop.getByRole('button', { name: '调整裁剪范围：右', exact: true }).press('Shift+ArrowLeft');
  await crop.press('Escape'); await frames(page); await expect(crop).toHaveCount(0);
  await selected(page, [f.items.image.item.id]); await expect(f.visuals.image).toBeFocused(); await unchanged(page, workspace, f);
});
test('组内Text合成IME协议Esc保编辑与成员，end后原deferredClose保存最终内容', async ({ page, workspace }) => {
  const f = await seed(page, workspace); await f.visuals.text.dblclick();
  const editor = page.getByRole('textbox', { name: '独立文字', exact: true }); await expect(editor).toBeFocused();
  await editor.dispatchEvent('compositionstart'); await editor.fill('候选'); await editor.press('Escape');
  await expect(editor).toBeVisible(); await selected(page, [f.items.text.item.id]); await unchanged(page, workspace, f);
  await editor.fill('最终文字'); await editor.dispatchEvent('compositionend', { data: '最终文字' });
  await expect(editor).toHaveCount(0); await expect(page.getByRole('status')).toHaveText('已保存到本机');
  await selected(page, [f.items.text.item.id]);
  const after = await workspace.state(); expect(after.texts![0]!.content.runs).toEqual([{ text: '最终文字' }]);
  expect(after.groups).toEqual(f.before.groups); expect(after.containment).toEqual(f.before.containment);
  expect(f.commands.map(command => command.type)).toEqual(['text.edit']);
});
