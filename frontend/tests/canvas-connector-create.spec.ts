import { test, expect } from './writing-board-fixture';
import type { Request } from '@playwright/test';
import type { Command, ProjectHistory } from '../../backend/src/mapping/contracts';
import { seedConnectorCard, connectorWorldPoint, connectorGesture, connectorSurfaceBox, connectorCardPair, connectorSvgEnds } from './connector-ui-fixture';

test('两端自由普通连线拖动时预览且松开只保存一条直线', async ({ page, workspace }) => {
  const before = await workspace.state(), projectId = before.project.id;
  const history = async () => {
    const response = await page.request.get(workspace.origin + '/api/mapping/projects/' + encodeURIComponent(projectId) + '/history');
    expect(response.status()).toBe(200); return await response.json() as ProjectHistory;
  };
  const beforeHistory = await history();
  type Create = Extract<Command, { type: 'connector.create' }>;
  const commands: Create[] = [];
  const record = (request: Request) => {
    if (request.url().endsWith('/api/mapping/execute') && request.method() === 'POST') {
      const command = request.postDataJSON();
      if (command.type === 'connector.create') commands.push(command);
    }
  };
  page.on('request', record);
  try {
    const tool = page.getByRole('button', { name: '连线', exact: true });
    expect(await tool.count(), '创作底栏必须提供普通连线入口；缺入口应即时失败').toBe(1);
    await tool.click(); await expect(tool).toHaveAttribute('aria-pressed', 'true');
    const pane = await page.locator('.react-flow__pane').boundingBox();
    expect(pane).not.toBeNull();
    const start = { x: Math.round(pane!.x + pane!.width * 0.25), y: Math.round(pane!.y + pane!.height * 0.32) };
    const end = { x: Math.round(pane!.x + pane!.width * 0.58), y: Math.round(pane!.y + pane!.height * 0.61) };
    const expected = await page.locator('.react-flow__viewport').evaluate((element, points) => {
      const frame = element.closest('.react-flow__renderer')!.getBoundingClientRect();
      const inverse = new DOMMatrix(getComputedStyle(element).transform).inverse();
      const world = (point: { x: number; y: number }) => {
        const value = new DOMPoint(point.x - frame.left, point.y - frame.top).matrixTransform(inverse);
        return { x: value.x, y: value.y };
      };
      return { start: world(points.start), end: world(points.end) };
    }, { start, end });
    for (const point of [expected.start, expected.end]) { expect(Number.isFinite(point.x)).toBe(true); expect(Number.isFinite(point.y)).toBe(true); }
    await page.mouse.move(start.x, start.y); await page.mouse.down(); await page.mouse.move(end.x, end.y, { steps: 6 });
    const preview = page.getByRole('img', { name: '连线预览', exact: true });
    await expect(preview).toBeVisible();
    const previewEnds = await connectorSvgEnds(preview.locator('path'));
    expect(previewEnds.start.x).toBeCloseTo(start.x, 0); expect(previewEnds.start.y).toBeCloseTo(start.y, 0);
    expect(previewEnds.end.x).toBeCloseTo(end.x, 0); expect(previewEnds.end.y).toBeCloseTo(end.y, 0);
    expect(commands).toHaveLength(0); expect(await workspace.state()).toEqual(before); expect(await history()).toEqual(beforeHistory);
    const saved = page.waitForResponse(response => response.url().endsWith('/api/mapping/execute') && response.request().postDataJSON()?.type === 'connector.create');
    await page.mouse.up(); const response = await saved;
    expect(response.status()).toBe(200); const receipt = await response.json();
    await expect(page.getByRole('status')).toHaveText('已保存到本机');
    await expect(preview).toHaveCount(0); expect(commands).toHaveLength(1);
    const command = commands[0]!;
    expect(command).toMatchObject({ projectId, type: 'connector.create', expected: null, payload: { start: { kind: 'free' }, end: { kind: 'free' } } });
    const state = await workspace.state(); expect(state.connectors).toHaveLength(1);
    const connector = state.connectors![0]!;
    expect(connector).toMatchObject({ id: command.payload.id, kind: 'connector', path: 'straight', start: { kind: 'free' }, end: { kind: 'free' } });
    expect(connector.start.kind).toBe('free'); expect(connector.end.kind).toBe('free');
    if (connector.start.kind !== 'free' || connector.end.kind !== 'free') throw new Error('自由线不应出现绑定端点');
    expect(connector.start.point.x).toBeCloseTo(expected.start.x, 6); expect(connector.start.point.y).toBeCloseTo(expected.start.y, 6);
    expect(connector.end.point.x).toBeCloseTo(expected.end.x, 6); expect(connector.end.point.y).toBeCloseTo(expected.end.y, 6);
    expect(receipt).toMatchObject({ commandId: command.commandId, projectId, changedIds: [connector.id], connectorVersions: { [connector.id]: connector.versionId } });
    expect(state.project.revision).toBe(before.project.revision + 1); expect(state.cards).toEqual(before.cards);
    for (const key of ['tags', 'texts', 'shapes', 'strokes', 'images'] as const) expect(state[key]).toEqual(before[key]);
    const afterHistory = await history(); expect(afterHistory.undo).toHaveLength(beforeHistory.undo.length + 1);
    await expect(page.getByRole('button', { name: '普通连线', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByRole('button', { name: '选择', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(tool).toHaveAttribute('aria-pressed', 'false');
    await page.reload(); await expect(page.getByRole('status')).toHaveText('已保存到本机'); expect(await workspace.state()).toEqual(state);
    await workspace.restart(); await workspace.open(page); expect(await workspace.state()).toEqual(state); expect(await history()).toEqual(afterHistory);
    await expect(page.getByRole('button', { name: '普通连线', exact: true })).toBeVisible();
    console.log('issue26-free-line', JSON.stringify({ start, end, expectedWorld: expected, previewEnds, command, receipt, connector, undoBefore: beforeHistory.undo.length, undoAfter: afterHistory.undo.length, persistence: 'actual reload and same-directory service restart', evidence: 'actual pointer and independent DOM/SVG matrices; no implementation geometry import' }));
  } finally { page.off('request', record); }
});

test('从卡片连接到空白保留起点绑定和自由终点', async ({ page, workspace }) => {
  const card = await seedConnectorCard(page, workspace);
  await page.getByRole('button', { name: '连线', exact: true }).click();
  await expect(page.getByRole('button', { name: '连线', exact: true })).toHaveAttribute('aria-pressed', 'true');
  const before = await workspace.state(), box = await page.locator('article.thought-card').boundingBox();
  expect(box).not.toBeNull();
  const start = { x: box!.x + box!.width - 2, y: box!.y + box!.height / 2 }, end = { x: 820, y: 510 };
  const expectedEnd = await connectorWorldPoint(page, end);
  const commands: Command[] = [], record = (request: Request) => {
    if (request.url().endsWith('/api/mapping/execute') && request.method() === 'POST' && request.postDataJSON()?.type === 'connector.create') commands.push(request.postDataJSON());
  };
  page.on('request', record);
  try {
    await page.mouse.move(start.x, start.y); await page.mouse.down(); await page.mouse.move(end.x, end.y, { steps: 6 });
    const preview = page.getByRole('img', { name: '连线预览', exact: true });
    expect(await preview.count(), '从卡片边缘拖动应立即形成绑定预览').toBe(1);
    const previewEnds = await connectorSvgEnds(preview.locator('path'));
    expect(previewEnds.start.x).toBeCloseTo(box!.x + box!.width, 0); expect(previewEnds.start.y).toBeCloseTo(start.y, 0);
    expect(previewEnds.end.x).toBeCloseTo(end.x, 0); expect(previewEnds.end.y).toBeCloseTo(end.y, 0);
    expect(commands).toHaveLength(0); expect(await workspace.state()).toEqual(before);
    const saved = page.waitForResponse(response => response.url().endsWith('/api/mapping/execute') && response.request().postDataJSON()?.type === 'connector.create');
    await page.mouse.up(); expect((await saved).status()).toBe(200);
    await expect(page.getByRole('status')).toHaveText('已保存到本机');
    const state = await workspace.state(); expect(commands).toHaveLength(1); expect(state.connectors).toHaveLength(1);
    expect(state.connectors![0]).toMatchObject({ path: 'straight', start: { kind: 'bound', itemId: card.item.id, side: 'right' }, end: { kind: 'free', point: expectedEnd } });
    expect(state.cards).toEqual(before.cards);
    for (const key of ['tags', 'texts', 'shapes', 'strokes', 'images'] as const) expect(state[key]).toEqual(before[key]);
    const ends = await connectorSvgEnds(page.getByRole('button', { name: '普通连线', exact: true }).locator('path'));
    expect(ends).toEqual(previewEnds);
    console.log('issue26-card-to-free', JSON.stringify({ cardItem: card.item.id, box, start, end, expectedEnd, previewEnds, connector: state.connectors![0], commands, protectedCard: state.cards[0] }));
  } finally { page.off('request', record); }
});

test('从空白连接到卡片保留自由起点和终点绑定', async ({ page, workspace }) => {
  const card = await seedConnectorCard(page, workspace), box = await page.locator('article.thought-card').boundingBox();
  expect(box).not.toBeNull();
  const start = { x: 820, y: 510 }, end = { x: box!.x + box!.width - 2, y: box!.y + box!.height / 2 };
  await connectorGesture(page, workspace, start, end, {
    start: { kind: 'free', point: await connectorWorldPoint(page, start) },
    end: { kind: 'bound', itemId: card.item.id, side: 'right' }, screenStart: start, screenEnd: { x: box!.x + box!.width, y: end.y },
  });
});

test('从一个卡片拖到另一个卡片保存两端绑定', async ({ page, workspace }) => {
  const first = await seedConnectorCard(page, workspace, 'first-card', 130, 150);
  const second = await seedConnectorCard(page, workspace, 'second-card', 700, 400);
  const a = await connectorSurfaceBox(page, first.item.id), b = await connectorSurfaceBox(page, second.item.id);
  const start = { x: a.x + a.width - 2, y: a.y + a.height / 2 }, end = { x: b.x + b.width - 2, y: b.y + b.height / 2 };
  await connectorGesture(page, workspace, start, end, {
    start: { kind: 'bound', itemId: first.item.id, side: 'right' }, end: { kind: 'bound', itemId: second.item.id, side: 'right' },
    screenStart: { x: a.x + a.width, y: start.y }, screenEnd: { x: b.x + b.width, y: end.y },
  });
});

test('卡片四边连接入口分别保存所选固定边', async ({ page, workspace }) => {
  const card = await seedConnectorCard(page, workspace);
  const sides = [['top', '上'], ['right', '右'], ['bottom', '下'], ['left', '左']] as const;
  for (const [side, label] of sides) {
    await page.getByRole('button', { name: '连线', exact: true }).click();
    await expect(page.getByRole('button', { name: '连线', exact: true })).toHaveAttribute('aria-pressed', 'true');
    expect(await page.getByRole('button', { name: /^卡片 连线的卡片 连线起点：[上下左右]$/ }).count(), '连线工具必须展示卡片四边入口').toBe(4);
    const box = await connectorSurfaceBox(page, card.item.id);
    const midpoint = { x: side === 'left' ? box.x : side === 'right' ? box.x + box.width : box.x + box.width / 2,
      y: side === 'top' ? box.y : side === 'bottom' ? box.y + box.height : box.y + box.height / 2 };
    const entry = await page.getByRole('button', { name: '卡片 ' + card.title + ' 连线起点：' + label, exact: true }).boundingBox();
    expect(entry).not.toBeNull();
    const start = { x: entry!.x + entry!.width / 2, y: entry!.y + entry!.height / 2 }, end = { x: 860, y: 540 };
    expect(start.x).toBeCloseTo(midpoint.x, 0); expect(start.y).toBeCloseTo(midpoint.y, 0);
    await connectorGesture(page, workspace, start, end, { start: { kind: 'bound', itemId: card.item.id, side },
      end: { kind: 'free', point: await connectorWorldPoint(page, end) }, screenStart: midpoint, screenEnd: end }, false);
  }
  expect((await workspace.state()).connectors!.map(value => value.start)).toEqual(sides.map(([side]) => ({ kind: 'bound', itemId: card.item.id, side })));
});

test('基础形状可通过真实连线手势绑定', async ({ page, workspace }) => {
  await seedConnectorCard(page, workspace, 'protected-card', 930, 90);
  const projectId = (await workspace.state()).project.id;
  await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'shape.create', expected: null,
    payload: { id: 'connector-shape', content: { shapeType: 'rectangle', shortText: '形状绑定对象' }, pose: { x: 180, y: 170, width: 220, height: 110 } } });
  await page.reload(); await expect(page.getByRole('status')).toHaveText('已保存到本机');
  const shape = (await workspace.state()).shapes![0]!, box = await connectorSurfaceBox(page, shape.item.id, 'div[role=img]');
  const start = { x: box.x + box.width - 2, y: box.y + box.height / 2 }, end = { x: 820, y: 540 };
  await connectorGesture(page, workspace, start, end, { start: { kind: 'bound', itemId: shape.item.id, side: 'right' },
    end: { kind: 'free', point: await connectorWorldPoint(page, end) }, screenStart: { x: box.x + box.width, y: start.y }, screenEnd: end });
});

test('独立文字可通过真实连线手势绑定', async ({ page, workspace }) => {
  await seedConnectorCard(page, workspace, 'protected-card', 930, 90);
  const projectId = (await workspace.state()).project.id;
  await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'text.create', expected: null,
    payload: { id: 'connector-text', content: { runs: [{ text: '独立文字绑定对象' }], fontSize: 18, lineHeight: 1.5, align: 'left', widthMode: 'fixed', width: 190 },
      pose: { x: 180, y: 170, width: 190, height: 27 } } });
  await page.reload(); await expect(page.getByRole('status')).toHaveText('已保存到本机');
  const text = (await workspace.state()).texts![0]!, box = await connectorSurfaceBox(page, text.item.id, 'article.canvas-text');
  const start = { x: box.x + box.width - 2, y: box.y + box.height / 2 }, end = { x: 820, y: 540 };
  await connectorGesture(page, workspace, start, end, { start: { kind: 'bound', itemId: text.item.id, side: 'right' },
    end: { kind: 'free', point: await connectorWorldPoint(page, end) }, screenStart: { x: box.x + box.width, y: start.y }, screenEnd: end });
});

test('独立图片可通过真实连线手势绑定', async ({ page, workspace }) => {
  await seedConnectorCard(page, workspace, 'protected-card', 930, 90);
  const projectId = (await workspace.state()).project.id;
  const source = '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="180"><rect width="300" height="180" fill="blue"/></svg>';
  await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'asset.save', expected: null,
    payload: { id: 'connector-asset', name: '绑定图片.svg', mime: 'image/svg+xml', base64: Buffer.from(source).toString('base64') } });
  await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'image.create', expected: null,
    payload: { id: 'connector-image', content: { assetId: 'connector-asset', crop: { x: 0.1, y: 0.2, width: 0.7, height: 0.6 } },
      pose: { x: 180, y: 170, width: 180, height: 300, rotation: 90 } } });
  await page.reload(); await expect(page.getByRole('status')).toHaveText('已保存到本机');
  const image = (await workspace.state()).images![0]!, box = await connectorSurfaceBox(page, image.item.id, '.canvas-image-object');
  const start = { x: box.x + box.width - 2, y: box.y + box.height / 2 }, end = { x: 820, y: 540 };
  await connectorGesture(page, workspace, start, end, { start: { kind: 'bound', itemId: image.item.id, side: 'right' },
    end: { kind: 'free', point: await connectorWorldPoint(page, end) }, screenStart: { x: box.x + box.width, y: start.y }, screenEnd: end });
});

test('创建普通连线拒绝两端绑定同一个对象', async ({ page, workspace }) => {
  const card = await seedConnectorCard(page, workspace), before = await workspace.state();
  const history = async () => (await page.request.get(workspace.origin + '/api/mapping/projects/' + encodeURIComponent(before.project.id) + '/history')).json();
  const priorHistory = await history(), commands: unknown[] = [];
  await page.getByRole('button', { name: '连线', exact: true }).click();
  const box = await connectorSurfaceBox(page, card.item.id);
  const record = (request: Request) => {
    if (request.url().endsWith('/api/mapping/execute') && request.method() === 'POST' && request.postDataJSON()?.type === 'connector.create') commands.push(request.postDataJSON());
  };
  page.on('request', record);
  try {
    await page.mouse.move(box.x + box.width, box.y + box.height / 2); await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2, box.y, { steps: 5 });
    await expect(page.getByRole('img', { name: '连线预览', exact: true })).toBeVisible();
    await page.mouse.up();
    await expect.poll(async () => commands.length > 0 || await page.getByRole('img', { name: '连线预览', exact: true }).count() === 0).toBe(true);
    expect(commands, '同一对象两边自连应在提交前拒绝').toHaveLength(0);
    await expect(page.getByRole('alert')).toContainText('同一个对象');
    expect(await workspace.state()).toEqual(before); expect(await history()).toEqual(priorHistory);
  } finally { page.off('request', record); }
});

test('拖到普通笔迹不把笔迹作为绑定目标', async ({ page, workspace }) => {
  await seedConnectorCard(page, workspace, 'protected-card', 930, 90);
  const projectId = (await workspace.state()).project.id;
  await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'stroke.create', expected: null,
    payload: { id: 'connector-stroke', content: { penKind: 'pen', path: [{ x: 5, y: 5 }, { x: 195, y: 95 }], color: '#123456', width: 4, opacity: 1 },
      pose: { x: 180, y: 170, width: 200, height: 100 } } });
  await page.reload(); await expect(page.getByRole('status')).toHaveText('已保存到本机');
  const stroke = (await workspace.state()).strokes![0]!, box = await connectorSurfaceBox(page, stroke.item.id, 'svg');
  const start = { x: 820, y: 540 }, end = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await connectorGesture(page, workspace, start, end, { start: { kind: 'free', point: await connectorWorldPoint(page, start) },
    end: { kind: 'free', point: await connectorWorldPoint(page, end) }, screenStart: start, screenEnd: end });
});

test('拖到已有普通连线不把连线作为绑定目标', async ({ page, workspace }) => {
  await seedConnectorCard(page, workspace, 'protected-card', 930, 90);
  const projectId = (await workspace.state()).project.id;
  await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'connector.create', expected: null,
    payload: { id: 'existing-connector', path: 'straight', start: { kind: 'free', point: { x: 180, y: 170 } }, end: { kind: 'free', point: { x: 380, y: 270 } } } });
  await page.reload(); await expect(page.getByRole('status')).toHaveText('已保存到本机');
  const old = (await workspace.state()).connectors![0]!, ends = await connectorSvgEnds(page.getByRole('button', { name: '普通连线', exact: true }).locator('path'));
  const start = { x: 820, y: 540 }, end = { x: (ends.start.x + ends.end.x) / 2, y: (ends.start.y + ends.end.y) / 2 };
  await connectorGesture(page, workspace, start, end, { start: { kind: 'free', point: await connectorWorldPoint(page, start) },
    end: { kind: 'free', point: await connectorWorldPoint(page, end) }, screenStart: start, screenEnd: end });
  expect((await workspace.state()).connectors!.find(value => value.id === old.id)).toEqual(old);
});

test('同一对对象可通过手势创建多条普通连线', async ({ page, workspace }) => {
  const pair = await connectorCardPair(page, workspace);
  const first = await connectorGesture(page, workspace, pair.start, pair.end, pair.expected);
  const second = await connectorGesture(page, workspace, pair.start, pair.end, pair.expected);
  expect(first.id).not.toBe(second.id);
  expect((await workspace.state()).connectors).toEqual([first, second]);
});

test('同一对对象可通过手势创建反向普通连线', async ({ page, workspace }) => {
  const pair = await connectorCardPair(page, workspace);
  const forward = await connectorGesture(page, workspace, pair.start, pair.end, pair.expected);
  const reverse = await connectorGesture(page, workspace, pair.end, pair.start, {
    start: pair.expected.end, end: pair.expected.start, screenStart: pair.end, screenEnd: pair.start,
  });
  expect(reverse.start).toEqual(forward.end); expect(reverse.end).toEqual(forward.start); expect(reverse.id).not.toBe(forward.id);
  expect((await workspace.state()).connectors).toEqual([forward, reverse]);
});

test('三个对象可通过手势形成普通连线几何闭环', async ({ page, workspace }) => {
  const pair = await connectorCardPair(page, workspace), third = await seedConnectorCard(page, workspace, 'third-card', 130, 500);
  const cards = [pair.a, pair.b, third], points = [];
  for (const card of cards) { const box = await connectorSurfaceBox(page, card.item.id); points.push({ x: box.x + box.width, y: box.y + box.height / 2 }); }
  const created = [];
  for (let i = 0; i < cards.length; i++) {
    const next = (i + 1) % cards.length;
    created.push(await connectorGesture(page, workspace, points[i]!, points[next]!, {
      start: { kind: 'bound', itemId: cards[i]!.item.id, side: 'right' }, end: { kind: 'bound', itemId: cards[next]!.item.id, side: 'right' },
      screenStart: points[i]!, screenEnd: points[next]!,
    }));
  }
  expect((await workspace.state()).connectors).toEqual(created); expect(new Set(created.map(value => value.id)).size).toBe(3);
});

test('包含Unicode和引号的画布项身份可准确绑定', async ({ page, workspace }) => {
  const itemId = `画布项 "双引号" '单引号' 🧭`;
  await workspace.installOriginalShapeItem('legacy-special-shape', itemId);
  await workspace.open(page);
  const state = await workspace.state(); expect(state.shapes![0]!.item.id).toBe(itemId); expect(state.shapes![0]!.id).not.toBe(itemId);
  const snapshot = await page.locator('.workspace').getAttribute('data-snapshot'); expect(snapshot).not.toBeNull();
  const response = await page.request.get(workspace.origin + '/api/mapping/projects/' + encodeURIComponent(state.project.id) + '/map?' + new URLSearchParams({ view: 'shape-index', snapshot: snapshot! }));
  expect(response.status()).toBe(200); expect((await response.json()).items[0].item.id).toBe(itemId);
  const box = await connectorSurfaceBox(page, itemId, 'div[role=img]');
  const start = { x: box.x + box.width - 2, y: box.y + box.height / 2 }, end = { x: 820, y: 540 };
  await connectorGesture(page, workspace, start, end, { start: { kind: 'bound', itemId, side: 'right' },
    end: { kind: 'free', point: await connectorWorldPoint(page, end) }, screenStart: { x: box.x + box.width, y: start.y }, screenEnd: end });
});
