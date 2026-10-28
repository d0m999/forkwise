import { test, expect } from './writing-board-fixture';
import { fiveMembers } from './group-selection-fixture';

test('组内Card直选移动ACK等待后单删，只推进该Pose且保冻结membership', async ({ page, workspace }) => {
  const f = await fiveMembers(page, workspace), projectId = f.before.project.id;
  await f.visuals.card.click(); await f.visuals.card.click();
  await expect(page.locator('.react-flow__node.selected')).toHaveCount(1);
  const before = await workspace.state(), card = before.cards[0]!, moves: any[] = [], deletes: any[] = [];
  let release!: () => void, holding = false, delivered = false;
  const gate = new Promise<void>(resolve => { release = resolve; });
  page.on('response', response => { if (response.url().endsWith('/api/mapping/execute') && response.request().postDataJSON()?.type === 'canvas.move-selection') delivered = true; });
  await page.route('**/api/mapping/execute', async route => {
    const command = route.request().postDataJSON();
    if (command.type === 'canvas.move-selection') {
      const response = await route.fetch(); expect(response.status()).toBe(200); moves.push({ command, receipt: await response.json() });
      holding = true; await gate; await route.fulfill({ response });
    } else if (command.type === 'thought.delete') {
      const response = await route.fetch(); deletes.push({ command, status: response.status() }); await route.fulfill({ response });
    } else await route.continue();
  });
  await page.route('**/api/mapping/projects/' + projectId + '/**', async route => { if (holding && !delivered) await gate; await route.continue(); });
  let pressed = false;
  try {
    const box = (await f.visuals.card.boundingBox())!, x = box.x + box.width / 2, y = box.y + box.height / 2;
    await page.mouse.move(x, y); await page.mouse.down(); pressed = true;
    await page.mouse.move(x + 40, y + 20, { steps: 4 }); await page.mouse.up(); pressed = false;
    await expect.poll(() => holding).toBe(true); expect(delivered).toBe(false);
    expect(moves[0].command.payload).toEqual({ groupIds: [], directItemIds: [card.item.id], dx: 40, dy: 20 });
    await expect(page.locator('.workspace')).toHaveAttribute('data-revision', String(before.project.revision));
    const moved = await workspace.state(); expect(moved.cards[0]!.item.pose).toEqual({ ...card.item.pose, x: card.item.pose.x + 40, y: card.item.pose.y + 20 });
    await page.getByRole('button', { name: '更多', exact: true }).click();
    await page.getByRole('dialog', { name: '更多', exact: true }).getByRole('button', { name: '删除卡片', exact: true }).click();
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    expect(deletes).toEqual([]); expect(delivered).toBe(false); release();
    await expect.poll(() => deletes.length).toBe(1); expect(deletes[0].status).toBe(200);
    expect(deletes[0].command.expected.pose).toBe(moved.cards[0]!.item.versionId);
    expect(deletes[0].command.expected.membership).toEqual({ group: { id: before.groups![0]!.id, versionId: before.groups![0]!.versionId }, containment: before.containment!.find(value => value.id === card.item.id)!.versionId });
    const after = await workspace.state(); expect(after.cards).toEqual([]); expect(after.groups![0]!.memberItemIds).toHaveLength(4);
    for (const key of ['texts', 'shapes', 'images', 'strokes'] as const) expect(after[key]).toEqual(before[key]);
    expect(after.project.revision).toBe(before.project.revision + 2); expect(moves).toHaveLength(1);
    expect((await (await page.request.get(workspace.origin + '/api/mapping/projects/' + projectId + '/history')).json()).undo).toHaveLength(f.timeline.undo.length + 2);
    await page.getByRole('button', { name: '撤销', exact: true }).click();
    await expect.poll(async () => (await workspace.state()).cards[0]?.item.pose).toEqual(moved.cards[0]!.item.pose);
  } finally { release(); if (pressed) await page.mouse.up(); await page.unrouteAll({ behavior: 'wait' }); }
});

for (const mode of ['peer-pose', 'peer-membership', 'published-ack', 'old-receipt'] as const) {
  test(`own移动ACK ${mode}仅承认本次版本，删除意图不吸收同行更新或旧回执缺口`, async ({ page, workspace }) => {
    const f = await fiveMembers(page, workspace), projectId = f.before.project.id;
    await f.visuals.shape.click(); await expect(page.locator('.react-flow__node.selected')).toHaveCount(5);
    const before = await workspace.state(), moves: any[] = [], deletes: any[] = [];
    let release!: () => void, holding = false, delivered = false;
    const gate = new Promise<void>(resolve => { release = resolve; });
    page.on('response', response => { if (response.url().endsWith('/api/mapping/execute') && response.request().postDataJSON()?.type === 'canvas.move-selection') delivered = true; });
    await page.route('**/api/mapping/execute', async route => {
      const command = route.request().postDataJSON();
      if (command.type === 'canvas.move-selection') {
        const response = await route.fetch(), receipt = await response.json(); expect(response.status()).toBe(200);
        moves.push({ command, receipt }); holding = true; await gate;
        if (mode === 'old-receipt') { const { itemPoseVersions: omitted, ...legacy } = receipt; expect(Object.keys(omitted)).toHaveLength(5); await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(legacy) }); }
        else await route.fulfill({ response });
      } else if (command.type === 'canvas.delete-selection') {
        const response = await route.fetch(); deletes.push({ command, status: response.status(), receipt: await response.json() }); await route.fulfill({ response });
      } else await route.continue();
    });
    await page.route('**/api/mapping/projects/' + projectId + '/**', async route => {
      if (mode !== 'published-ack' && holding && !delivered) await gate;
      await route.continue();
    });
    let pressed = false;
    try {
      const box = (await f.visuals.shape.boundingBox())!, x = box.x + box.width / 2, y = box.y + box.height / 2;
      await page.mouse.move(x, y); await page.mouse.down(); pressed = true; await page.mouse.move(x + 40, y + 20, { steps: 4 }); await page.mouse.up(); pressed = false;
      await expect.poll(() => holding).toBe(true); expect(delivered).toBe(false);
      const moved = await workspace.state(); expect(moved.project.revision).toBe(before.project.revision + 1);
      await expect(page.locator('.workspace')).toHaveAttribute('data-revision', String(mode === 'published-ack' ? moved.project.revision : before.project.revision));
      await expect(f.visuals.shape).toBeFocused(); await expect(page.locator('.canvas-group-outline')).toHaveAttribute('data-selected', 'true');
      await page.keyboard.press('Delete');
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      expect(deletes).toEqual([]); expect(delivered).toBe(false);
      if (mode === 'peer-pose') {
        const shape = moved.shapes![0]!;
        await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'shape.move', expected: shape.item.versionId,
          payload: { id: shape.id, x: shape.item.pose.x + 60, y: shape.item.pose.y + 30 } });
      } else if (mode === 'peer-membership') {
        const group = moved.groups![0]!, membership = moved.containment!.find(v => v.id === f.items.stroke.item.id)!;
        await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'group.remove-member',
          expected: { group: group.versionId, containment: membership.versionId }, payload: { id: group.id, itemId: membership.id } });
      }
      const peer = await workspace.state(), historyUrl = workspace.origin + '/api/mapping/projects/' + projectId + '/history';
      const peerHistory = await (await page.request.get(historyUrl)).json();
      release(); await expect.poll(() => delivered).toBe(true);
      if (mode === 'old-receipt') {
        await expect(page.locator('.save-state [role=alert]')).toContainText('重新明确删除');
        expect(deletes).toEqual([]); expect(await workspace.state()).toEqual(peer);
        await expect(page.locator('.workspace')).toHaveAttribute('data-revision', String(moved.project.revision));
        await page.keyboard.press('Delete'); await expect.poll(() => deletes.length).toBe(1);
        expect(deletes[0].status).toBe(200);
      } else {
        await expect.poll(() => deletes.length).toBe(1);
        expect(deletes[0].status).toBe(mode === 'published-ack' ? 200 : 409);
        expect(deletes[0].command.expected.groups).toEqual({ 'selection-group': before.groups![0]!.versionId });
        expect(deletes[0].command.expected.containment).toEqual(Object.fromEntries(before.containment!.map(v => [v.id, v.versionId])));
        for (const value of [...moved.cards, ...moved.texts!, ...moved.shapes!, ...moved.images!, ...moved.strokes!]) expect(deletes[0].command.expected.items[value.item.id].pose).toBe(value.item.versionId);
      }
      if (mode === 'peer-pose' || mode === 'peer-membership') {
        expect(await workspace.state()).toEqual(peer); expect(await (await page.request.get(historyUrl)).json()).toEqual(peerHistory);
      } else {
        const after = await workspace.state(); expect(after.groups).toEqual([]);
        expect([after.cards.length, after.texts!.length, after.shapes!.length, after.images!.length, after.strokes!.length]).toEqual([0, 0, 0, 0, 0]);
        expect(after.project.revision).toBe(before.project.revision + 2);
        expect((await (await page.request.get(historyUrl)).json()).undo).toHaveLength(f.timeline.undo.length + 2);
      }
      expect(moves).toHaveLength(1);
      console.log('ISSUE28_OWN_POSE_ACK', JSON.stringify({ mode, moves, deletes, peerHistory }));
    } finally { release(); if (pressed) await page.mouse.up(); await page.unrouteAll({ behavior: 'wait' }); }
  });
}

test('loose Shape原shapeMove保存ACK等待后Shift Card再Delete，只用自身确认推进Pose', async ({ page, workspace }) => {
  const projectId = (await workspace.state()).project.id;
  await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'thought.create', expected: null,
    payload: { id: 'loose-card', title: '同行卡片', text: '完整正文', x: 100, y: 120 } });
  await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'shape.create', expected: null,
    payload: { id: 'loose-shape', content: { shapeType: 'ellipse', shortText: '待确认形状' }, pose: { x: 720, y: 120, width: 160, height: 100 } } });
  const layout = page.waitForResponse(response => response.url().endsWith('/api/mapping/execute') && response.request().postDataJSON()?.type === 'card.layout');
  await page.reload(); expect((await layout).status()).toBe(200); await expect(page.getByRole('status')).toHaveText('已保存到本机');
  const before = await workspace.state(), shape = before.shapes![0]!, card = before.cards[0]!;
  expect(before.groups).toEqual([]); expect(before.containment).toEqual([]);
  let release!: () => void, holding = false, delivered = false;
  const gate = new Promise<void>(resolve => { release = resolve; }), deletes: any[] = [], moves: any[] = [];
  page.on('response', response => { if (response.url().endsWith('/api/mapping/execute') && response.request().postDataJSON()?.type === 'shape.move') delivered = true; });
  await page.route('**/api/mapping/execute', async route => {
    const command = route.request().postDataJSON();
    if (command.type === 'shape.move') {
      const response = await route.fetch(); expect(response.status()).toBe(200); moves.push({ command, receipt: await response.json() }); holding = true;
      await gate; await route.fulfill({ response });
    } else if (command.type === 'canvas.delete-selection') {
      const response = await route.fetch(); deletes.push({ command, status: response.status() }); await route.fulfill({ response });
    } else await route.continue();
  });
  await page.route('**/api/mapping/projects/' + projectId + '/**', async route => { if (holding && !delivered) await gate; await route.continue(); });
  let pressed = false;
  try {
    const visual = page.getByRole('img', { name: '待确认形状', exact: true }); await visual.click();
    const box = (await visual.boundingBox())!, x = box.x + box.width / 2, y = box.y + box.height / 2;
    await page.mouse.move(x, y); await page.mouse.down(); pressed = true; await page.mouse.move(x + 40, y + 20, { steps: 4 }); await page.mouse.up(); pressed = false;
    await expect.poll(() => holding).toBe(true); expect(delivered).toBe(false);
    await page.getByRole('button', { name: '同行卡片', exact: true }).click({ modifiers: ['Shift'] });
    await expect.poll(() => page.locator('.react-flow__node.selected').evaluateAll(nodes => nodes.map(node => (node as HTMLElement).dataset.id).sort())).toEqual([shape.item.id, card.item.id].sort());
    await expect(page.locator('.workspace')).toHaveAttribute('data-revision', String(before.project.revision));
    const moved = await workspace.state(); expect(moved.shapes![0]!.item.pose).toEqual({ ...shape.item.pose, x: 760, y: 140 });
    await page.keyboard.press('Delete'); await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    expect(deletes).toEqual([]); expect(delivered).toBe(false);
    release(); await expect.poll(() => deletes.length).toBe(1); expect(deletes[0].status).toBe(200);
    expect(deletes[0].command.expected.items[shape.item.id].pose).toBe(moves[0].receipt.shapeVersions.pose);
    expect(deletes[0].command.expected.containment).toEqual({ [shape.item.id]: null, [card.item.id]: null });
    expect(deletes[0].command.expected.groups).toEqual({});
    const after = await workspace.state(); expect(after.cards).toEqual([]); expect(after.shapes).toEqual([]);
    expect(after.project.revision).toBe(before.project.revision + 2); expect(moves).toHaveLength(1);
  } finally { release(); if (pressed) await page.mouse.up(); await page.unrouteAll({ behavior: 'wait' }); }
});

test('Image旋转unknown后Group删除保旧意图409，放弃后原图片重试再明确新C成功', async ({ page, workspace }) => {
  const f = await fiveMembers(page, workspace), projectId = f.before.project.id;
  await f.visuals.image.click(); await f.visuals.image.click(); await expect(page.locator('.react-flow__node.selected')).toHaveCount(1);
  const before = await workspace.state(), image = before.images![0]!, rotations: any[] = [], deletes: any[] = [];
  let unknown = false, release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/mapping/execute', async route => {
    const command = route.request().postDataJSON();
    if (command.type === 'image.rotate') {
      const response = await route.fetch(); rotations.push({ command, status: response.status(), receipt: await response.json() }); expect(response.status()).toBe(200);
      if (rotations.length === 1) { unknown = true; await route.abort('connectionreset'); } else await route.fulfill({ response });
    } else if (command.type === 'canvas.delete-selection') {
      const response = await route.fetch(); deletes.push({ command, status: response.status() }); release(); await route.fulfill({ response });
    } else await route.continue();
  });
  await page.route('**/api/mapping/projects/' + projectId + '/**', async route => { if (unknown && !deletes.length) await gate; await route.continue(); });
  try {
    await page.getByRole('button', { name: '向右旋转90°', exact: true }).click();
    const imageRetry = page.getByRole('button', { name: '重试图片调整', exact: true }); await expect(imageRetry).toBeVisible();
    await f.visuals.card.focus(); await page.keyboard.press('Escape');
    await expect(page.locator('.react-flow__node.selected')).toHaveCount(0); await expect(imageRetry).toBeVisible();
    await f.visuals.card.click(); await expect(page.locator('.canvas-group-outline')).toHaveAttribute('data-selected', 'true');
    await expect(page.locator('.react-flow__node.selected')).toHaveCount(5); await expect(f.visuals.card).toBeFocused();
    await page.keyboard.press('Delete'); await expect.poll(() => deletes.length).toBe(1); expect(deletes[0].status).toBe(409);
    expect(deletes[0].command.expected.items[image.item.id]).toEqual({ kind: 'image', image: image.versionId, pose: image.item.versionId });
    const rotated = await workspace.state(); expect(rotated.images![0]!.item.versionId).not.toBe(image.item.versionId);
    expect(rotated.images![0]!.versionId).toBe(image.versionId);
    expect(rotated.groups!.map(({ bounds: _bounds, ...group }) => group)).toEqual(before.groups!.map(({ bounds: _bounds, ...group }) => group));
    expect(rotated.containment).toEqual(before.containment);
    expect([rotated.cards.length, rotated.texts!.length, rotated.shapes!.length, rotated.images!.length, rotated.strokes!.length]).toEqual([1, 1, 1, 1, 1]);
    await page.getByRole('button', { name: '放弃本次组合操作', exact: true }).click();
    await expect(page.getByRole('button', { name: '放弃本次组合操作', exact: true })).toHaveCount(0);
    await imageRetry.click(); await expect(imageRetry).toHaveCount(0); expect(rotations).toHaveLength(2); expect(rotations[1]).toEqual(rotations[0]);
    expect(await workspace.state()).toEqual(rotated);
    await f.visuals.card.focus(); await expect(page.locator('.canvas-group-outline')).toHaveAttribute('data-selected', 'true');
    await page.keyboard.press('Delete'); await expect.poll(() => deletes.length).toBe(2); expect(deletes[1].status).toBe(200);
    expect(deletes[1].command.commandId).not.toBe(deletes[0].command.commandId);
    expect(deletes[1].command.expected.items[image.item.id]).toEqual({ kind: 'image', image: rotated.images![0]!.versionId, pose: rotated.images![0]!.item.versionId });
    const after = await workspace.state(); expect(after.groups).toEqual([]); expect(after.images).toEqual([]);
    expect(after.project.revision).toBe(before.project.revision + 2);
  } finally { release(); await page.unrouteAll({ behavior: 'wait' }); }
});

test('Shape键盘resize原transform ACK等待后Shift Card再Delete保尺寸确认和内容', async ({ page, workspace }) => {
  const projectId = (await workspace.state()).project.id;
  await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'thought.create', expected: null,
    payload: { id: 'resize-card', title: '尺寸同行卡', text: '完整正文', x: 100, y: 120 } });
  await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'shape.create', expected: null,
    payload: { id: 'resize-shape', content: { shapeType: 'ellipse', shortText: '待确认尺寸' }, pose: { x: 720, y: 120, width: 160, height: 100 } } });
  const layout = page.waitForResponse(response => response.url().endsWith('/api/mapping/execute') && response.request().postDataJSON()?.type === 'card.layout');
  await page.reload(); expect((await layout).status()).toBe(200); await expect(page.getByRole('status')).toHaveText('已保存到本机');
  const before = await workspace.state(), shape = before.shapes![0]!, card = before.cards[0]!;
  expect(before.groups).toEqual([]); expect(before.containment).toEqual([]);
  let release!: () => void, holding = false, delivered = false;
  const gate = new Promise<void>(resolve => { release = resolve; }), deletes: any[] = [], transforms: any[] = [];
  page.on('response', response => { if (response.url().endsWith('/api/mapping/execute') && response.request().postDataJSON()?.type === 'shape.transform') delivered = true; });
  await page.route('**/api/mapping/execute', async route => {
    const command = route.request().postDataJSON();
    if (command.type === 'shape.transform') {
      const response = await route.fetch(); expect(response.status()).toBe(200); transforms.push({ command, receipt: await response.json() }); holding = true;
      await gate; await route.fulfill({ response });
    } else if (command.type === 'canvas.delete-selection') {
      const response = await route.fetch(); deletes.push({ command, status: response.status() }); await route.fulfill({ response });
    } else await route.continue();
  });
  await page.route('**/api/mapping/projects/' + projectId + '/**', async route => { if (holding && !delivered) await gate; await route.continue(); });
  try {
    const visual = page.getByRole('img', { name: '待确认尺寸', exact: true }); await visual.click(); await expect(visual).toBeFocused();
    for (let index = 0; index < 4; index++) await page.keyboard.press('Tab');
    await expect(page.getByRole('button', { name: '调整形状尺寸：右下', exact: true })).toBeFocused();
    await page.keyboard.press('ArrowRight'); await expect.poll(() => holding).toBe(true); expect(delivered).toBe(false);
    await page.getByRole('button', { name: '尺寸同行卡', exact: true }).click({ modifiers: ['Shift'] });
    await expect.poll(() => page.locator('.react-flow__node.selected').evaluateAll(nodes => nodes.map(node => (node as HTMLElement).dataset.id).sort())).toEqual([shape.item.id, card.item.id].sort());
    await expect(page.locator('.workspace')).toHaveAttribute('data-revision', String(before.project.revision));
    const resized = await workspace.state(); expect(resized.shapes![0]!.item.pose).toEqual({ ...shape.item.pose, width: 161 });
    expect(resized.shapes![0]!.content).toEqual(shape.content);
    await page.keyboard.press('Delete'); await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    expect(deletes).toEqual([]); expect(delivered).toBe(false);
    release(); await expect.poll(() => deletes.length).toBe(1); expect(deletes[0].status).toBe(200);
    expect(deletes[0].command.expected.items[shape.item.id].pose).toBe(transforms[0].receipt.shapeVersions.pose);
    expect(deletes[0].command.expected.items[shape.item.id].shape).toBe(shape.versionId);
    expect(deletes[0].command.expected.containment).toEqual({ [shape.item.id]: null, [card.item.id]: null });
    const after = await workspace.state(); expect(after.cards).toEqual([]); expect(after.shapes).toEqual([]);
    expect(after.project.revision).toBe(before.project.revision + 2); expect(transforms).toHaveLength(1);
  } finally { release(); await page.unrouteAll({ behavior: 'wait' }); }
});
