import { test, expect } from './writing-board-fixture';
import { trustedMouse, node, nodePoint, history, zoom, selectGroup, seedGroup, center, offset, writes, preview, savedGroup, publicCanvasProbe, type CanvasProbeSnapshot } from './group-gesture-fixture';

test('Group独立mouseup最终坐标提交完整70,20，最后mousemove仅40,0', async ({ page, workspace }) => {
  const { before, cardId, shapeId, timeline } = await seedGroup(page, workspace), commands = writes(page);
  const mouse = await trustedMouse(page), start = await center(page, shapeId);
  try {
    console.log('ISSUE28_LITERAL_INPUT', JSON.stringify({ start, move: offset(start, 40, 0), release: offset(start, 70, 20) }));
    await mouse.start(start); await mouse.move(offset(start, 40, 0));
    await preview(page, workspace, before, { x: 140, y: 160 }, { x: 460, y: 200 });
    expect(commands).toEqual([]);
    await mouse.up(offset(start, 70, 20));
    const trace = await mouse.trace(), down = trace.find(value => value.type === 'mousedown')!, up = trace.at(-1)!;
    expect(trace.slice(trace.indexOf(down)).map(value => value.type)).toEqual(['mousedown', 'mousemove', 'mouseup']);
    expect({ x: up.x - down.x, y: up.y - down.y }).toEqual({ x: 70, y: 20 });
    await expect(node(page, cardId)).toHaveClass(/selected/); await expect(node(page, shapeId)).toHaveClass(/selected/);
    await savedGroup(page, workspace, before, timeline, commands, 70, 20);
  } finally { await mouse.close(); }
});

test('单Card静止Alt重算吸附并以独立mouseup最终点沿原pose.move保存', async ({ page, workspace }) => {
  const projectId = (await workspace.state()).project.id;
  for (const [id, title, x, y] of [['snap-card', '吸附卡', 60, 100], ['snap-ref', '吸附参照', 610, 400]] as const) {
    await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'thought.create', expected: null, payload: { id, title, text: '', x, y } });
  }
  const layouts = ['snap-card', 'snap-ref'].map(id => page.waitForResponse(response => response.url().endsWith('/api/mapping/execute') &&
    response.request().postDataJSON()?.type === 'card.layout' && response.request().postDataJSON()?.payload.id === id));
  await page.reload(); for (const layout of layouts) expect((await layout).status()).toBe(200);
  await expect(page.getByRole('status')).toHaveText('已保存到本机');
  const measured = await workspace.state();
  await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'pose.batch',
    expected: Object.fromEntries(measured.cards.map(value => [value.id, value.item.versionId])),
    payload: { poses: measured.cards.map(value => ({ id: value.id, ...value.item.pose, width: 280, height: 180 })) } });
  await expect.poll(async () => (await node(page, measured.cards[0]!.item.id).boundingBox())!.height).toBe(180);
  await page.getByRole('button', { name: '吸附卡', exact: true }).click(); await expect(page.getByRole('status')).toHaveText('已保存到本机');
  const before = await workspace.state(), timeline = await history(page, workspace, projectId);
  expect(before.cards.map(value => value.item.pose)).toEqual([{ x: 60, y: 100, width: 280, height: 180 }, { x: 610, y: 400, width: 280, height: 180 }]);
  for (const card of before.cards) {
    const measuredBox = (await node(page, card.item.id).boundingBox())!; expect(measuredBox.width).toBe(280); expect(measuredBox.height).toBe(180);
  }
  await expect(page.getByRole('button', { name: '对齐吸附', exact: true })).toHaveAttribute('aria-pressed', 'true');
  const box = (await node(page, before.cards[0]!.item.id).boundingBox())!, start = { x: box.x + 80, y: box.y + box.height - 12 };
  const commands = writes(page), mouse = await trustedMouse(page);
  try {
    await mouse.start(start); await mouse.move(offset(start, 273, 93));
    await expect.poll(() => nodePoint(page, before.cards[0]!.item.id)).toEqual({ x: 330, y: 193 });
    await expect(page.locator('.alignment-guide[data-axis="x"]')).toHaveCount(1); expect(await workspace.state()).toEqual(before); expect(commands).toEqual([]);
    await page.keyboard.down('Alt'); await expect.poll(() => nodePoint(page, before.cards[0]!.item.id)).toEqual({ x: 333, y: 193 });
    await expect(page.locator('.alignment-guide')).toHaveCount(0);
    await page.keyboard.up('Alt'); await expect.poll(() => nodePoint(page, before.cards[0]!.item.id)).toEqual({ x: 330, y: 193 });
    await expect(page.locator('.alignment-guide[data-axis="x"]')).toHaveCount(1);
    await page.keyboard.down('Alt'); await mouse.up(offset(start, 279, 93), true); await page.keyboard.up('Alt');
    const trace = await mouse.trace(), down = trace.find(value => value.type === 'mousedown')!, up = trace.at(-1)!;
    expect(trace.filter(value => value.type === 'mousemove' && value.buttons === 1)).toHaveLength(1);
    expect({ x: up.x - down.x, y: up.y - down.y, alt: up.alt }).toEqual({ x: 279, y: 93, alt: true });
    await expect.poll(async () => (await workspace.state()).cards[0]!.item.pose).toEqual({ x: 339, y: 193, width: 280, height: 180 });
    const after = await workspace.state(); expect(after.cards[1]).toEqual(before.cards[1]);
    expect(after.cards[0]).toEqual({ ...before.cards[0]!, item: { ...before.cards[0]!.item, versionId: after.cards[0]!.item.versionId, pose: { x: 339, y: 193, width: 280, height: 180 } } });
    expect(commands).toHaveLength(1); expect(commands[0].type).toBe('pose.move'); expect(after.project.revision).toBe(before.project.revision + 1);
    expect((await history(page, workspace, projectId)).undo).toHaveLength(timeline.undo.length + 1);
    await page.getByRole('button', { name: '撤销', exact: true }).click(); await expect.poll(async () => (await workspace.state()).cards[0]!.item.pose).toEqual(before.cards[0]!.item.pose);
    await page.getByRole('button', { name: '重做', exact: true }).click(); await expect.poll(async () => (await workspace.state()).cards[0]!.item.pose).toEqual(after.cards[0]!.item.pose);
  } finally { await page.keyboard.up('Alt'); await mouse.close(); }
});

for (const zoomed of [false, true]) {
  test(`Group${zoomed ? '缩小后' : 'zoom1'}的2/3/4CSS阈值保持点击语义与完整位移`, async ({ page, workspace }) => {
    const { before, shapeId, timeline } = await seedGroup(page, workspace);
    let z = await zoom(page);
    if (zoomed) {
      await page.getByRole('button', { name: '缩小', exact: true }).click();
      let previous = 1, stable = 0;
      await expect.poll(async () => { z = await zoom(page); stable = Math.abs(previous - z) < 1e-9 ? stable + 1 : 0; previous = z; return z < 1 && stable >= 2; }).toBe(true);
    } else expect(z).toBe(1);
    const commands = writes(page), mouse = await trustedMouse(page);
    try {
      for (const distance of [2, 3, 4]) {
        await selectGroup(page); const start = await center(page, shapeId);
        await mouse.start(start); await mouse.move(offset(start, distance, 0));
        expect(await workspace.state()).toEqual(before); expect(commands).toEqual([]);
        if (distance === 4) {
          await expect.poll(async () => (await nodePoint(page, before.cards[0]!.item.id)).x).toBeCloseTo(100 + 4 / z, 4);
          await expect.poll(async () => (await nodePoint(page, shapeId)).x).toBeCloseTo(420 + 4 / z, 4);
        } else {
          for (const [id, x, y] of [[before.cards[0]!.item.id, 100, 160], [shapeId, 420, 200]] as const) {
            await expect.poll(async () => (await nodePoint(page, id)).x).toBeCloseTo(x, 4);
            await expect.poll(async () => (await nodePoint(page, id)).y).toBeCloseTo(y, 4);
          }
        }
        await mouse.up(offset(start, distance, 0)); await mouse.trace();
        if (distance < 4) {
          expect(await workspace.state()).toEqual(before); expect(commands).toEqual([]); expect(await history(page, workspace, before.project.id)).toEqual(timeline);
          await expect(page.locator('.react-flow__node.selected')).toHaveCount(1);
          await expect(node(page, shapeId)).toHaveClass(/selected/); await expect(node(page, before.cards[0]!.item.id)).not.toHaveClass(/selected/);
          await expect(page.getByRole('button', { name: '进入组合', exact: true })).toHaveCount(0);
          await expect(page.getByRole('group', { name: '组合', exact: true })).toBeVisible();
          await expect(page.getByRole('group', { name: '组合', exact: true })).toHaveAttribute('data-selected', 'false');
        }
        else {
          await expect(page.locator('.react-flow__node.selected')).toHaveCount(2);
          await expect(page.getByRole('button', { name: '进入组合', exact: true })).toBeVisible();
          await savedGroup(page, workspace, before, timeline, commands, 4 / z, 0);
        }
      }
    } finally { await mouse.close(); }
  });
}

test('Group armed小位移的Esc/blur/pointercancel保零写并消费尾随click，新独立click仍可进入成员', async ({ page, workspace }) => {
  const { before, cardId, shapeId, timeline } = await seedGroup(page, workspace), commands = writes(page);
  const mouse = await trustedMouse(page);
  try {
    for (const cancel of ['Escape', 'blur', 'pointercancel']) {
      await selectGroup(page); const start = await center(page, shapeId);
      await mouse.start(start); await mouse.move(offset(start, 2, 0));
      await preview(page, workspace, before, { x: 100, y: 160 }, { x: 420, y: 200 });
      if (cancel === 'Escape') await page.keyboard.press('Escape');
      else if (cancel === 'blur') await page.evaluate(() => window.dispatchEvent(new Event('blur')));
      else await node(page, shapeId).dispatchEvent('pointercancel');
      await mouse.up(offset(start, 2, 0)); await mouse.trace();
      await expect(node(page, cardId)).toHaveClass(/selected/); await expect(node(page, shapeId)).toHaveClass(/selected/);
      expect(await workspace.state()).toEqual(before); expect(await history(page, workspace, before.project.id)).toEqual(timeline);
      expect(commands).toEqual([]);
      await node(page, shapeId).click();
      await expect(page.locator('.react-flow__node.selected')).toHaveCount(1);
      await expect(node(page, shapeId)).toHaveClass(/selected/); await expect(node(page, cardId)).not.toHaveClass(/selected/);
    }
  } finally { await mouse.close(); }
});

test('Group直接up原点零写，Esc恢复后迟到up不提交且新手势可保存', async ({ page, workspace }) => {
  const { before, shapeId, timeline } = await seedGroup(page, workspace), commands = writes(page), mouse = await trustedMouse(page);
  try {
    const start = await center(page, shapeId);
    await mouse.start(start); await mouse.move(offset(start, 20, 10));
    await preview(page, workspace, before, { x: 120, y: 170 }, { x: 440, y: 210 });
    expect(commands).toEqual([]);
    await mouse.up(start); await mouse.trace(); expect(await workspace.state()).toEqual(before); expect(commands).toEqual([]);
    expect(await history(page, workspace, before.project.id)).toEqual(timeline); await expect(page.locator('.react-flow__node.selected')).toHaveCount(2);
    await mouse.start(start); await mouse.move(offset(start, 32, 24));
    await preview(page, workspace, before, { x: 132, y: 184 }, { x: 452, y: 224 });
    expect(commands).toEqual([]);
    await page.keyboard.press('Escape');
    await preview(page, workspace, before, { x: 100, y: 160 }, { x: 420, y: 200 });
    await expect(page.locator('.react-flow__node.selected')).toHaveCount(2);
    await mouse.up(offset(start, 90, 60)); await mouse.trace(); expect(await workspace.state()).toEqual(before); expect(commands).toEqual([]);
    expect(await history(page, workspace, before.project.id)).toEqual(timeline); await expect(page.locator('.react-flow__node.selected')).toHaveCount(2);
    await mouse.start(start); await mouse.move(offset(start, 40, 20)); await mouse.up(offset(start, 40, 20)); await mouse.trace();
    await savedGroup(page, workspace, before, timeline, commands, 40, 20);
  } finally { await mouse.close(); }
});

test('Group autoPan在停止鼠标move后保世界位移，按真实up矩阵一次保存并撤销重做', async ({ page, workspace }) => {
  const { before, cardId, shapeId, timeline } = await seedGroup(page, workspace);
  const commands = writes(page), mouse = await trustedMouse(page), probe = await publicCanvasProbe(page);
  const held: CanvasProbeSnapshot[] = [], released: CanvasProbeSnapshot[] = [];
  try {
    const start = await center(page, shapeId);
    await mouse.start(start);
    const down = (await probe.events()).find(event => event.type === 'mousedown')!;
    expect(down.trusted).toBe(true); expect(down.sample.viewport).toMatchObject({ a: 1, b: 0, c: 0, d: 1 });
    const z = down.sample.viewport.a, edge = { x: down.sample.flow.x + down.sample.flow.width - 2, y: start.y };
    await mouse.move(offset(start, 8, 0));
    await mouse.move(edge);
    const edgeSnapshot = await probe.sample(), pressedMoves = (await probe.events()).filter(event => event.type === 'mousemove' && event.buttons === 1);
    expect(pressedMoves).toHaveLength(2);
    expect({ x: pressedMoves[0]!.client.x - down.client.x, y: pressedMoves[0]!.client.y - down.client.y }).toEqual({ x: 8, y: 0 });
    expect(pressedMoves[1]!.client).toEqual(edge);
    const lastClient = pressedMoves[1]!.client;
    for (let index = 0; index < 12; index++) {
      await page.waitForTimeout(100); const sample = await probe.sample(); held.push(sample);
      expect(sample.viewport).toMatchObject({ a: z, b: 0, c: 0, d: z }); expect(sample.flow).toEqual(down.sample.flow);
      expect(sample.nodes.map(value => value.id).sort()).toEqual([cardId, shapeId].sort());
      const dx = ((lastClient.x - down.client.x) - (sample.viewport.e - down.sample.viewport.e)) / z;
      const dy = ((lastClient.y - down.client.y) - (sample.viewport.f - down.sample.viewport.f)) / z;
      for (const [id, x, y] of [[cardId, 100, 160], [shapeId, 420, 200]] as const) {
        const value = sample.nodes.find(node => node.id === id)!;
        expect(value.world.x).toBeCloseTo(x + dx, 4); expect(value.world.y).toBeCloseTo(y + dy, 4); expect(value.selected).toBe(true);
      }
      expect(commands).toEqual([]); expect(await workspace.state()).toEqual(before);
      expect(await history(page, workspace, before.project.id)).toEqual(timeline);
    }
    expect(held.some(sample => sample.viewport.e !== edgeSnapshot.viewport.e || sample.viewport.f !== edgeSnapshot.viewport.f)).toBe(true);
    expect((await probe.events()).filter(event => event.type === 'mousemove')).toHaveLength(3);
    expect(commands).toEqual([]); expect(await workspace.state()).toEqual(before);
    expect(await history(page, workspace, before.project.id)).toEqual(timeline);
    await mouse.up(edge);
    const inputEvents = await probe.events(), up = inputEvents.find(event => event.type === 'mouseup')!;
    expect(up.trusted).toBe(true); expect(up.client).toEqual(edge); expect(up.buttons).toBe(0);
    expect(up.sample.viewport).toMatchObject({ a: z, b: 0, c: 0, d: z }); expect(up.sample.flow).toEqual(down.sample.flow);
    expect(inputEvents.map(event => event.type)).toEqual(['mousemove', 'mousedown', 'mousemove', 'mousemove', 'mouseup']);
    const dx = ((up.client.x - down.client.x) - (up.sample.viewport.e - down.sample.viewport.e)) / z;
    const dy = ((up.client.y - down.client.y) - (up.sample.viewport.f - down.sample.viewport.f)) / z;
    let stable = 0, previous = '';
    for (let index = 0; index < 16 && stable < 3; index++) {
      await page.waitForTimeout(100); const sample = await probe.sample(); released.push(sample);
      expect(sample.viewport).toMatchObject({ a: z, b: 0, c: 0, d: z }); expect(sample.flow).toEqual(down.sample.flow);
      const signature = JSON.stringify({ viewport: sample.viewport, nodes: sample.nodes });
      stable = signature === previous ? stable + 1 : 0; previous = signature;
    }
    expect(stable).toBe(3);
    for (const [id, x, y] of [[cardId, 100, 160], [shapeId, 420, 200]] as const) {
      const value = released.at(-1)!.nodes.find(node => node.id === id)!;
      expect(value.world.x).toBeCloseTo(x + dx, 4); expect(value.world.y).toBeCloseTo(y + dy, 4); expect(value.selected).toBe(true);
    }
    console.log('ISSUE28_AUTOPAN_FORMAL_ORACLE', JSON.stringify({ down, edgeSnapshot, held, up, released, inputEvents, dx, dy }));
    await savedGroup(page, workspace, before, timeline, commands, dx, dy);
  } finally {
    console.log('ISSUE28_AUTOPAN_FORMAL_SAMPLES', JSON.stringify({ held, released, events: await probe.events() }));
    try { await mouse.close(); } finally { await probe.close(); }
  }
});
