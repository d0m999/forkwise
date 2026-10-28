import { test, expect } from './writing-board-fixture';
import { fiveMembers } from './group-selection-fixture';

test('Group加loose对象的Delete按完整选区原子删除，旧组内Shape焦点不抢单删', async ({ page, workspace }) => {
  const f = await fiveMembers(page, workspace), projectId = f.before.project.id;
  await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'shape.create', expected: null,
    payload: { id: 'loose', content: { shapeType: 'rectangle', shortText: '组外目标' }, pose: { x: 1000, y: 420, width: 120, height: 80 } } });
  const created = await workspace.state(), loose = created.shapes!.find(v => v.id === 'loose')!;
  for (const payload of [
    { id: 'incident', start: { kind: 'bound', itemId: f.items.card.item.id, side: 'right' }, end: { kind: 'bound', itemId: loose.item.id, side: 'left' } },
    { id: 'free', start: { kind: 'free', point: { x: 950, y: 610 } }, end: { kind: 'free', point: { x: 1100, y: 650 } } },
  ]) await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'connector.create', expected: null, payload });
  await page.reload(); await expect(f.visuals.shape).toBeVisible();
  await f.visuals.shape.click(); await expect(page.locator('.react-flow__node.selected')).toHaveCount(5);
  await page.getByRole('img', { name: '组外目标', exact: true }).click({ modifiers: ['Shift'] });
  await expect(page.locator('.react-flow__node.selected')).toHaveCount(6);
  await expect(page.getByRole('group', { name: '组合', exact: true })).toHaveAttribute('data-selected', 'true');
  await f.visuals.shape.focus(); await expect(f.visuals.shape).toBeFocused();
  const before = await workspace.state(), history = await (await page.request.get(workspace.origin + '/api/mapping/projects/' + projectId + '/history')).json();
  expect(before.groups![0]!.memberItemIds).toEqual(Object.values(f.items).map(v => v.item.id));
  expect(before.containment!.some(v => v.id === loose.item.id)).toBe(false);
  const requests: any[] = [];
  page.on('request', request => { if (request.url().endsWith('/api/mapping/execute') && request.method() === 'POST') requests.push(request.postDataJSON()); });
  await page.keyboard.press('Delete');
  await expect.poll(async () => (await workspace.state()).cards.length).toBe(0);
  const after = await workspace.state();
  for (const key of ['groups', 'containment', 'texts', 'shapes', 'images', 'strokes'] as const) expect(after[key]).toEqual([]);
  expect(after.connectors).toEqual(before.connectors!.filter(v => v.id === 'free')); expect(after.tags).toEqual(before.tags);
  expect(after.project.revision).toBe(before.project.revision + 1); expect(requests).toHaveLength(1);
  expect(requests[0].type).toBe('canvas.delete-selection');
  expect(requests[0].payload).toEqual({ groupIds: ['selection-group'], directItemIds: [loose.item.id] });
  expect(requests[0].expected.groups).toEqual({ 'selection-group': before.groups![0]!.versionId });
  expect(requests[0].expected.containment).toEqual({ ...Object.fromEntries(before.containment!.map(v => [v.id, v.versionId])), [loose.item.id]: null });
  expect(Object.keys(requests[0].expected.items).sort()).toEqual([...Object.values(f.items).map(v => v.item.id), loose.item.id].sort());
  expect(requests[0].expected.connectors).toEqual({ incident: before.connectors!.find(v => v.id === 'incident')!.versionId });
  const timeline = await (await page.request.get(workspace.origin + '/api/mapping/projects/' + projectId + '/history')).json();
  expect(timeline.undo).toHaveLength(history.undo.length + 1); expect(timeline.undo.at(-1).deletedCardIds).toEqual([f.items.card.id]);
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect.poll(async () => (await workspace.state()).groups!.length).toBe(1);
  const restored = await workspace.state();
  expect(restored.groups![0]!.memberItemIds).toEqual(before.groups![0]!.memberItemIds);
  for (const key of ['cards', 'texts', 'shapes', 'images', 'strokes'] as const) {
    expect(restored[key]!.map(v => [v.id, v.item.id, v.item.pose])).toEqual(before[key]!.map(v => [v.id, v.item.id, v.item.pose]));
    for (const value of restored[key]!) expect(value.item.versionId).not.toBe(before[key]!.find(v => v.id === value.id)!.item.versionId);
  }
  expect(restored.connectors!.map(v => [v.id, v.start, v.end])).toEqual(before.connectors!.map(v => [v.id, v.start, v.end]));
  await page.getByRole('button', { name: '重做', exact: true }).click();
  await expect.poll(async () => (await workspace.state()).groups!.length).toBe(0);
  const redone = await workspace.state(); await page.reload(); expect(await workspace.state()).toEqual(redone);
});

test('直选Text菜单删除真实409后明确放弃，重新操作使用新请求且只删原成员', async ({ page, workspace }) => {
  const f = await fiveMembers(page, workspace), text = f.items.text, attempts: any[] = [];
  await f.visuals.text.click(); await f.visuals.text.click();
  await expect(page.locator('.react-flow__node.selected')).toHaveCount(1);
  await expect(page.locator('.react-flow__node[data-id="' + text.item.id + '"]')).toHaveClass(/selected/);
  await page.route('**/api/mapping/execute', async route => {
    const command = route.request().postDataJSON();
    if (command.type !== 'text.delete') { await route.continue(); return; }
    if (attempts.length === 0) await workspace.execute(page, { commandId: crypto.randomUUID(), projectId: f.before.project.id,
      type: 'text.edit', expected: text.versionId, payload: { id: text.id, content: { ...text.content, runs: [{ text: '外部新正文保持' }] } } });
    const response = await route.fetch(); attempts.push({ command, status: response.status() }); await route.fulfill({ response });
  });
  try {
    await page.getByRole('button', { name: '删除文字', exact: true }).click();
    await expect.poll(() => attempts.length).toBe(1); expect(attempts[0].status).toBe(409);
    expect(attempts[0].command.expected.text).toBe(text.versionId);
    const peer = await workspace.state(), peerText = peer.texts!.find(value => value.id === text.id)!;
    expect(peerText.content.runs).toEqual([{ text: '外部新正文保持' }]); expect(peerText.versionId).not.toBe(text.versionId);
    expect(peer.groups).toEqual(f.before.groups); expect(peer.containment).toEqual(f.before.containment);
    expect(peer.project.revision).toBe(f.before.project.revision + 1);
    const abandon = page.getByRole('button', { name: '放弃本次删除', exact: true }); await expect(abandon).toBeVisible();
    await abandon.click(); await expect(abandon).toHaveCount(0);
    expect(await workspace.state()).toEqual(peer); expect(attempts).toHaveLength(1);
    await page.getByRole('button', { name: '删除文字', exact: true }).click();
    await expect.poll(() => attempts.length).toBe(2); expect(attempts[1].status).toBe(200);
    expect(attempts[1].command.commandId).not.toBe(attempts[0].command.commandId);
    expect(attempts[1].command.expected.text).toBe(peerText.versionId);
    const after = await workspace.state(); expect(after.texts).toEqual([]); expect(after.groups![0]!.memberItemIds).toHaveLength(4);
    for (const key of ['cards', 'shapes', 'images', 'strokes'] as const) expect(after[key]).toEqual(peer[key]);
    expect(after.project.revision).toBe(peer.project.revision + 1);
    expect((await (await page.request.get(workspace.origin + '/api/mapping/projects/' + f.before.project.id + '/history')).json()).undo).toHaveLength(f.timeline.undo.length + 2);
    await page.getByRole('button', { name: '撤销', exact: true }).click();
    await expect.poll(async () => (await workspace.state()).texts![0]?.content).toEqual(peerText.content);
  } finally { await page.unrouteAll({ behavior: 'wait' }); }
});

test('显式Connector选择的Delete保原连线owner，不删除共存的Group成员选择', async ({ page, workspace }) => {
  const f = await fiveMembers(page, workspace), projectId = f.before.project.id;
  await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'connector.create', expected: null,
    payload: { id: 'selected-line', start: { kind: 'free', point: { x: 800, y: 600 } }, end: { kind: 'free', point: { x: 1050, y: 650 } } } });
  await page.reload(); const line = page.locator('.canvas-connector[data-connector-id="selected-line"]');
  await line.click(); await expect(line).toHaveAttribute('aria-pressed', 'true');
  await f.visuals.shape.click(); await f.visuals.shape.click();
  await expect(page.locator('.react-flow__node.selected')).toHaveCount(1); await expect(line).toHaveAttribute('aria-pressed', 'true');
  await line.focus(); await expect(line).toBeFocused();
  const before = await workspace.state(), requests: any[] = [];
  page.on('request', request => { if (request.url().endsWith('/api/mapping/execute') && request.method() === 'POST') requests.push(request.postDataJSON()); });
  await page.keyboard.press('Delete'); await expect.poll(async () => (await workspace.state()).connectors!.length).toBe(0);
  const after = await workspace.state(); expect(after.groups).toEqual(before.groups); expect(after.containment).toEqual(before.containment);
  for (const key of ['cards', 'texts', 'shapes', 'images', 'strokes'] as const) expect(after[key]).toEqual(before[key]);
  expect(after.project.revision).toBe(before.project.revision + 1);
  expect(requests.map(v => v.type)).toEqual(['connector.delete']);
});

test('完整Group的Delete从已完成整组选区删除五类，一次请求并清组', async ({ page, workspace }) => {
  const f = await fiveMembers(page, workspace);
  await f.visuals.shape.click(); await expect(page.locator('.react-flow__node.selected')).toHaveCount(5);
  await expect(page.getByRole('group', { name: '组合', exact: true })).toHaveAttribute('data-selected', 'true');
  await f.visuals.shape.focus(); await expect(f.visuals.shape).toBeFocused();
  const before = await workspace.state(), requests: any[] = [];
  page.on('request', request => { if (request.url().endsWith('/api/mapping/execute') && request.method() === 'POST') requests.push(request.postDataJSON()); });
  await page.keyboard.press('Delete');
  await expect.poll(async () => (await workspace.state()).groups!.length).toBe(0);
  const after = await workspace.state();
  for (const key of ['cards', 'texts', 'shapes', 'images', 'strokes', 'containment'] as const) expect(after[key]).toEqual([]);
  expect(after.project.revision).toBe(before.project.revision + 1); expect(requests).toHaveLength(1);
  expect(requests[0].type).toBe('canvas.delete-selection');
  expect(requests[0].payload).toEqual({ groupIds: ['selection-group'], directItemIds: [] });
});

for (const kind of ['shape', 'image'] as const) {
  test(`Group后Shift追加loose ${kind}沿同一语义选择保留Group且无领域写入`, async ({ page, workspace }) => {
    const f = await fiveMembers(page, workspace), projectId = f.before.project.id;
    await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: kind + '.create', expected: null,
      payload: { id: 'loose-' + kind, content: kind === 'shape' ? { shapeType: 'rectangle', shortText: '组外追加形状' } : f.items.image.content,
        pose: { x: 1000, y: 420, width: 120, height: 80, ...(kind === 'image' ? { rotation: 0 } : {}) } } });
    await page.reload(); await expect(f.visuals.shape).toBeVisible();
    const before = await workspace.state(), value = (kind === 'shape' ? before.shapes! : before.images!).find(v => v.id === 'loose-' + kind)!;
    expect(before.containment!.some(v => v.id === value.item.id)).toBe(false);
    const history = await (await page.request.get(workspace.origin + '/api/mapping/projects/' + projectId + '/history')).json(), requests: any[] = [];
    page.on('request', request => { if (request.url().endsWith('/api/mapping/execute') && request.method() === 'POST') requests.push(request.postDataJSON()); });
    await f.visuals.shape.click(); await expect(page.locator('.react-flow__node.selected')).toHaveCount(5);
    const visual = page.locator('.react-flow__node[data-id="' + value.item.id + '"] ' + (kind === 'shape' ? '[role=img]' : '.canvas-image-object'));
    await visual.click({ modifiers: ['Shift'] });
    await expect(page.locator('.react-flow__node.selected')).toHaveCount(6);
    await expect(page.getByRole('group', { name: '组合', exact: true })).toHaveAttribute('data-selected', 'true');
    for (const id of [...Object.values(f.items).map(v => v.item.id), value.item.id])
      await expect(page.locator('.react-flow__node[data-id="' + id + '"]')).toHaveClass(/selected/);
    expect(requests).toEqual([]); expect(await workspace.state()).toEqual(before);
    expect(await (await page.request.get(workspace.origin + '/api/mapping/projects/' + projectId + '/history')).json()).toEqual(history);
  });
}

for (const peerMembershipChange of [false, true]) {
  test(`整组Delete等待自身正文ACK只推进原Card域，同行归属变化=${peerMembershipChange}不重授权结构`, async ({ page, workspace }) => {
    const f = await fiveMembers(page, workspace), projectId = f.before.project.id;
    await page.getByRole('button', { name: '编辑正文', exact: true }).click();
    await expect(page.getByRole('complementary', { name: '写字板', exact: true })).toBeVisible();
    await f.visuals.card.focus(); await page.keyboard.press('Escape');
    await expect(page.locator('.react-flow__node.selected')).toHaveCount(0);
    await expect(page.getByRole('complementary', { name: '写字板', exact: true })).toBeVisible();
    let release!: () => void, received!: () => void, delivered = false, savedReceipt: any;
    const gate = new Promise<void>(resolve => { release = resolve; }), held = new Promise<void>(resolve => { received = resolve; });
    const requests: any[] = [];
    page.on('request', request => { if (request.url().endsWith('/api/mapping/execute') && request.method() === 'POST') requests.push(request.postDataJSON()); });
    await page.route('**/api/mapping/execute', async route => {
      const command = route.request().postDataJSON();
      if (command.type !== 'body.edit') return route.continue();
      const response = await route.fetch(); expect(response.status()).toBe(200); savedReceipt = await response.json();
      received(); await gate; delivered = true; await route.fulfill({ response });
    });
    try {
      await page.getByLabel('卡片正文', { exact: true }).fill('短文保存'); await held;
      expect(delivered).toBe(false);
      await f.visuals.shape.click(); await expect(page.locator('.react-flow__node.selected')).toHaveCount(5);
      await f.visuals.shape.focus();
      const pending = await workspace.state();
      expect(pending.cards[0]!.body.blocks.map(block => block.text ?? '').join('')).toBe('短文保存');
      const response = page.waitForResponse(value => value.url().endsWith('/api/mapping/execute') && value.request().postDataJSON()?.type === 'canvas.delete-selection');
      await page.keyboard.press('Delete');
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      expect(requests.filter(value => value.type === 'canvas.delete-selection')).toEqual([]); expect(delivered).toBe(false);
      if (peerMembershipChange) {
        const group = pending.groups![0]!, membership = pending.containment!.find(value => value.id === f.items.stroke.item.id)!;
        await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'group.remove-member',
          expected: { group: group.versionId, containment: membership.versionId }, payload: { id: group.id, itemId: membership.id } });
      }
      const peer = await workspace.state(); release();
      expect((await response).status()).toBe(peerMembershipChange ? 409 : 200);
      const command = requests.find(value => value.type === 'canvas.delete-selection');
      expect(command.expected.items[f.items.card.item.id].body).toBe(savedReceipt.versions.body);
      expect(command.expected.groups).toEqual({ 'selection-group': f.before.groups![0]!.versionId });
      expect(command.expected.containment).toEqual(Object.fromEntries(f.before.containment!.map(value => [value.id, value.versionId])));
      expect(Object.keys(command.expected.items).sort()).toEqual(Object.values(f.items).map(value => value.item.id).sort());
      expect(requests.filter(value => value.type === 'body.edit')).toHaveLength(1);
      expect(requests.filter(value => value.type === 'canvas.delete-selection')).toHaveLength(1);
      if (peerMembershipChange) expect(await workspace.state()).toEqual(peer);
      else {
        await expect.poll(async () => (await workspace.state()).groups!.length).toBe(0);
        expect((await workspace.state()).project.revision).toBe(pending.project.revision + 1);
        await page.getByRole('button', { name: '撤销', exact: true }).click();
        await expect.poll(async () => (await workspace.state()).cards[0]?.body.blocks.map(block => block.text ?? '').join('')).toBe('短文保存');
      }
    } finally { release(); await page.unrouteAll({ behavior: 'wait' }); }
  });
}

for (const kind of ['card', 'text'] as const) {
  test(`单一语义直选${kind}从实际节点焦点按Delete沿自身删除owner，不留键盘空洞`, async ({ page, workspace }) => {
    const f = await fiveMembers(page, workspace); await f.visuals[kind].click(); await f.visuals[kind].click();
    await expect(page.locator('.react-flow__node.selected')).toHaveCount(1);
    await expect(page.locator('.react-flow__node[data-id="' + f.items[kind].item.id + '"]')).toHaveClass(/selected/);
    await f.visuals[kind].focus(); await expect(f.visuals[kind]).toBeFocused();
    const before = await workspace.state(), requests: any[] = [];
    page.on('request', request => { if (request.url().endsWith('/api/mapping/execute') && request.method() === 'POST') requests.push(request.postDataJSON()); });
    await page.keyboard.press('Delete');
    await expect.poll(async () => (await workspace.state()).groups![0]!.memberItemIds.length).toBe(4);
    const after = await workspace.state(); expect(after.project.revision).toBe(before.project.revision + 1);
    expect(requests).toHaveLength(1); expect(requests[0].type).toBe(kind === 'card' ? 'thought.delete' : 'text.delete');
    expect(requests[0].expected.membership).toEqual({ group: { id: 'selection-group', versionId: before.groups![0]!.versionId },
      containment: before.containment!.find(v => v.id === f.items[kind].item.id)!.versionId });
    for (const key of ['cards', 'texts', 'shapes', 'images', 'strokes'] as const)
      expect(after[key]).toEqual(before[key]!.filter(v => v.item.id !== f.items[kind].item.id));
    await page.getByRole('button', { name: '撤销', exact: true }).click();
    await expect.poll(async () => (await workspace.state()).groups![0]!.memberItemIds).toEqual(before.groups![0]!.memberItemIds);
  });
}

test('Group移动确认等待期间按Delete，own move ACK只推进五类Pose且保原结构闭包', async ({ page, workspace }) => {
  const f = await fiveMembers(page, workspace), projectId = f.before.project.id;
  await f.visuals.shape.click(); await expect(page.locator('.react-flow__node.selected')).toHaveCount(5);
  const before = await workspace.state(), moves: any[] = [], deletes: any[] = [];
  let release!: () => void, holding = false, delivered = false;
  const gate = new Promise<void>(resolve => { release = resolve; });
  page.on('response', response => { if (response.url().endsWith('/api/mapping/execute') && response.request().postDataJSON()?.type === 'canvas.move-selection') delivered = true; });
  await page.route('**/api/mapping/execute', async route => {
    const command = route.request().postDataJSON();
    if (command.type === 'canvas.move-selection') {
      const response = await route.fetch(); expect(response.status()).toBe(200);
      moves.push({ command, receipt: await response.json() }); holding = true; await gate; await route.fulfill({ response });
    } else if (command.type === 'canvas.delete-selection') {
      const response = await route.fetch(); deletes.push({ command, status: response.status(), receipt: await response.json() }); await route.fulfill({ response });
    } else await route.continue();
  });
  // Delay background publication with the same unavailable ACK interval, so
  // the new deletion intent is visibly captured from the pre-ACK UI snapshot.
  await page.route('**/api/mapping/projects/' + projectId + '/**', async route => {
    if (holding && !delivered) await gate;
    await route.continue();
  });
  let pressed = false;
  try {
    const box = (await f.visuals.shape.boundingBox())!, x = box.x + box.width / 2, y = box.y + box.height / 2;
    await page.mouse.move(x, y); await page.mouse.down(); pressed = true; await page.mouse.move(x + 40, y + 20, { steps: 4 });
    await page.mouse.up(); pressed = false; await expect.poll(() => holding).toBe(true); expect(delivered).toBe(false);
    await expect(page.locator('.workspace')).toHaveAttribute('data-revision', String(before.project.revision));
    await expect(f.visuals.shape).toBeFocused(); await expect(page.locator('.canvas-group-outline')).toHaveAttribute('data-selected', 'true');
    const moved = await workspace.state(); expect(moved.project.revision).toBe(before.project.revision + 1);
    for (const key of ['cards', 'texts', 'shapes', 'images', 'strokes'] as const) {
      expect(moved[key]![0]!.item.pose).toEqual({ ...before[key]![0]!.item.pose, x: before[key]![0]!.item.pose.x + 40, y: before[key]![0]!.item.pose.y + 20 });
    }
    await page.keyboard.press('Delete');
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    expect(deletes).toEqual([]); expect(delivered).toBe(false);
    release(); await expect.poll(() => deletes.length).toBe(1);
    expect(deletes[0].status).toBe(200);
    const expected = deletes[0].command.expected;
    expect(expected.groups).toEqual({ 'selection-group': before.groups![0]!.versionId });
    expect(expected.containment).toEqual(Object.fromEntries(before.containment!.map(v => [v.id, v.versionId])));
    for (const value of [...moved.cards, ...moved.texts!, ...moved.shapes!, ...moved.images!, ...moved.strokes!]) expect(expected.items[value.item.id].pose).toBe(value.item.versionId);
    const after = await workspace.state(); expect(after.groups).toEqual([]);
    expect([after.cards.length, after.texts!.length, after.shapes!.length, after.images!.length, after.strokes!.length]).toEqual([0, 0, 0, 0, 0]);
    expect(after.project.revision).toBe(before.project.revision + 2); expect(moves).toHaveLength(1);
    const timeline = await (await page.request.get(workspace.origin + '/api/mapping/projects/' + projectId + '/history')).json();
    expect(timeline.undo).toHaveLength(f.timeline.undo.length + 2);
    await page.getByRole('button', { name: '撤销', exact: true }).click();
    await expect.poll(async () => (await workspace.state()).groups!.length).toBe(1);
    const restored = await workspace.state();
    for (const key of ['cards', 'texts', 'shapes', 'images', 'strokes'] as const) expect(restored[key]![0]!.item.pose).toEqual(moved[key]![0]!.item.pose);
  } finally { release(); if (pressed) await page.mouse.up(); await page.unrouteAll({ behavior: 'wait' }); }
});
