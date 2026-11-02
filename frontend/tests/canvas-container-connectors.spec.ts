import { test, expect } from './writing-board-fixture';
import { connectorSvgEnds, connectorWorldPoint } from './connector-ui-fixture';

test('Card与容器单端连线支持两向Shift共同选择并将副本重新绑定新Card', async ({ page, workspace }, info) => {
  const projectId = (await workspace.state()).project.id;
  await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'thought.create', expected: null,
    payload: { id: 'mixed-card', title: '混合复制卡片', text: '独立副本正文', x: 500, y: 150 } });
  await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'frame.create',
    expected: { frame: null, groups: {}, containment: {}, poses: {} }, payload: { id: 'mixed-frame', itemIds: [], pose: { x: 100, y: 150, width: 200, height: 160 } } });
  const seeded = await workspace.state(), card = seeded.cards[0]!;
  await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'connector.create', expected: null,
    payload: { id: 'mixed-line', path: 'curve', start: { kind: 'bound', targetKind: 'frame', itemId: 'mixed-frame', side: 'right' },
      end: { kind: 'bound', itemId: card.item.id, side: 'left' } } });
  await page.reload(); await expect(page.getByRole('status')).toHaveText('已保存到本机');
  const cardButton = page.getByRole('button', { name: '混合复制卡片', exact: true });
  const lineButton = page.getByRole('button', { name: '普通连线', exact: true });
  const selectedCard = page.locator(`.react-flow__node[data-id="${card.item.id}"].selected`);
  await cardButton.click(); await lineButton.click({ modifiers: ['Shift'] });
  await expect(selectedCard).toHaveCount(1, { timeout: 3000 });
  await expect(lineButton).toHaveAttribute('aria-pressed', 'true');
  await lineButton.click(); await expect(selectedCard).toHaveCount(0);
  await cardButton.click({ modifiers: ['Shift'] });
  await expect(selectedCard).toHaveCount(1); await expect(lineButton).toHaveAttribute('aria-pressed', 'true');
  await cardButton.click(); await expect(lineButton).toHaveAttribute('aria-pressed', 'false');
  await lineButton.click({ modifiers: ['Shift'] });
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  const originalClipboard = await page.evaluate(async () => Promise.all((await navigator.clipboard.read()).filter(item => item.types.length).map(async item =>
    Promise.all(item.types.map(async type => ({ type, bytes: Array.from(new Uint8Array(await (await item.getType(type)).arrayBuffer())) }))))));
  let owned = '';
  try {
    const read = () => page.evaluate(async () => {
      try {
        const item = (await navigator.clipboard.read()).find(value => value.types.includes('web application/x-forkwise-canvas'));
        return item ? await (await item.getType('web application/x-forkwise-canvas')).text() : '';
      } catch (error) {
        if (error instanceof DOMException && error.name === 'InvalidStateError') return '';
        throw error;
      }
    });
    await cardButton.click();
    await page.getByRole('button', { name: '复制', exact: true }).click();
    await page.getByRole('menuitem', { name: '复制到剪贴板', exact: true }).click();
    await expect.poll(async () => {
      const raw = await read(), value = JSON.parse(raw || '{}');
      if (value.objects?.length !== 1 || value.objects[0].itemId !== card.item.id || value.connectors?.length !== 0) return false;
      owned = raw; return true;
    }).toBe(true);
    expect(JSON.parse(owned).connectors).toEqual([]);
    await lineButton.click({ modifiers: ['Shift'] });
    await page.getByRole('button', { name: '复制', exact: true }).click();
    await page.getByRole('menuitem', { name: '复制到剪贴板', exact: true }).click();
    await expect.poll(async () => {
      const raw = await read(), value = JSON.parse(raw || '{}');
      if (value.objects?.length !== 1 || value.objects[0].itemId !== card.item.id || value.connectors?.length !== 1) return false;
      owned = raw; return true;
    }).toBe(true);
    const frozen = JSON.parse(owned);
    expect(frozen.objects).toHaveLength(1); expect(frozen.connectors).toHaveLength(1);
    expect(frozen.objects[0]).toMatchObject({ kind: 'card', sourceId: 'mixed-card', itemId: card.item.id });
    expect(frozen.connectors[0].start).toEqual({ kind: 'free', point: { x: 300, y: 230 } });
    expect(frozen.connectors[0].end).toEqual({ kind: 'bound', itemId: card.item.id, side: 'left' });
    const before = await workspace.state();
    await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'frame.move',
      expected: { frame: before.frames![0]!.versionId, groups: {}, containment: {}, poses: {} }, payload: { id: 'mixed-frame', dx: 100, dy: 50 } });
    await page.reload(); await expect(page.getByRole('status')).toHaveText('已保存到本机');
    const pane = (await page.locator('.react-flow__pane').boundingBox())!;
    await page.mouse.move(pane.x + 650, pane.y + 450); await page.locator('.canvas').press('Meta+v');
    await expect.poll(async () => (await workspace.state()).cards.length).toBe(2);
    const after = await workspace.state(), copy = after.cards.find(value => value.id !== card.id)!;
    const copiedLine = after.connectors!.find(value => value.id !== 'mixed-line')!;
    const dx = copy.item.pose.x - card.item.pose.x, dy = copy.item.pose.y - card.item.pose.y;
    expect(copiedLine.start).toEqual({ kind: 'free', point: { x: 300 + dx, y: 230 + dy } });
    expect(copiedLine.end).toEqual({ kind: 'bound', itemId: copy.item.id, side: 'left' });
    expect(copiedLine.path).toBe('curve'); expect(copy.body.blocks.map(block => block.text).join('')).toBe('独立副本正文');
    await page.locator(`.react-flow__node[data-id="${copy.item.id}"]`).getByRole('button', { name: '移动卡片：方向键调整位置', exact: true }).press('ArrowRight');
    await expect.poll(async () => (await workspace.state()).cards.find(value => value.id === copy.id)!.item.pose.x).toBe(copy.item.pose.x + 10);
    const moved = await workspace.state();
    expect(moved.connectors).toEqual(after.connectors);
    expect(moved.cards.find(value => value.id === card.id)).toEqual(after.cards.find(value => value.id === card.id));
    await workspace.restart(); await workspace.open(page); expect(await workspace.state()).toEqual(moved);
  } finally {
    const restored = await page.evaluate(async ({ original, owned }) => {
      let current: string;
      try {
        const item = (await navigator.clipboard.read()).find(value => value.types.includes('web application/x-forkwise-canvas'));
        if (!owned || !item) return 'external change retained';
        current = await (await item.getType('web application/x-forkwise-canvas')).text();
      } catch (error) {
        if (error instanceof DOMException && error.name === 'InvalidStateError') return 'clipboard changed during cleanup; external value retained';
        throw error;
      }
      if (current !== owned) return 'external change retained';
      if (original.length) await navigator.clipboard.write(original.map(items => new ClipboardItem(Object.fromEntries(items.map(value => [value.type, new Blob([new Uint8Array(value.bytes)], { type: value.type })])))));
      else await navigator.clipboard.writeText('');
      return 'restored original browser-exposed flavors only; comparison and write are not atomic';
    }, { original: originalClipboard, owned });
    await info.attach('clipboard-scope', { body: restored, contentType: 'text/plain' });
    console.log('issue30-mixed-clipboard-closeout', restored);
  }
});

for (const kind of ['shape', 'image', 'stroke', 'text'] as const) test(`${kind}显式Shift选择与普通连线共存，普通点击清除连线选择`, async ({ page, workspace }) => {
  const projectId = (await workspace.state()).project.id;
  if (kind === 'image') {
    const chooser = page.waitForEvent('filechooser'); await page.getByRole('button', { name: '图片', exact: true }).click();
    await (await chooser).setFiles({ name: '混选.svg', mimeType: 'image/svg+xml', buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="100" height="60"><rect width="100" height="60" fill="green"/></svg>') });
    await expect.poll(async () => (await workspace.state()).images!.length).toBe(1);
  } else {
    const payload = kind === 'shape' ? { id: 'mixed-object', content: { shapeType: 'rectangle', shortText: '混选形状' }, pose: { x: 400, y: 180, width: 160, height: 80 } }
      : kind === 'stroke' ? { id: 'mixed-object', content: { penKind: 'pen', color: '#403b36', width: 4, opacity: 1, path: [{ x: 2, y: 2 }, { x: 158, y: 78 }] }, pose: { x: 400, y: 180, width: 160, height: 80 } }
      : { id: 'mixed-object', content: { runs: [{ text: '混选文字' }], fontSize: 18, lineHeight: 1.5, align: 'left', widthMode: 'fixed', width: 160 }, pose: { x: 400, y: 180, width: 160, height: 27 } };
    await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: kind + '.create', expected: null, payload });
  }
  await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'connector.create', expected: null,
    payload: { id: 'object-line', start: { kind: 'free', point: { x: 100, y: 400 } }, end: { kind: 'free', point: { x: 600, y: 400 } } } });
  await page.reload(); await expect(page.getByRole('status')).toHaveText('已保存到本机');
  const state = await workspace.state();
  const item = kind === 'image' ? state.images![0]!.item : kind === 'shape' ? state.shapes![0]!.item : kind === 'stroke' ? state.strokes![0]!.item : state.texts![0]!.item;
  const object = kind === 'image' ? page.getByRole('img', { name: '混选.svg', exact: true }) : kind === 'shape' ? page.getByRole('img', { name: '混选形状', exact: true })
    : kind === 'stroke' ? page.getByRole('button', { name: '选择普通笔笔迹', exact: true }) : page.getByRole('group', { name: '独立文字：方向键调整位置，Enter编辑', exact: true });
  const line = page.getByRole('button', { name: '普通连线', exact: true }), selected = page.locator(`.react-flow__node[data-id="${item.id}"].selected`);
  await object.click(); await line.click({ modifiers: ['Shift'] });
  await expect(selected).toHaveCount(1); await expect(line).toHaveAttribute('aria-pressed', 'true');
  await line.click(); await expect(selected).toHaveCount(0); await object.click({ modifiers: ['Shift'] });
  await expect(selected).toHaveCount(1); await expect(line).toHaveAttribute('aria-pressed', 'true');
  await object.click(); await expect(line).toHaveAttribute('aria-pressed', 'false');
  expect((await workspace.state()).connectors).toEqual(state.connectors);
});

test('混选连线不复活旧分区选择，多线Delete不回落删除Card，Shift选Card取消编辑草稿', async ({ page, workspace }) => {
  const projectId = (await workspace.state()).project.id;
  await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'thought.create', expected: null,
    payload: { id: 'protected-mixed-card', title: '混选保护卡', text: '保护正文', x: 600, y: 180 } });
  await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'frame.create',
    expected: { frame: null, groups: {}, containment: {}, poses: {} }, payload: { id: 'protected-frame', itemIds: [], pose: { x: 100, y: 150, width: 200, height: 160 } } });
  for (const [id, y] of [['first', 400], ['second', 500]] as const)
    await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'connector.create', expected: null,
      payload: { id, start: { kind: 'free', point: { x: 100, y } }, end: { kind: 'free', point: { x: 400, y } } } });
  await page.reload(); await expect(page.getByRole('status')).toHaveText('已保存到本机');
  const frame = page.locator('[data-frame-id="protected-frame"]'), first = page.locator('[data-connector-id="first"]'), second = page.locator('[data-connector-id="second"]');
  await page.getByRole('button', { name: '分区1', exact: true }).click(); await expect(frame).toHaveAttribute('data-selected', 'true');
  await first.click({ modifiers: ['Shift'] }); await first.click({ modifiers: ['Shift'] });
  await expect(frame).toHaveAttribute('data-selected', 'false');
  await expect(page.getByRole('button', { name: '删除分区', exact: true })).toHaveCount(0);
  const card = page.getByRole('button', { name: '混选保护卡', exact: true }); await card.click();
  await first.click({ modifiers: ['Shift'] }); await second.click({ modifiers: ['Shift'] });
  const before = await workspace.state();
  await page.keyboard.press('Delete');
  await first.click({ modifiers: ['Shift'] }); await expect(first).toHaveAttribute('aria-pressed', 'false');
  await expect(second).toHaveAttribute('aria-pressed', 'true'); await page.keyboard.press('Delete');
  await expect.poll(async () => (await workspace.state()).connectors!.map(value => value.id)).toEqual(['first']);
  const deleted = await workspace.state(); expect(deleted.cards).toEqual(before.cards); expect(deleted.frames).toEqual(before.frames);
  await first.click(); await page.getByRole('button', { name: '移动连线', exact: true }).click(); await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('img', { name: '连线预览', exact: true })).toBeVisible();
  await card.click({ modifiers: ['Shift'] }); await expect(first).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('img', { name: '连线预览', exact: true })).toHaveCount(0);
  await page.keyboard.press('Enter'); expect(await workspace.state()).toEqual(deleted);
});

test('点击Group成员取消连线键盘草稿并保留线选择，晚到Enter不提交', async ({ page, workspace }) => {
  const projectId = (await workspace.state()).project.id;
  for (const [id, x, name] of [['cancel-a', 400, '取消成员甲'], ['cancel-b', 580, '取消成员乙']] as const)
    await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'shape.create', expected: null,
      payload: { id, content: { shapeType: 'rectangle', shortText: name }, pose: { x, y: 180, width: 100, height: 60 } } });
  const seeded = await workspace.state(), ids = seeded.shapes!.map(value => value.item.id);
  await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'group.create',
    expected: { groups: { 'cancel-group': null }, containment: Object.fromEntries(ids.map(id => [id, null])) },
    payload: { id: 'cancel-group', itemIds: ids } });
  await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'connector.create', expected: null,
    payload: { id: 'cancel-group-line', start: { kind: 'free', point: { x: 100, y: 400 } }, end: { kind: 'free', point: { x: 800, y: 400 } } } });
  await page.reload(); await expect(page.getByRole('status')).toHaveText('已保存到本机');
  const before = await workspace.state(), historyUrl = workspace.origin + '/api/mapping/projects/' + projectId + '/history';
  const beforeHistory = await (await page.request.get(historyUrl)).json(), attempts: unknown[] = [];
  page.on('request', request => { if (request.url().endsWith('/api/mapping/execute') && request.method() === 'POST') attempts.push(request.postDataJSON()); });
  const line = page.getByRole('button', { name: '普通连线', exact: true }), member = page.getByRole('img', { name: '取消成员甲', exact: true });
  await line.click(); await page.getByRole('button', { name: '移动连线', exact: true }).click(); await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('img', { name: '连线预览', exact: true })).toBeVisible();
  await member.click(); await expect(line).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('img', { name: '连线预览', exact: true })).toHaveCount(0);
  await page.locator('.canvas').press('Enter');
  await member.click(); await expect(line).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.react-flow__node.selected')).toHaveCount(1);
  expect(await workspace.state()).toEqual(before); expect(await (await page.request.get(historyUrl)).json()).toEqual(beforeHistory);
  expect(attempts).toEqual([]);
});

test('组本体和成员分别提供键盘连线入口，解组冻结真实外框端点', async ({ page, workspace }) => {
  const projectId = (await workspace.state()).project.id;
  for (const [id, x] of [['a', 200], ['b', 400]] as const)
    await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'shape.create', expected: null,
      payload: { id, content: { shapeType: 'rectangle', shortText: id }, pose: { x, y: 180, width: 100, height: 60 } } });
  const before = await workspace.state();
  await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'group.create', expected: { groups: { g: null },
    containment: Object.fromEntries(before.shapes!.map(shape => [shape.item.id, null])) }, payload: { id: 'g', itemIds: before.shapes!.map(shape => shape.item.id) } });
  await page.reload(); await expect(page.getByRole('status')).toHaveText('已保存到本机');
  await page.getByRole('button', { name: '连线', exact: true }).click();
  const target = page.getByRole('button', { name: '组合 连线起点：右', exact: true });
  await expect(target).toBeVisible({ timeout: 3000 });
  await expect(page.getByRole('button', { name: '形状 a 连线起点：右', exact: true })).toBeVisible();
  await target.focus(); await page.keyboard.press('Enter');
  await page.getByRole('button', { name: '连线自由终点', exact: true }).press('ArrowRight');
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await workspace.state()).connectors!.length).toBe(1);
  const saved = await workspace.state(), group = saved.groups![0]!, line = saved.connectors![0]!;
  expect(line.start).toEqual({ kind: 'bound', targetKind: 'group', itemId: group.itemId, side: 'right' });
  const path = page.locator('[data-connector-id="' + line.id + '"] path').last();
  const screen = (await connectorSvgEnds(path)).start;
  const point = await connectorWorldPoint(page, screen);
  expect(point.x).toBeCloseTo(510, 4); expect(point.y).toBeCloseTo(210, 4);
  await page.getByRole('button', { name: '选择', exact: true }).click();
  await page.getByRole('img', { name: 'a', exact: true }).click();
  await page.getByRole('button', { name: '取消组合', exact: true }).click();
  await expect.poll(async () => (await workspace.state()).groups!.length).toBe(0);
  const after = await workspace.state();
  expect(after.connectors![0]!.start).toEqual({ kind: 'free', point: { x: 510, y: 210 } });
  expect((await connectorSvgEnds(path)).start).toEqual(screen);
  await workspace.restart(); await workspace.open(page);
  expect(await workspace.state()).toEqual(after);
});

test('既有多Group选择取消所选组合只发一个事务并同时冻结两端', async ({ page, workspace }) => {
  const projectId = (await workspace.state()).project.id;
  for (const [id, x] of [['a', 100], ['b', 260], ['c', 600], ['d', 760]] as const)
    await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'shape.create', expected: null,
      payload: { id, content: { shapeType: 'rectangle', shortText: id }, pose: { x, y: 180, width: 100, height: 60 } } });
  for (const [id, names] of [['first', ['a', 'b']], ['second', ['c', 'd']]] as const) {
    const s = await workspace.state(), ids = s.shapes!.filter(shape => names.some(name => name === shape.id)).map(shape => shape.item.id);
    await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'group.create', expected: { groups: { [id]: null }, containment: Object.fromEntries(ids.map(id => [id, null])) }, payload: { id, itemIds: ids } });
  }
  const before = await workspace.state();
  await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'connector.create', expected: null,
    payload: { id: 'between', start: { kind: 'bound', targetKind: 'group', itemId: before.groups![0]!.itemId, side: 'right' }, end: { kind: 'bound', targetKind: 'group', itemId: before.groups![1]!.itemId, side: 'left' } } });
  await page.reload(); await expect(page.getByRole('status')).toHaveText('已保存到本机');
  await page.getByRole('img', { name: 'a', exact: true }).click();
  await page.getByRole('img', { name: 'c', exact: true }).click({ modifiers: ['Shift'] });
  const remove = page.getByRole('button', { name: '取消所选组合', exact: true });
  await expect(remove).toBeVisible({ timeout: 3000 });
  const commands: unknown[] = [];
  page.on('request', request => { if (request.url().endsWith('/api/mapping/execute') && request.method() === 'POST') commands.push(request.postDataJSON()); });
  await remove.click();
  await expect.poll(async () => (await workspace.state()).groups!.length).toBe(0);
  expect(commands).toHaveLength(1);
  expect(commands[0]).toMatchObject({ type: 'canvas.delete-selection', payload: { groupIds: [], directItemIds: [], ungroupIds: ['first', 'second'] } });
  const line = (await workspace.state()).connectors![0]!;
  expect(line.start).toEqual({ kind: 'free', point: { x: 370, y: 210 } });
  expect(line.end).toEqual({ kind: 'free', point: { x: 590, y: 210 } });
  const ungrouped = await workspace.state();
  expect(ungrouped.shapes).toHaveLength(4);
  await expect(page.getByRole('status')).toHaveText('已保存到本机');
  await expect(page.locator('.react-flow__node.selected')).toHaveCount(4, { timeout: 3000 });
  const first = page.getByRole('img', { name: 'a', exact: true }), box = (await first.boundingBox())!;
  await page.mouse.move(box.x + 30, box.y + 30); await page.mouse.down();
  await page.mouse.move(box.x + 110, box.y + 70, { steps: 5 }); await page.mouse.up();
  await expect.poll(async () => (await workspace.state()).shapes!.find(shape => shape.id === 'a')!.item.pose.x).toBe(180);
  const moved = await workspace.state();
  for (const shape of ungrouped.shapes!) expect(moved.shapes!.find(value => value.id === shape.id)!.item.pose).toEqual({ ...shape.item.pose, x: shape.item.pose.x + 80, y: shape.item.pose.y + 40 });
  expect(moved.connectors).toEqual(ungrouped.connectors);
  expect(commands).toHaveLength(2);
  expect(commands[1]).toMatchObject({ type: 'canvas.move', payload: { targets: expect.arrayContaining(['a', 'b', 'c', 'd'].map(id => expect.objectContaining({ kind: 'shape', id }))) } });
});

for (const kind of ['group', 'frame'] as const) test(`${kind}单线真实浏览器剪贴板复制后移动源再粘贴仍保复制时世界端点`, async ({ page, workspace }, info) => {
  const projectId = (await workspace.state()).project.id;
  for (const [id, x] of [['a', 200], ['b', 400]] as const)
    await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'shape.create', expected: null,
      payload: { id, content: { shapeType: 'rectangle', shortText: id }, pose: { x, y: 180, width: 100, height: 60 } } });
  const seeded = await workspace.state();
  if (kind === 'group') await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'group.create', expected: { groups: { g: null }, containment: Object.fromEntries(seeded.shapes!.map(shape => [shape.item.id, null])) }, payload: { id: 'g', itemIds: seeded.shapes!.map(shape => shape.item.id) } });
  else await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'frame.create', expected: { frame: null, groups: {}, containment: {}, poses: {} }, payload: { id: 'frame', itemIds: [], pose: { x: 200, y: 180, width: 100, height: 60 } } });
  const container = await workspace.state(), itemId = kind === 'group' ? container.groups![0]!.itemId : container.frames![0]!.id;
  await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'connector.create', expected: null, payload: { id: 'source-line',
    start: { kind: 'bound', targetKind: kind, itemId, side: 'right' }, end: { kind: 'free', point: { x: 900, y: 210 } } } });
  await page.reload(); await expect(page.getByRole('status')).toHaveText('已保存到本机');
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  const originalClipboard = await page.evaluate(async () => Promise.all((await navigator.clipboard.read()).filter(item => item.types.length).map(async item =>
    Promise.all(item.types.map(async type => ({ type, bytes: Array.from(new Uint8Array(await (await item.getType(type)).arrayBuffer())) }))))));
  let owned = '';
  try {
    await page.getByRole('button', { name: '普通连线', exact: true }).click();
    await page.keyboard.press('Meta+c');
    const read = () => page.evaluate(async () => { const item = (await navigator.clipboard.read()).find(item => item.types.includes('web application/x-forkwise-canvas')); return item ? (await item.getType('web application/x-forkwise-canvas')).text() : ''; });
    await expect.poll(read).toContain('forkwise-canvas-snapshot'); owned = await read();
    const frozen = JSON.parse(owned), x = kind === 'group' ? 510 : 300;
    expect(frozen.objects).toEqual([]);
    expect(frozen.connectors[0].start).toEqual({ kind: 'free', point: { x, y: 210 } });
    expect(frozen.connectors[0].end).toEqual({ kind: 'free', point: { x: 900, y: 210 } });
    expect(owned).not.toContain(itemId);
    const current = await workspace.state();
    if (kind === 'group') await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'group.move', expected: { group: current.groups![0]!.versionId,
      containment: Object.fromEntries(current.containment!.map(value => [value.id, value.versionId])), poses: Object.fromEntries(current.shapes!.map(value => [value.item.id, value.item.versionId])) }, payload: { id: 'g', dx: 100, dy: 30 } });
    else await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'frame.move', expected: { frame: current.frames![0]!.versionId, groups: {}, containment: {}, poses: {} }, payload: { id: 'frame', dx: 100, dy: 30 } });
    await page.reload(); await expect(page.getByRole('status')).toHaveText('已保存到本机');
    const commands: any[] = [];
    page.on('request', request => { if (request.url().endsWith('/api/mapping/execute') && request.postDataJSON()?.type === 'canvas.paste') commands.push(request.postDataJSON()); });
    const pane = (await page.locator('.react-flow__pane').boundingBox())!;
    await page.mouse.move(pane.x + 450, pane.y + 400); await page.locator('.canvas').press('Meta+v');
    await expect.poll(async () => (await workspace.state()).connectors!.length).toBe(2);
    expect(commands).toHaveLength(1);
    expect(commands[0].payload.connectors[0].start).toEqual({ kind: 'free', point: { x, y: 210 } });
    expect(commands[0].payload.connectors[0].end).toEqual({ kind: 'free', point: { x: 900, y: 210 } });
    const final = await workspace.state(), copy = final.connectors!.find(line => line.id !== 'source-line')!;
    expect(copy.start.kind).toBe('free'); expect(copy.end.kind).toBe('free');
    await workspace.restart(); await workspace.open(page); expect(await workspace.state()).toEqual(final);
  } finally {
    const restored = await page.evaluate(async ({ original, owned }) => {
      const items = await navigator.clipboard.read(), item = items.find(item => item.types.includes('web application/x-forkwise-canvas'));
      if (!owned || !item || await (await item.getType('web application/x-forkwise-canvas')).text() !== owned) return 'external change retained';
      if (original.length) await navigator.clipboard.write(original.map(items => new ClipboardItem(Object.fromEntries(items.map(value => [value.type, new Blob([new Uint8Array(value.bytes)], { type: value.type })])))));
      else await navigator.clipboard.writeText('');
      return 'restored browser-exposed flavors only';
    }, { original: originalClipboard, owned });
    await info.attach('clipboard-scope', { body: restored, contentType: 'text/plain' });
  }
});

test('组内单成员拖动预览与可见外框和绑定端同坐标，提交前不写权威状态', async ({ page, workspace }) => {
  const projectId = (await workspace.state()).project.id;
  for (const [id, x] of [['a', 200], ['b', 400]] as const)
    await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'shape.create', expected: null,
      payload: { id, content: { shapeType: 'rectangle', shortText: id }, pose: { x, y: 180, width: 100, height: 60 } } });
  const seeded = await workspace.state(), ids = seeded.shapes!.map(shape => shape.item.id);
  await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'group.create', expected: { groups: { g: null }, containment: Object.fromEntries(ids.map(id => [id, null])) }, payload: { id: 'g', itemIds: ids } });
  const group = (await workspace.state()).groups![0]!;
  await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'connector.create', expected: null, payload: { id: 'preview-line', start: { kind: 'bound', targetKind: 'group', itemId: group.itemId, side: 'right' }, end: { kind: 'free', point: { x: 900, y: 210 } } } });
  await page.reload(); await expect(page.getByRole('status')).toHaveText('已保存到本机');
  await page.getByRole('img', { name: 'a', exact: true }).click();
  await page.getByRole('button', { name: '进入组合', exact: true }).click();
  const member = page.getByRole('img', { name: 'b', exact: true }); await member.click();
  const before = await workspace.state(), box = (await member.boundingBox())!;
  const center = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await page.mouse.move(center.x, center.y); await page.mouse.down();
  try {
    await page.mouse.move(center.x + 100, center.y, { steps: 5 });
    await expect.poll(async () => {
      const ends = await connectorSvgEnds(page.locator('[data-connector-id="preview-line"] path').last());
      return (await connectorWorldPoint(page, ends.start)).x;
    }).toBeCloseTo(610, 4);
    expect(await workspace.state()).toEqual(before);
  } finally { await page.mouse.up(); }
  await expect.poll(async () => (await workspace.state()).shapes!.find(shape => shape.id === 'b')!.item.pose.x).toBe(500);
  const ends = await connectorSvgEnds(page.locator('[data-connector-id="preview-line"] path').last());
  expect((await connectorWorldPoint(page, ends.start)).x).toBeCloseTo(610, 4);
});

test('Frame本体键盘创建和重接，Esc取消恢复焦点，移动预览和删框冻结一致', async ({ page, workspace }) => {
  const projectId = (await workspace.state()).project.id;
  await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'shape.create', expected: null, payload: { id: 'ordinary', content: { shapeType: 'rectangle', shortText: '普通成员目标' }, pose: { x: 500, y: 200, width: 100, height: 60 } } });
  await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'frame.create', expected: { frame: null, groups: {}, containment: {}, poses: {} }, payload: { id: 'frame', itemIds: [], pose: { x: 100, y: 150, width: 200, height: 160 } } });
  await page.reload(); await expect(page.getByRole('status')).toHaveText('已保存到本机');
  await page.getByRole('button', { name: '连线', exact: true }).click();
  const target = page.getByRole('button', { name: '分区 分区1 连线起点：右', exact: true });
  await target.focus(); await page.keyboard.press('Enter');
  const ordinary = page.getByRole('button', { name: '形状 ordinary 连线起点：左', exact: true });
  await ordinary.focus(); await page.keyboard.press('Enter');
  await expect.poll(async () => (await workspace.state()).connectors!.length).toBe(1);
  const original = (await workspace.state()).connectors![0]!;
  expect(original.start).toEqual({ kind: 'bound', targetKind: 'frame', itemId: 'frame', side: 'right' });
  await page.getByRole('button', { name: '选择', exact: true }).click();
  await page.getByRole('button', { name: '普通连线', exact: true }).click();
  const handle = page.getByRole('button', { name: '连线起点', exact: true });
  await handle.focus(); await page.keyboard.press('Enter');
  const bottom = page.getByRole('button', { name: '分区 分区1 连线起点：下', exact: true });
  await bottom.focus(); await page.keyboard.press('Escape');
  await expect(handle).toBeFocused(); expect((await workspace.state()).connectors![0]).toEqual(original);
  await page.keyboard.press('Enter'); await bottom.focus(); await page.keyboard.press('Enter');
  await expect.poll(async () => (await workspace.state()).connectors![0]!.start).toEqual({ kind: 'bound', targetKind: 'frame', itemId: 'frame', side: 'bottom' });
  const name = page.getByRole('button', { name: '分区1', exact: true });
  await expect(page.getByRole('status')).toHaveText('已保存到本机');
  await expect(name).toBeEnabled();
  const box = (await name.boundingBox())!;
  const before = await workspace.state();
  console.log('issue30-frame-before-drag', JSON.stringify({ disabled: await name.isDisabled(), status: await page.getByRole('status').textContent(), box }));
  await page.mouse.move(box.x + 20, box.y + 10); await page.mouse.down();
  try {
    await page.mouse.move(box.x + 120, box.y + 50, { steps: 5 });
    console.log('issue30-frame-preview', JSON.stringify(await page.locator('[data-frame-id="frame"]').evaluate(element => ({ style: element.getAttribute('style'), box: element.getBoundingClientRect().toJSON() }))));
    await expect.poll(async () => {
      const ends = await connectorSvgEnds(page.locator('[data-connector-id="' + original.id + '"] path').last());
      return (await connectorWorldPoint(page, ends.start)).x;
    }).toBeCloseTo(300, 4);
    expect(await workspace.state()).toEqual(before);
  } finally { await page.mouse.up(); }
  await expect.poll(async () => (await workspace.state()).frames![0]!.pose.x).toBe(200);
  await page.getByRole('button', { name: '删除分区', exact: true }).click();
  await expect.poll(async () => (await workspace.state()).frames!.length).toBe(0);
  expect((await workspace.state()).connectors![0]!.start).toEqual({ kind: 'free', point: { x: 300, y: 350 } });
  expect((await workspace.state()).connectors![0]!.end).toEqual(original.end);
});

test('200宽分区的选中名称和长名称均可物理点击拖动，操作按钮保持键盘顺序', async ({ page, workspace }) => {
  const projectId = (await workspace.state()).project.id;
  await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'shape.create', expected: null,
    payload: { id: 'inside-header-frame', content: { shapeType: 'rectangle', shortText: '框内成员' }, pose: { x: 210, y: 300, width: 100, height: 60 } } });
  const item = (await workspace.state()).shapes![0]!.item;
  await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'frame.create',
    expected: { frame: null, groups: {}, containment: { [item.id]: null }, poses: { [item.id]: item.versionId } },
    payload: { id: 'header-frame', itemIds: [item.id], pose: { x: 180, y: 260, width: 200, height: 160 } } });
  await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'connector.create', expected: null,
    payload: { id: 'header-line', start: { kind: 'bound', targetKind: 'frame', itemId: 'header-frame', side: 'right' }, end: { kind: 'free', point: { x: 700, y: 340 } } } });
  await page.reload(); await expect(page.getByRole('status')).toHaveText('已保存到本机');
  const frame = page.locator('[data-frame-id="header-frame"]');
  const writes: any[] = [];
  page.on('request', request => {
    if (request.url().endsWith('/api/mapping/execute') && request.method() === 'POST') writes.push(request.postDataJSON());
  });
  for (const title of ['分区1', '这是用于确认窄分区名称换行后仍能点击与拖动的长名称，操作栏不能遮住任何一行']) {
    if (title !== '分区1') {
      await page.getByRole('button', { name: '重命名分区', exact: true }).click();
      const editor = page.getByRole('textbox', { name: '分区名称', exact: true });
      await editor.fill(title); await editor.press('Enter');
      await expect(editor).toHaveCount(0); await expect(page.getByRole('status')).toHaveText('已保存到本机');
    }
    const name = frame.getByRole('button', { name: title, exact: true });
    await expect(name).toBeEnabled();
    const initialBox = (await name.boundingBox())!;
    await page.mouse.click(initialBox.x + initialBox.width / 2, initialBox.y + initialBox.height / 2);
    await expect(frame).toHaveAttribute('data-selected', 'true');
    const before = await workspace.state();
    const beforeHistory = await (await page.request.get(workspace.origin + '/api/mapping/projects/' + projectId + '/history')).json();
    writes.length = 0;
    const box = (await name.boundingBox())!;
    console.log('issue30-frame-header-hit', JSON.stringify(await name.evaluate(element => {
      const rect = element.getBoundingClientRect(), hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
      return { title: element.textContent, box: rect.toJSON(), hitText: hit?.textContent, hitRole: hit?.getAttribute('role') };
    })));
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 80, box.y + box.height / 2 + 40, { steps: 5 }); await page.mouse.up();
    await expect.poll(async () => (await workspace.state()).frames![0]!.pose.x, { timeout: 3000 }).toBe(before.frames![0]!.pose.x + 80);
    await expect(page.getByRole('status')).toHaveText('已保存到本机');
    const moved = await workspace.state();
    expect(moved.frames![0]!.pose).toEqual({ ...before.frames![0]!.pose, x: before.frames![0]!.pose.x + 80, y: before.frames![0]!.pose.y + 40 });
    expect(moved.shapes![0]!.item.pose).toEqual({ ...before.shapes![0]!.item.pose, x: before.shapes![0]!.item.pose.x + 80, y: before.shapes![0]!.item.pose.y + 40 });
    expect(moved.frames![0]!.memberItemIds).toEqual(before.frames![0]!.memberItemIds);
    expect(moved.connectors).toEqual(before.connectors);
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ type: 'frame.move', expected: { frame: before.frames![0]!.versionId }, payload: { id: 'header-frame', dx: 80, dy: 40 } });
    const history = await (await page.request.get(workspace.origin + '/api/mapping/projects/' + projectId + '/history')).json();
    expect(history.undo).toHaveLength(beforeHistory.undo.length + 1);
    expect(history.undo.at(-1)).toMatchObject({ label: 'frame.move', target: { id: 'header-frame' } });
    expect(history.redo).toEqual(beforeHistory.redo);
    const ends = await connectorSvgEnds(page.locator('[data-connector-id="header-line"] path').last());
    const point = await connectorWorldPoint(page, ends.start);
    expect(point.x).toBeCloseTo(moved.frames![0]!.pose.x + 200, 4);
    expect(point.y).toBeCloseTo(moved.frames![0]!.pose.y + 80, 4);
    const movedBox = (await name.boundingBox())!;
    await page.mouse.click(movedBox.x + movedBox.width / 2, movedBox.y + movedBox.height / 2);
    await expect(page.getByRole('textbox', { name: '分区名称', exact: true })).toHaveCount(0);
    await expect(name).toBeFocused(); await page.keyboard.press('Tab');
    await expect(page.getByRole('button', { name: '重命名分区', exact: true })).toBeFocused(); await page.keyboard.press('Tab');
    await expect(page.getByRole('button', { name: '删除分区', exact: true })).toBeFocused();
  }
});
