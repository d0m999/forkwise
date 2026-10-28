import { test, expect, type Workspace } from './writing-board-fixture';
import type { Page } from '@playwright/test';
import { fiveMembers } from './group-selection-fixture';

async function seed(page: Page, workspace: Workspace, owner: 'shape' | 'label', late = false) {
  const f = await fiveMembers(page, workspace), projectId = f.before.project.id;
  if (owner === 'shape') {
    await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'shape.create', expected: null,
      payload: { id: 'handoff-shape', content: { shapeType: 'rectangle', shortText: '组外形状' }, pose: { x: 1020, y: 140, width: 160, height: 100 } } });
  } else {
    const created = await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'connector.create', expected: null,
      payload: { id: 'handoff-line', path: 'curve', start: { kind: 'free', point: { x: 120, y: 650 } }, end: { kind: 'free', point: { x: 900, y: 730 } } } });
    await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'connector.label', expected: created.connectorVersions['handoff-line'],
      payload: { id: 'handoff-line', label: { text: '交接连线', position: 0.5, fontSize: 16, color: '#252933', bold: false } } });
  }
  if (late) await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'text.create', expected: null,
    payload: { id: 'handoff-last-text', content: { runs: [{ text: '最后目标C' }], fontSize: 18, lineHeight: 1.5, align: 'left', widthMode: 'fixed', width: 180 },
      pose: { x: 1020, y: 450, width: 180, height: 27 } } });
  await page.reload(); await expect(page.getByRole('status')).toHaveText('已保存到本机');
  await page.getByRole('button', { name: '适应画布', exact: true }).click();
  const before = await workspace.state(), timeline = await (await page.request.get(workspace.origin + '/api/mapping/projects/' + projectId + '/history')).json(), commands: any[] = [];
  page.on('request', request => { if (request.url().endsWith('/api/mapping/execute') && request.method() === 'POST') commands.push(request.postDataJSON()); });
  const entry = owner === 'shape' ? page.getByRole('img', { name: '组外形状', exact: true }) : page.getByRole('button', { name: '连线文字', exact: true });
  await entry.dblclick();
  const editor = page.getByRole('textbox', { name: owner === 'shape' ? '形状文字' : '连线文字', exact: true });
  await expect(editor).toBeFocused(); await expect(editor).toHaveValue(owner === 'shape' ? '组外形状' : '交接连线');
  return { ...f, projectId, before, timeline, commands, editor };
}

for (const kind of ['image', 'stroke', 'shape'] as const) {
  test(`退出looseShape编辑点击G内${kind}先选整组并保存原形状一次`, async ({ page, workspace }) => {
    const f = await seed(page, workspace, 'shape'); await f.editor.fill('形状短文已保存');
    if (kind === 'stroke') {
      const box = (await f.visuals.stroke.boundingBox())!, point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
      expect(await page.evaluate(p => document.elementFromPoint(p.x, p.y)?.closest<HTMLElement>('.react-flow__node')?.dataset.id, point)).toBe(f.items.stroke.item.id);
      await page.mouse.click(point.x, point.y);
    } else await f.visuals[kind].click();
    await expect(f.editor).toHaveCount(0);
    await expect.poll(() => page.locator('.react-flow__node.selected').evaluateAll(nodes => nodes.map(node => (node as HTMLElement).dataset.id!).sort())).toEqual(Object.values(f.items).map(value => value.item.id).sort());
    await expect(page.getByRole('group', { name: '组合', exact: true })).toHaveAttribute('data-selected', 'true');
    await expect(page.getByRole('button', { name: '进入组合', exact: true })).toBeVisible();
    const after = await workspace.state();
    expect(after.shapes!.find(value => value.id === 'handoff-shape')!.content.shortText).toBe('形状短文已保存');
    expect(after.groups).toEqual(f.before.groups); expect(after.containment).toEqual(f.before.containment);
    expect(after.shapes!.find(value => value.id === f.items.shape.id)).toEqual(f.before.shapes!.find(value => value.id === f.items.shape.id));
    expect(after.cards).toEqual(f.before.cards); expect(after.texts).toEqual(f.before.texts); expect(after.images).toEqual(f.before.images); expect(after.strokes).toEqual(f.before.strokes);
    expect(after.project.revision).toBe(f.before.project.revision + 1); expect(f.commands.map(command => command.type)).toEqual(['shape.edit']);
    expect((await (await page.request.get(workspace.origin + '/api/mapping/projects/' + f.projectId + '/history')).json()).undo).toHaveLength(f.timeline.undo.length + 1);
  });
}
for (const kind of ['card', 'text', 'shape', 'image', 'stroke'] as const) {
  test(`退出Label编辑点击G内${kind}沿同一组选择并只保存原线文字`, async ({ page, workspace }) => {
    const f = await seed(page, workspace, 'label'); await f.editor.fill('连线短文已保存');
    await f.visuals[kind].click(); await expect(f.editor).toHaveCount(0);
    await expect.poll(() => page.locator('.react-flow__node.selected').evaluateAll(nodes => nodes.map(node => (node as HTMLElement).dataset.id!).sort())).toEqual(Object.values(f.items).map(value => value.item.id).sort());
    await expect(page.getByRole('group', { name: '组合', exact: true })).toHaveAttribute('data-selected', 'true');
    const after = await workspace.state(); expect(after.connectors![0]!.label!.text).toBe('连线短文已保存');
    expect(after.cards).toEqual(f.before.cards); expect(after.texts).toEqual(f.before.texts); expect(after.shapes).toEqual(f.before.shapes); expect(after.images).toEqual(f.before.images); expect(after.strokes).toEqual(f.before.strokes);
    expect(after.groups).toEqual(f.before.groups); expect(after.containment).toEqual(f.before.containment);
    expect(after.project.revision).toBe(f.before.project.revision + 1); expect(f.commands.map(command => command.type)).toEqual(['connector.label']);
    expect((await (await page.request.get(workspace.origin + '/api/mapping/projects/' + f.projectId + '/history')).json()).undo).toHaveLength(f.timeline.undo.length + 1);
  });
}

test('正文ACK等待中的Shape双击开编辑不得覆盖后来Text选择或抢焦点', async ({ page, workspace }) => {
  const f = await fiveMembers(page, workspace);
  await page.getByRole('button', { name: '编辑正文', exact: true }).click();
  const body = page.getByRole('textbox', { name: '卡片正文', exact: true }); await expect(body).toHaveText('组合正文保持');
  await page.getByRole('button', { name: '适应画布', exact: true }).click();
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  let committed = false, delivered = false; const commands: any[] = [];
  page.on('request', request => { if (request.url().endsWith('/api/mapping/execute') && request.method() === 'POST') commands.push(request.postDataJSON()); });
  page.on('response', response => { if (response.url().endsWith('/api/mapping/execute') && response.request().postDataJSON()?.type === 'body.edit') delivered = true; });
  await page.route('**/api/mapping/execute', async route => {
    if (route.request().postDataJSON()?.type !== 'body.edit') { await route.continue(); return; }
    const response = await route.fetch(); expect(response.status()).toBe(200); committed = true;
    await gate; await route.fulfill({ response });
  });
  try {
    await body.click(); await body.press('End'); await page.keyboard.insertText('短');
    await f.visuals.shape.dblclick(); await expect.poll(() => committed).toBe(true); expect(delivered).toBe(false);
    await expect(page.getByRole('textbox', { name: '形状文字', exact: true })).toHaveCount(0);
    await f.visuals.text.click();
    await expect.poll(() => page.locator('.react-flow__node.selected').evaluateAll(nodes => nodes.map(node => (node as HTMLElement).dataset.id!))).toEqual([f.items.text.item.id]);
    await expect(f.visuals.text).toBeFocused();
    const pending = await workspace.state(); expect(pending.cards[0]!.body.blocks.map(block => block.text)).toEqual(['组合正文保持短']);
    release(); await expect.poll(() => delivered).toBe(true); await expect(page.getByRole('status')).toHaveText('已保存到本机');
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(page.getByRole('textbox', { name: '形状文字', exact: true })).toHaveCount(0);
    await expect.poll(() => page.locator('.react-flow__node.selected').evaluateAll(nodes => nodes.map(node => (node as HTMLElement).dataset.id!))).toEqual([f.items.text.item.id]);
    await expect(f.visuals.text).toBeFocused(); expect(await workspace.state()).toEqual(pending);
    expect(pending.project.revision).toBe(f.before.project.revision + 1); expect(commands.map(command => command.type)).toEqual(['body.edit']);
    expect((await (await page.request.get(workspace.origin + '/api/mapping/projects/' + f.before.project.id + '/history')).json()).undo).toHaveLength(f.timeline.undo.length + 1);
  } finally { release(); await page.unrouteAll({ behavior: 'wait' }); }
});

for (const owner of ['shape', 'label'] as const) {
  test(`${owner}保存ACK等待先点G内Image再点looseText C，仅最后不同语义根生效`, async ({ page, workspace }) => {
    const f = await seed(page, workspace, owner, true), type = owner === 'shape' ? 'shape.edit' : 'connector.label';
    const target = f.before.texts!.find(value => value.id === 'handoff-last-text')!;
    expect(f.before.containment!.some(value => value.id === target.item.id)).toBe(false);
    const targetVisual = page.locator('.react-flow__node[data-id="' + target.item.id + '"]').getByRole('group');
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    let committed = false, delivered = false;
    page.on('response', response => { if (response.url().endsWith('/api/mapping/execute') && response.request().postDataJSON()?.type === type) delivered = true; });
    await page.route('**/api/mapping/execute', async route => {
      if (route.request().postDataJSON()?.type !== type) { await route.continue(); return; }
      const response = await route.fetch(); expect(response.status()).toBe(200); committed = true;
      await gate; await route.fulfill({ response });
    });
    try {
      await f.editor.fill('最后保存短文'); await f.visuals.image.click();
      await expect.poll(() => committed).toBe(true); expect(delivered).toBe(false); await expect(f.editor).toBeVisible();
      const box = (await targetVisual.boundingBox())!, point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
      expect(await page.evaluate(p => document.elementFromPoint(p.x, p.y)?.closest<HTMLElement>('.react-flow__node')?.dataset.id, point)).toBe(target.item.id);
      await page.mouse.click(point.x, point.y);
      expect(delivered).toBe(false);
      const pending = await workspace.state();
      expect(owner === 'shape' ? pending.shapes!.find(value => value.id === 'handoff-shape')!.content.shortText : pending.connectors![0]!.label!.text).toBe('最后保存短文');
      release(); await expect.poll(() => delivered).toBe(true); await expect(f.editor).toHaveCount(0);
      await expect.poll(() => page.locator('.react-flow__node.selected').evaluateAll(nodes => nodes.map(node => (node as HTMLElement).dataset.id!))).toEqual([target.item.id]);
      await expect(page.getByRole('group', { name: '组合', exact: true })).toHaveAttribute('data-selected', 'false');
      expect(await workspace.state()).toEqual(pending); expect(pending.project.revision).toBe(f.before.project.revision + 1);
      expect(f.commands.map(command => command.type)).toEqual([type]);
      expect((await (await page.request.get(workspace.origin + '/api/mapping/projects/' + f.projectId + '/history')).json()).undo).toHaveLength(f.timeline.undo.length + 1);
    } finally { release(); await page.unrouteAll({ behavior: 'wait' }); }
  });
}

test('Stroke交接边界：Shape编辑期间越过拖动阈值没有成员预览或移动写入', async ({ page, workspace }) => {
  const f = await seed(page, workspace, 'shape'); await f.editor.fill('拖动后保存短文');
  const box = (await f.visuals.stroke.boundingBox())!, point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  expect(await page.evaluate(p => document.elementFromPoint(p.x, p.y)?.closest<HTMLElement>('.react-flow__node')?.dataset.id, point)).toBe(f.items.stroke.item.id);
  const items = [...f.before.cards, ...f.before.texts!, ...f.before.shapes!, ...f.before.images!, ...f.before.strokes!];
  let pressed = false;
  try {
    await page.mouse.move(point.x, point.y); await page.mouse.down(); pressed = true;
    await page.mouse.move(point.x + 40, point.y + 20, { steps: 4 });
    for (const value of items) {
      const actual = await page.locator('.react-flow__node[data-id="' + value.item.id + '"]').evaluate(element => {
        const matrix = new DOMMatrix(getComputedStyle(element).transform); return { x: matrix.e, y: matrix.f };
      });
      expect(actual.x).toBeCloseTo(value.item.pose.x, 4); expect(actual.y).toBeCloseTo(value.item.pose.y, 4);
    }
    expect(f.commands).toEqual([]); expect(await workspace.state()).toEqual(f.before);
    await page.mouse.up(); pressed = false;
    if (await f.editor.count()) await f.editor.press('Escape');
    await expect(f.editor).toHaveCount(0);
    const after = await workspace.state();
    expect(after.shapes!.find(value => value.id === 'handoff-shape')!.content.shortText).toBe('拖动后保存短文');
    expect([...after.cards, ...after.texts!, ...after.shapes!, ...after.images!, ...after.strokes!].map(value => value.item)).toEqual(items.map(value => value.item));
    expect(after.groups).toEqual(f.before.groups); expect(after.containment).toEqual(f.before.containment);
    expect(f.commands.map(command => command.type)).toEqual(['shape.edit']); expect(after.project.revision).toBe(f.before.project.revision + 1);
    expect((await (await page.request.get(workspace.origin + '/api/mapping/projects/' + f.projectId + '/history')).json()).undo).toHaveLength(f.timeline.undo.length + 1);
  } finally { if (pressed) await page.mouse.up(); }
});

test('Stroke交接边界：Shape短文编辑真实Tab加Space保存后选择父Group', async ({ page, workspace }) => {
  const f = await seed(page, workspace, 'shape'); await f.editor.fill('键盘交接短文');
  for (let count = 0; count < 96; count++) {
    await page.keyboard.press('Tab');
    if (await f.visuals.stroke.evaluate(element => element === document.activeElement)) break;
  }
  await expect(f.visuals.stroke).toBeFocused(); await expect(f.visuals.stroke).toHaveAttribute('aria-disabled', 'false'); await expect(f.editor).toBeVisible();
  await page.keyboard.press('Space'); await expect(f.editor).toHaveCount(0);
  await expect.poll(() => page.locator('.react-flow__node.selected').evaluateAll(nodes => nodes.map(node => (node as HTMLElement).dataset.id!).sort())).toEqual(Object.values(f.items).map(value => value.item.id).sort());
  await expect(page.getByRole('group', { name: '组合', exact: true })).toHaveAttribute('data-selected', 'true');
  const after = await workspace.state(); expect(after.shapes!.find(value => value.id === 'handoff-shape')!.content.shortText).toBe('键盘交接短文');
  expect(after.strokes).toEqual(f.before.strokes); expect(after.groups).toEqual(f.before.groups); expect(after.containment).toEqual(f.before.containment);
  expect(f.commands.map(command => command.type)).toEqual(['shape.edit']); expect(after.project.revision).toBe(f.before.project.revision + 1);
  expect((await (await page.request.get(workspace.origin + '/api/mapping/projects/' + f.projectId + '/history')).json()).undo).toHaveLength(f.timeline.undo.length + 1);
});

test('Stroke交接边界：真实Tab加Space等待Shape ACK后旧选择不覆盖looseText C', async ({ page, workspace }) => {
  const f = await seed(page, workspace, 'shape', true), target = f.before.texts!.find(value => value.id === 'handoff-last-text')!;
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  let committed = false, delivered = false;
  page.on('response', response => { if (response.url().endsWith('/api/mapping/execute') && response.request().postDataJSON()?.type === 'shape.edit') delivered = true; });
  await page.route('**/api/mapping/execute', async route => {
    if (route.request().postDataJSON()?.type !== 'shape.edit') { await route.continue(); return; }
    const response = await route.fetch(); expect(response.status()).toBe(200); committed = true;
    await gate; await route.fulfill({ response });
  });
  try {
    await f.editor.fill('键盘等待短文');
    for (let count = 0; count < 96; count++) {
      await page.keyboard.press('Tab');
      if (await f.visuals.stroke.evaluate(element => element === document.activeElement)) break;
    }
    await expect(f.visuals.stroke).toBeFocused(); await page.keyboard.press('Space');
    await expect.poll(() => committed).toBe(true); expect(delivered).toBe(false); await expect(f.editor).toBeVisible();
    const visual = page.locator('.react-flow__node[data-id="' + target.item.id + '"]').getByRole('group');
    const box = (await visual.boundingBox())!, point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    expect(await page.evaluate(p => document.elementFromPoint(p.x, p.y)?.closest<HTMLElement>('.react-flow__node')?.dataset.id, point)).toBe(target.item.id);
    await page.mouse.click(point.x, point.y); expect(delivered).toBe(false);
    const pending = await workspace.state(); expect(pending.shapes!.find(value => value.id === 'handoff-shape')!.content.shortText).toBe('键盘等待短文');
    release(); await expect.poll(() => delivered).toBe(true); await expect(f.editor).toHaveCount(0);
    await expect.poll(() => page.locator('.react-flow__node.selected').evaluateAll(nodes => nodes.map(node => (node as HTMLElement).dataset.id!))).toEqual([target.item.id]);
    await expect(page.getByRole('group', { name: '组合', exact: true })).toHaveAttribute('data-selected', 'false');
    expect(await workspace.state()).toEqual(pending); expect(pending.groups).toEqual(f.before.groups); expect(pending.containment).toEqual(f.before.containment);
    expect(f.commands.map(command => command.type)).toEqual(['shape.edit']); expect(pending.project.revision).toBe(f.before.project.revision + 1);
    expect((await (await page.request.get(workspace.origin + '/api/mapping/projects/' + f.projectId + '/history')).json()).undo).toHaveLength(f.timeline.undo.length + 1);
  } finally { release(); await page.unrouteAll({ behavior: 'wait' }); }
});
