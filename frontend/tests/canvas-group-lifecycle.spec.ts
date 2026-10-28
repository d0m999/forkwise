import { test, expect } from './writing-board-fixture';
import { fiveMembers } from './group-selection-fixture';

for (const kind of ['card', 'text', 'shape', 'image', 'stroke'] as const) {
  test(`成员菜单${kind}移出组合只释放归属，保原几何内容和直选且一步撤销`, async ({ page, workspace }) => {
    const f = await fiveMembers(page, workspace), itemId = f.items[kind].item.id;
    await f.visuals[kind].click(); await f.visuals[kind].click();
    await expect(page.locator('.react-flow__node.selected')).toHaveCount(1);
    await expect(page.locator('.react-flow__node[data-id="' + itemId + '"]')).toHaveClass(/selected/);
    if (kind === 'card') await page.getByRole('button', { name: '更多', exact: true }).click();
    const before = await workspace.state(), requests: any[] = [];
    page.on('request', request => { if (request.url().endsWith('/api/mapping/execute') && request.method() === 'POST') requests.push(request.postDataJSON()); });
    await expect(page.getByRole('button', { name: '移出组合', exact: true })).toBeVisible({ timeout: 3000 });
    await page.getByRole('button', { name: '移出组合', exact: true }).click();
    await expect.poll(async () => (await workspace.state()).groups![0]!.memberItemIds.length).toBe(4);
    const after = await workspace.state();
    expect(after.groups![0]!.memberItemIds).toEqual(before.groups![0]!.memberItemIds.filter(id => id !== itemId));
    expect(after.containment!.find(v => v.id === itemId)!.parent).toBeNull();
    for (const key of ['cards', 'texts', 'shapes', 'images', 'strokes', 'connectors', 'tags'] as const) expect(after[key]).toEqual(before[key]);
    expect(after.project.revision).toBe(before.project.revision + 1); expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ type: 'group.remove-member', projectId: before.project.id,
      payload: { id: 'selection-group', itemId }, expected: { group: before.groups![0]!.versionId,
        containment: before.containment!.find(v => v.id === itemId)!.versionId } });
    await expect(page.locator('.react-flow__node.selected')).toHaveCount(1);
    await expect(page.locator('.react-flow__node[data-id="' + itemId + '"]')).toHaveClass(/selected/);
    const history = await (await page.request.get(workspace.origin + '/api/mapping/projects/' + before.project.id + '/history')).json();
    expect(history.undo).toHaveLength(f.timeline.undo.length + 1);
    await page.getByRole('button', { name: '撤销', exact: true }).click();
    await expect.poll(async () => (await workspace.state()).groups![0]!.memberItemIds).toEqual(before.groups![0]!.memberItemIds);
    const restored = await workspace.state();
    expect(restored.containment!.find(v => v.id === itemId)!.parent).toEqual({ kind: 'group', id: before.groups![0]!.itemId });
    expect(restored.containment!.find(v => v.id === itemId)!.versionId).not.toBe(before.containment!.find(v => v.id === itemId)!.versionId);
    for (const key of ['cards', 'texts', 'shapes', 'images', 'strokes'] as const) expect(restored[key]).toEqual(before[key]);
  });
}

test('组合菜单取消组合保成员几何顺序并直选全体，撤销恢复原Group身份', async ({ page, workspace }) => {
  const f = await fiveMembers(page, workspace); await f.visuals.shape.click();
  await expect(page.locator('.react-flow__node.selected')).toHaveCount(5);
  const before = await workspace.state(), requests: any[] = [];
  page.on('request', request => { if (request.url().endsWith('/api/mapping/execute') && request.method() === 'POST') requests.push(request.postDataJSON()); });
  await expect(page.getByRole('button', { name: '取消组合', exact: true })).toBeVisible({ timeout: 3000 });
  await page.getByRole('button', { name: '取消组合', exact: true }).click();
  await expect.poll(async () => (await workspace.state()).groups!.length).toBe(0);
  const after = await workspace.state();
  expect(after.containment!.map(v => [v.id, v.parent])).toEqual(before.containment!.map(v => [v.id, null]));
  for (const key of ['cards', 'texts', 'shapes', 'images', 'strokes', 'connectors', 'tags'] as const) expect(after[key]).toEqual(before[key]);
  await expect(page.locator('.react-flow__node.selected')).toHaveCount(5);
  await expect(page.getByRole('button', { name: '组合所选对象', exact: true })).toBeVisible();
  expect(after.project.revision).toBe(before.project.revision + 1); expect(requests.map(v => v.type)).toEqual(['group.ungroup']);
  const history = await (await page.request.get(workspace.origin + '/api/mapping/projects/' + before.project.id + '/history')).json();
  expect(history.undo).toHaveLength(f.timeline.undo.length + 1);
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect.poll(async () => (await workspace.state()).groups!.length).toBe(1);
  const restored = await workspace.state();
  expect(restored.groups![0]).toMatchObject({ id: before.groups![0]!.id, itemId: before.groups![0]!.itemId, memberItemIds: before.groups![0]!.memberItemIds });
  expect(restored.groups![0]!.versionId).not.toBe(before.groups![0]!.versionId);
  for (const key of ['cards', 'texts', 'shapes', 'images', 'strokes'] as const) expect(restored[key]).toEqual(before[key]);
});

for (const kind of ['card', 'text', 'shape', 'image', 'stroke'] as const) {
  test(`成员单删${kind}冻结membership和incident，只删自身并一步恢复原归属`, async ({ page, workspace }) => {
    const f = await fiveMembers(page, workspace), projectId = f.before.project.id, itemId = f.items[kind].item.id;
    if (kind !== 'stroke') {
      await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'connector.create', expected: null,
        payload: { id: 'incident', start: { kind: 'bound', itemId, side: 'right' }, end: { kind: 'bound',
          itemId: kind === 'card' ? f.items.shape.item.id : f.items.card.item.id, side: 'left' } } });
      await page.reload();
    }
    await f.visuals[kind].click(); await f.visuals[kind].click();
    await expect(page.locator('.react-flow__node.selected')).toHaveCount(1);
    if (kind === 'card') await page.getByRole('button', { name: '更多', exact: true }).click();
    const before = await workspace.state(), history = await (await page.request.get(workspace.origin + '/api/mapping/projects/' + projectId + '/history')).json();
    const requests: any[] = [];
    page.on('request', request => { if (request.url().endsWith('/api/mapping/execute') && request.method() === 'POST') requests.push(request.postDataJSON()); });
    const label = { card: '删除卡片', text: '删除文字', shape: '删除形状', image: '删除图片', stroke: '删除笔迹' }[kind];
    await expect(page.getByRole('button', { name: label, exact: true })).toBeVisible({ timeout: 3000 });
    await page.getByRole('button', { name: label, exact: true }).click();
    await expect.poll(async () => (await workspace.state()).groups![0]!.memberItemIds.length).toBe(4);
    const after = await workspace.state();
    expect(after.containment!.some(v => v.id === itemId)).toBe(false); expect(after.connectors).toEqual([]);
    for (const key of ['cards', 'texts', 'shapes', 'images', 'strokes'] as const)
      expect(after[key]).toEqual(before[key]!.filter(v => v.item.id !== itemId));
    expect(after.tags).toEqual(before.tags); expect(after.project.revision).toBe(before.project.revision + 1);
    expect(requests).toHaveLength(1); expect(requests[0].type).toBe(kind === 'card' ? 'thought.delete' : kind + '.delete');
    expect(requests[0].expected.membership).toEqual({ group: { id: 'selection-group', versionId: before.groups![0]!.versionId },
      containment: before.containment!.find(v => v.id === itemId)!.versionId });
    if (kind !== 'stroke') expect(requests[0].expected.connectors).toEqual({ incident: before.connectors![0]!.versionId });
    expect((await (await page.request.get(workspace.origin + '/api/mapping/projects/' + projectId + '/history')).json()).undo).toHaveLength(history.undo.length + 1);
    await page.getByRole('button', { name: '撤销', exact: true }).click();
    await expect.poll(async () => (await workspace.state()).groups![0]!.memberItemIds).toEqual(before.groups![0]!.memberItemIds);
    const restored = await workspace.state();
    expect(restored.containment!.find(v => v.id === itemId)!.parent).toEqual({ kind: 'group', id: before.groups![0]!.itemId });
    for (const key of ['cards', 'texts', 'shapes', 'images', 'strokes'] as const)
      expect(restored[key]!.map(v => [v.id, v.item.id, v.item.pose])).toEqual(before[key]!.map(v => [v.id, v.item.id, v.item.pose]));
    expect(restored.connectors!.map(v => [v.id, v.start, v.end])).toEqual(before.connectors!.map(v => [v.id, v.start, v.end]));
  });
}

test('组内空Text明确结束时删除原成员和incident，一步撤销恢复原内容与归属', async ({ page, workspace }) => {
  const f = await fiveMembers(page, workspace), projectId = f.before.project.id;
  await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'connector.create', expected: null,
    payload: { id: 'text-incident', start: { kind: 'bound', itemId: f.items.text.item.id, side: 'right' }, end: { kind: 'bound', itemId: f.items.card.item.id, side: 'left' } } });
  await page.reload(); const before = await workspace.state();
  const history = await (await page.request.get(workspace.origin + '/api/mapping/projects/' + projectId + '/history')).json(), requests: any[] = [];
  page.on('request', request => { if (request.url().endsWith('/api/mapping/execute') && request.method() === 'POST') requests.push(request.postDataJSON()); });
  await f.visuals.text.dblclick(); const editor = page.getByRole('textbox', { name: '独立文字', exact: true });
  await expect(editor).toBeFocused(); await editor.fill(''); await page.keyboard.press('Escape');
  await expect.poll(async () => (await workspace.state()).texts!.length).toBe(0);
  const after = await workspace.state(); expect(after.groups![0]!.memberItemIds).not.toContain(f.items.text.item.id);
  expect(after.containment!.some(v => v.id === f.items.text.item.id)).toBe(false); expect(after.connectors).toEqual([]);
  expect(after.project.revision).toBe(before.project.revision + 1); expect(requests).toHaveLength(1);
  expect(requests[0].type).toBe('text.delete'); expect(requests[0].expected.membership).toEqual({ group: { id: 'selection-group', versionId: before.groups![0]!.versionId },
    containment: before.containment!.find(v => v.id === f.items.text.item.id)!.versionId });
  expect((await (await page.request.get(workspace.origin + '/api/mapping/projects/' + projectId + '/history')).json()).undo).toHaveLength(history.undo.length + 1);
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect.poll(async () => (await workspace.state()).texts![0]?.content).toEqual(before.texts![0]!.content);
  expect((await workspace.state()).groups![0]!.memberItemIds).toEqual(before.groups![0]!.memberItemIds);
});

test('Group菜单删除沿group.delete完整删五类并一步撤销', async ({ page, workspace }) => {
  const f = await fiveMembers(page, workspace); await f.visuals.shape.click();
  await expect(page.locator('.react-flow__node.selected')).toHaveCount(5);
  const before = await workspace.state(), requests: any[] = [];
  page.on('request', request => { if (request.url().endsWith('/api/mapping/execute') && request.method() === 'POST') requests.push(request.postDataJSON()); });
  await expect(page.getByRole('button', { name: '删除组合', exact: true })).toBeVisible({ timeout: 3000 });
  await page.getByRole('button', { name: '删除组合', exact: true }).click();
  await expect.poll(async () => (await workspace.state()).groups!.length).toBe(0);
  const after = await workspace.state();
  for (const key of ['cards', 'texts', 'shapes', 'images', 'strokes', 'containment'] as const) expect(after[key]).toEqual([]);
  expect(after.project.revision).toBe(before.project.revision + 1); expect(requests.map(v => v.type)).toEqual(['group.delete']);
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect.poll(async () => (await workspace.state()).groups![0]?.memberItemIds).toEqual(before.groups![0]!.memberItemIds);
});

test('单成员Group整体Delete仍走完整选择命令，清空组且一步撤销恢复成员与新版本', async ({ page, workspace }) => {
  const f = await fiveMembers(page, workspace), projectId = f.before.project.id;
  for (const kind of ['card', 'shape', 'image', 'stroke'] as const) {
    const state = await workspace.state(), group = state.groups![0]!, membership = state.containment!.find(v => v.id === f.items[kind].item.id)!;
    expect(membership.parent).toEqual({ kind: 'group', id: group.itemId });
    await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'group.remove-member',
      expected: { group: group.versionId, containment: membership.versionId }, payload: { id: group.id, itemId: membership.id } });
  }
  await page.reload(); await expect(page.getByRole('status')).toHaveText('已保存到本机');
  const before = await workspace.state(), group = before.groups![0]!, text = before.texts![0]!;
  expect(group.memberItemIds).toEqual([text.item.id]);
  const historyUrl = workspace.origin + '/api/mapping/projects/' + projectId + '/history';
  const history = await (await page.request.get(historyUrl)).json(), requests: any[] = [];
  await f.visuals.text.click(); await expect(page.locator('.canvas-group-outline')).toHaveAttribute('data-selected', 'true');
  await expect(page.getByRole('button', { name: '进入组合', exact: true })).toBeVisible();
  await expect(page.locator('.react-flow__node.selected')).toHaveCount(1); await expect(f.visuals.text).toBeFocused();
  page.on('request', request => { if (request.url().endsWith('/api/mapping/execute') && request.method() === 'POST') requests.push(request.postDataJSON()); });
  await page.keyboard.press('Delete'); await expect.poll(async () => (await workspace.state()).texts!.length).toBe(0);
  const after = await workspace.state(); expect(after.groups).toEqual([]);
  expect(after.containment!.some(v => v.id === text.item.id)).toBe(false);
  for (const key of ['cards', 'shapes', 'images', 'strokes'] as const) expect(after[key]).toEqual(before[key]);
  expect(requests).toHaveLength(1); expect(requests[0]).toMatchObject({ type: 'canvas.delete-selection',
    payload: { groupIds: [group.id], directItemIds: [] }, expected: { groups: { [group.id]: group.versionId },
      containment: { [text.item.id]: before.containment!.find(v => v.id === text.item.id)!.versionId },
      items: { [text.item.id]: { kind: 'text', text: text.versionId, pose: text.item.versionId } } } });
  expect(after.project.revision).toBe(before.project.revision + 1);
  expect((await (await page.request.get(historyUrl)).json()).undo).toHaveLength(history.undo.length + 1);
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect.poll(async () => (await workspace.state()).groups!.length).toBe(1);
  const restored = await workspace.state(), restoredText = restored.texts![0]!;
  expect(restored.groups![0]).toMatchObject({ id: group.id, itemId: group.itemId, memberItemIds: [text.item.id] });
  expect(restored.groups![0]!.versionId).not.toBe(group.versionId);
  expect(restoredText.content).toEqual(text.content); expect(restoredText.item.pose).toEqual(text.item.pose);
  expect(restoredText.versionId).not.toBe(text.versionId); expect(restoredText.item.versionId).not.toBe(text.item.versionId);
  expect(restored.containment!.find(v => v.id === text.item.id)!.parent).toEqual({ kind: 'group', id: group.itemId });
});

test('组内Text复制沿既有text.copy产生组外副本，原归属与Group保持不变', async ({ page, workspace }) => {
  const f = await fiveMembers(page, workspace); await f.visuals.text.click(); await f.visuals.text.click();
  await expect(page.locator('.react-flow__node.selected')).toHaveCount(1);
  const before = await workspace.state(), requests: any[] = [];
  page.on('request', request => { if (request.url().endsWith('/api/mapping/execute') && request.method() === 'POST') requests.push(request.postDataJSON()); });
  await page.getByRole('button', { name: '生成文字副本', exact: true }).click();
  await expect.poll(async () => (await workspace.state()).texts!.length).toBe(2);
  const after = await workspace.state(), original = before.texts![0]!, copy = after.texts!.find(v => v.id !== original.id)!;
  expect(after.groups).toEqual(before.groups); expect(after.containment).toEqual(before.containment);
  expect(after.texts!.find(v => v.id === original.id)).toEqual(original); expect(copy.content).toEqual(original.content);
  expect(after.containment!.some(v => v.id === copy.item.id)).toBe(false);
  expect(requests.map(v => v.type)).toEqual(['text.copy']); expect(after.project.revision).toBe(before.project.revision + 1);
  expect((await (await page.request.get(workspace.origin + '/api/mapping/projects/' + before.project.id + '/history')).json()).undo).toHaveLength(f.timeline.undo.length + 1);
});

test('旧Group加loose Card重新组合后仅新Group整体选中，保全部成员内容和原子历史', async ({ page, workspace }) => {
  const f = await fiveMembers(page, workspace), projectId = f.before.project.id;
  await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'thought.create', expected: null,
    payload: { id: 'regroup-card', title: '合并组外卡片', text: '新组仍保留正文', x: 1020, y: 580 } });
  const layout = page.waitForResponse(response => response.url().endsWith('/api/mapping/execute') &&
    response.request().postDataJSON()?.type === 'card.layout' && response.request().postDataJSON()?.payload.id === 'regroup-card');
  await page.reload(); expect((await layout).status()).toBe(200);
  await expect(page.getByRole('status')).toHaveText('已保存到本机');
  const before = await workspace.state(), loose = before.cards.find(value => value.id === 'regroup-card')!;
  expect(before.containment!.some(value => value.id === loose.item.id)).toBe(false);
  const historyUrl = workspace.origin + '/api/mapping/projects/' + projectId + '/history';
  const timeline = await (await page.request.get(historyUrl)).json(), requests: any[] = [];
  await f.visuals.shape.click();
  await page.getByRole('button', { name: '合并组外卡片', exact: true }).click({ modifiers: ['Shift'] });
  await expect(page.locator('.react-flow__node.selected')).toHaveCount(6);
  await expect(page.locator('.canvas-group-outline')).toHaveAttribute('data-selected', 'true');
  page.on('request', request => { if (request.url().endsWith('/api/mapping/execute') && request.method() === 'POST') requests.push(request.postDataJSON()); });
  await page.getByRole('button', { name: '组合所选对象', exact: true }).click();
  await expect.poll(async () => (await workspace.state()).groups![0]!.memberItemIds.length).toBe(6);
  await expect(page.getByRole('status')).toHaveText('已保存到本机');
  const after = await workspace.state(), group = after.groups![0]!;
  expect(group.id).not.toBe(before.groups![0]!.id);
  expect(group.memberItemIds).toEqual([...before.groups![0]!.memberItemIds, loose.item.id]);
  for (const key of ['cards', 'texts', 'shapes', 'images', 'strokes', 'connectors', 'tags'] as const) expect(after[key]).toEqual(before[key]);
  expect(after.project.revision).toBe(before.project.revision + 1);
  expect(requests.map(value => value.type)).toEqual(['group.create']);
  expect((await (await page.request.get(historyUrl)).json()).undo).toHaveLength(timeline.undo.length + 1);
  await expect(page.locator('.react-flow__node.selected')).toHaveCount(6);
  await expect(page.locator('.canvas-group-outline[data-group-id="' + group.id + '"]')).toHaveAttribute('data-selected', 'true');
  await expect(page.getByRole('button', { name: '进入组合', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '组合所选对象', exact: true })).toHaveCount(0);
});

test('组合等待正文flush时真实改选loose Card，旧组合请求零提交且保最后选区', async ({ page, workspace }) => {
  const f = await fiveMembers(page, workspace), projectId = f.before.project.id;
  await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'thought.create', expected: null,
    payload: { id: 'regroup-wait-card', title: '最后选择卡片', text: '组外正文保持', x: 1020, y: 580 } });
  const layout = page.waitForResponse(response => response.url().endsWith('/api/mapping/execute') &&
    response.request().postDataJSON()?.type === 'card.layout' && response.request().postDataJSON()?.payload.id === 'regroup-wait-card');
  await page.reload(); expect((await layout).status()).toBe(200); await expect(page.getByRole('status')).toHaveText('已保存到本机');
  await page.locator('.react-flow__node[data-id="' + f.items.card.item.id + '"]').getByRole('button', { name: '编辑正文', exact: true }).click();
  await expect(page.locator('.body-editor small[title]')).toHaveAttribute('title', f.items.card.id);
  await f.visuals.card.focus(); await expect(f.visuals.card).toBeFocused(); await page.keyboard.press('Escape');
  await expect(page.locator('.react-flow__node.selected')).toHaveCount(0);
  await expect(page.getByRole('complementary', { name: '写字板', exact: true })).toBeVisible();
  await expect(page.locator('.body-editor small[title]')).toHaveAttribute('title', f.items.card.id);
  await f.visuals.shape.click();
  await expect(page.locator('.react-flow__node.selected')).toHaveCount(5);
  await expect(page.locator('.canvas-group-outline')).toHaveAttribute('data-selected', 'true');
  const last = page.getByRole('button', { name: '最后选择卡片', exact: true }); await last.click({ modifiers: ['Shift'] });
  await expect(page.locator('.react-flow__node.selected')).toHaveCount(6);
  const before = await workspace.state(), card = before.cards.find(value => value.id === 'regroup-wait-card')!, requests: any[] = [];
  const historyUrl = workspace.origin + '/api/mapping/projects/' + projectId + '/history';
  const timeline = await (await page.request.get(historyUrl)).json();
  let release!: () => void, holding = false, delivered = false;
  const gate = new Promise<void>(resolve => { release = resolve; });
  page.on('response', response => { if (response.url().endsWith('/api/mapping/execute') && response.request().postDataJSON()?.type === 'body.edit') delivered = true; });
  await page.route('**/api/mapping/execute', async route => {
    const command = route.request().postDataJSON(); requests.push(command);
    if (command.type !== 'body.edit') { await route.continue(); return; }
    const response = await route.fetch(); expect(response.status()).toBe(200); holding = true; await gate; await route.fulfill({ response });
  });
  try {
    await page.getByRole('textbox', { name: '卡片正文', exact: true }).fill('更新原组正文');
    await page.getByRole('button', { name: '组合所选对象', exact: true }).click();
    await expect.poll(() => holding).toBe(true); expect(delivered).toBe(false);
    await last.click(); await expect(page.locator('.react-flow__node.selected')).toHaveCount(1);
    await expect(page.locator('.react-flow__node[data-id="' + card.item.id + '"]')).toHaveClass(/selected/);
    release(); await expect.poll(() => delivered).toBe(true); await expect(page.getByRole('status')).toHaveText('已保存到本机');
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    const after = await workspace.state(); expect(after.groups).toEqual(before.groups); expect(after.containment).toEqual(before.containment);
    expect(after.cards.find(value => value.id === f.items.card.id)!.body.blocks.map(block => block.text)).toEqual(['更新原组正文']);
    expect(requests.map(value => value.type)).toEqual(['body.edit']); expect(after.project.revision).toBe(before.project.revision + 1);
    expect((await (await page.request.get(historyUrl)).json()).undo).toHaveLength(timeline.undo.length + 1);
    await expect(page.locator('.react-flow__node.selected')).toHaveCount(1);
    await expect(page.locator('.react-flow__node[data-id="' + card.item.id + '"]')).toHaveClass(/selected/);
  } finally { release(); await page.unrouteAll({ behavior: 'wait' }); }
});
