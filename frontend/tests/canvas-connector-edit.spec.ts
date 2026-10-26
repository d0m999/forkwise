import { test, expect } from './writing-board-fixture';
import type { Command } from '../../backend/src/mapping/contracts';
import { connectorSurfaceBox, connectorSvgEnds, connectorWorldPoint, seedConnectorCard, connectorReconnectAckLoss, connectorReconnectVersionConflict } from './connector-ui-fixture';

test('拖动连线端点重接到新对象而保留另一端', async ({ page, workspace }) => {
  const a = await seedConnectorCard(page, workspace, 'reconnect-a', 130, 150);
  const b = await seedConnectorCard(page, workspace, 'reconnect-b', 700, 400);
  const c = await seedConnectorCard(page, workspace, 'reconnect-c', 900, 90);
  const projectId = (await workspace.state()).project.id;
  await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'connector.create', expected: null,
    payload: { id: 'reconnected-line', path: 'straight', start: { kind: 'bound', itemId: a.item.id, side: 'right' }, end: { kind: 'bound', itemId: b.item.id, side: 'left' } } });
  await page.reload(); await expect(page.getByRole('status')).toHaveText('已保存到本机');
  const before = await workspace.state(), original = before.connectors![0]!, commands: Command[] = [];
  const historyUrl = workspace.origin + '/api/mapping/projects/' + encodeURIComponent(projectId) + '/history';
  const initialHistory = await (await page.request.get(historyUrl)).json();
  const record = (request: import('@playwright/test').Request) => {
    if (request.url().endsWith('/api/mapping/execute') && request.postDataJSON()?.type === 'connector.reconnect') commands.push(request.postDataJSON());
  };
  page.on('request', record);
  try {
    const line = page.getByRole('button', { name: '普通连线', exact: true }); await line.click(); await expect(line).toHaveAttribute('aria-pressed', 'true');
    const handle = page.getByRole('button', { name: '连线终点', exact: true });
    expect(await handle.count(), '选中普通连线必须提供可拖动的终点手柄').toBe(1);
    const hitDiagnostic = await handle.evaluate(element => {
      const describe = (node: Element | null) => {
        if (!node) return null;
        const rect = node.getBoundingClientRect(), style = getComputedStyle(node);
        return { tag: node.tagName, id: node.id.slice(0, 160), class: (node.getAttribute('class') ?? '').slice(0, 200),
          ariaLabel: node.getAttribute('aria-label')?.slice(0, 80), pointerEvents: style.pointerEvents, zIndex: style.zIndex, position: style.position,
          rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height, top: rect.top, right: rect.right, bottom: rect.bottom, left: rect.left } };
      };
      const box = element.getBoundingClientRect(), center = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
      const hit = document.elementFromPoint(center.x, center.y), ancestors = [];
      let node: Element | null = element;
      for (; node && ancestors.length < 12; node = node.parentElement) ancestors.push(describe(node));
      return { center, hit: describe(hit), hitIsHandleOrDescendant: !!hit && (hit === element || element.contains(hit)), ancestors, ancestorLimit: 12, ancestorsTruncated: !!node };
    });
    console.log('issue26-e84-hit', JSON.stringify(hitDiagnostic));
    expect(hitDiagnostic.hitIsHandleOrDescendant, '端点手柄中心必须真实命中该手柄或其子孙').toBe(true);
    const box = await connectorSurfaceBox(page, c.item.id), target = { x: box.x, y: box.y + box.height / 2 }, initial = await connectorSvgEnds(line.locator('path'));
    await handle.hover(); await page.mouse.down(); await page.mouse.move(target.x, target.y, { steps: 6 });
    const preview = page.getByRole('img', { name: '连线预览', exact: true }); await expect(preview).toBeVisible();
    const ends = await connectorSvgEnds(preview.locator('path')); expect(ends.start).toEqual(initial.start);
    expect(ends.end.x).toBeCloseTo(target.x, 0); expect(ends.end.y).toBeCloseTo(target.y, 0);
    expect(commands).toHaveLength(0); expect(await workspace.state()).toEqual(before);
    const saved = page.waitForResponse(response => response.url().endsWith('/api/mapping/execute') && response.request().postDataJSON()?.type === 'connector.reconnect');
    await page.mouse.up(); expect((await saved).status()).toBe(200); await expect(preview).toHaveCount(0);
    const after = await workspace.state(), changed = after.connectors![0]!;
    expect(commands).toEqual([expect.objectContaining({ type: 'connector.reconnect', expected: original.versionId,
      payload: { id: original.id, endpoint: 'end', value: { kind: 'bound', itemId: c.item.id, side: 'left' } } })]);
    expect(changed).toMatchObject({ id: original.id, start: original.start, end: { kind: 'bound', itemId: c.item.id, side: 'left' } });
    expect(after.cards).toEqual(before.cards); expect(after.connectors).toHaveLength(1);
    expect((await (await page.request.get(historyUrl)).json()).undo).toHaveLength(initialHistory.undo.length + 1);
    expect(await connectorSvgEnds(line.locator('path'))).toEqual(ends);
    console.log('issue26-reconnect', JSON.stringify({ original, commands, changed, initial, ends, protectedCards: after.cards }));
  } finally { page.off('request', record); }
});

test('拖动连线端点可换到原对象另一边', async ({ page, workspace }) => {
  const a = await seedConnectorCard(page, workspace, 'side-a', 130, 150);
  const b = await seedConnectorCard(page, workspace, 'side-b', 700, 400);
  const projectId = (await workspace.state()).project.id;
  await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'connector.create', expected: null,
    payload: { id: 'side-line', path: 'straight', start: { kind: 'bound', itemId: a.item.id, side: 'right' }, end: { kind: 'bound', itemId: b.item.id, side: 'left' } } });
  await page.reload(); await expect(page.getByRole('status')).toHaveText('已保存到本机');
  const before = await workspace.state(), original = before.connectors![0]!, commands: Command[] = [];
  const historyUrl = workspace.origin + '/api/mapping/projects/' + encodeURIComponent(projectId) + '/history';
  const history = await (await page.request.get(historyUrl)).json();
  const record = (request: import('@playwright/test').Request) => {
    if (request.url().endsWith('/api/mapping/execute') && request.postDataJSON()?.type === 'connector.reconnect') commands.push(request.postDataJSON());
  };
  page.on('request', record);
  try {
    const line = page.getByRole('button', { name: '普通连线', exact: true }); await line.click();
    const handle = page.getByRole('button', { name: '连线终点', exact: true }); expect(await handle.count()).toBe(1);
    const box = await connectorSurfaceBox(page, b.item.id), target = { x: box.x + box.width / 2, y: box.y };
    const initial = await connectorSvgEnds(line.locator('path'));
    await handle.hover(); await page.mouse.down(); await page.mouse.move(target.x, target.y, { steps: 6 });
    const preview = page.getByRole('img', { name: '连线预览', exact: true }); await expect(preview).toBeVisible();
    const ends = await connectorSvgEnds(preview.locator('path')); expect(ends.start).toEqual(initial.start); expect(ends.end).toEqual(target);
    expect(commands).toHaveLength(0); expect(await workspace.state()).toEqual(before);
    const saved = page.waitForResponse(response => response.url().endsWith('/api/mapping/execute') && response.request().postDataJSON()?.type === 'connector.reconnect');
    await page.mouse.up(); expect((await saved).status()).toBe(200); await expect(preview).toHaveCount(0);
    const after = await workspace.state();
    expect(commands).toEqual([expect.objectContaining({ expected: original.versionId,
      payload: { id: original.id, endpoint: 'end', value: { kind: 'bound', itemId: b.item.id, side: 'top' } } })]);
    expect(after.connectors).toEqual([expect.objectContaining({ id: original.id, start: original.start, end: { kind: 'bound', itemId: b.item.id, side: 'top' } })]);
    expect(after.cards).toEqual(before.cards); expect((await (await page.request.get(historyUrl)).json()).undo).toHaveLength(history.undo.length + 1);
    expect(await connectorSvgEnds(line.locator('path'))).toEqual(ends);
    console.log('issue26-side', JSON.stringify({ commands, original, changed: after.connectors![0], initial, ends }));
  } finally { page.off('request', record); }
});

test('拖动连线端点到空白只解除这一端绑定', async ({ page, workspace }) => {
  const a = await seedConnectorCard(page, workspace, 'detach-a', 130, 150), b = await seedConnectorCard(page, workspace, 'detach-b', 700, 400);
  const projectId = (await workspace.state()).project.id;
  await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'connector.create', expected: null,
    payload: { id: 'detach-line', path: 'straight', start: { kind: 'bound', itemId: a.item.id, side: 'right' }, end: { kind: 'bound', itemId: b.item.id, side: 'left' } } });
  await page.reload(); await expect(page.getByRole('status')).toHaveText('已保存到本机');
  const before = await workspace.state(), original = before.connectors![0]!, commands: Command[] = [];
  const historyUrl = workspace.origin + '/api/mapping/projects/' + encodeURIComponent(projectId) + '/history', history = await (await page.request.get(historyUrl)).json();
  const record = (request: import('@playwright/test').Request) => {
    if (request.url().endsWith('/api/mapping/execute') && request.postDataJSON()?.type === 'connector.reconnect') commands.push(request.postDataJSON());
  };
  page.on('request', record);
  try {
    const line = page.getByRole('button', { name: '普通连线', exact: true }); await line.click();
    const handle = page.getByRole('button', { name: '连线终点', exact: true }); expect(await handle.count()).toBe(1);
    const target = { x: 600, y: 720 }, world = await connectorWorldPoint(page, target), initial = await connectorSvgEnds(line.locator('path'));
    await handle.hover(); await page.mouse.down(); await page.mouse.move(target.x, target.y, { steps: 6 });
    const preview = page.getByRole('img', { name: '连线预览', exact: true }); await expect(preview).toBeVisible();
    const ends = await connectorSvgEnds(preview.locator('path')); expect(ends).toEqual({ start: initial.start, end: target });
    expect(commands).toHaveLength(0); expect(await workspace.state()).toEqual(before);
    const saved = page.waitForResponse(response => response.url().endsWith('/api/mapping/execute') && response.request().postDataJSON()?.type === 'connector.reconnect');
    await page.mouse.up(); expect((await saved).status()).toBe(200); await expect(preview).toHaveCount(0);
    const after = await workspace.state();
    expect(commands).toEqual([expect.objectContaining({ expected: original.versionId,
      payload: { id: original.id, endpoint: 'end', value: { kind: 'free', point: world } } })]);
    expect(after.connectors).toEqual([expect.objectContaining({ id: original.id, start: original.start, end: { kind: 'free', point: world } })]);
    expect(after.cards).toEqual(before.cards); expect((await (await page.request.get(historyUrl)).json()).undo).toHaveLength(history.undo.length + 1);
    expect(await connectorSvgEnds(line.locator('path'))).toEqual(ends);
    console.log('issue26-detach', JSON.stringify({ commands, original, changed: after.connectors![0], target, world, ends }));
  } finally { page.off('request', record); }
});

test('重接拒绝同对象自连并保留原有端点', async ({ page, workspace }) => {
  const a = await seedConnectorCard(page, workspace, 'self-a', 130, 150), b = await seedConnectorCard(page, workspace, 'self-b', 700, 400);
  const projectId = (await workspace.state()).project.id;
  await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'connector.create', expected: null,
    payload: { id: 'self-line', path: 'straight', start: { kind: 'bound', itemId: a.item.id, side: 'right' }, end: { kind: 'bound', itemId: b.item.id, side: 'left' } } });
  await page.reload(); await expect(page.getByRole('status')).toHaveText('已保存到本机');
  const before = await workspace.state(), original = before.connectors![0]!, commands: Command[] = [];
  const historyUrl = workspace.origin + '/api/mapping/projects/' + encodeURIComponent(projectId) + '/history', history = await (await page.request.get(historyUrl)).json();
  const record = (request: import('@playwright/test').Request) => {
    if (request.url().endsWith('/api/mapping/execute') && request.postDataJSON()?.type === 'connector.reconnect') commands.push(request.postDataJSON());
  };
  page.on('request', record);
  try {
    const line = page.getByRole('button', { name: '普通连线', exact: true }); await line.click();
    const handle = page.getByRole('button', { name: '连线终点', exact: true }); expect(await handle.count()).toBe(1);
    const initial = await connectorSvgEnds(line.locator('path')), box = await connectorSurfaceBox(page, a.item.id), target = { x: box.x + box.width / 2, y: box.y };
    await handle.hover(); await page.mouse.down(); await page.mouse.move(target.x, target.y, { steps: 6 });
    expect(commands).toHaveLength(0); expect(await workspace.state()).toEqual(before);
    const refused = page.waitForResponse(response => response.url().endsWith('/api/mapping/execute') && response.request().postDataJSON()?.type === 'connector.reconnect');
    await page.mouse.up(); const response = await refused, failure = await response.json();
    expect(response.status()).toBe(400); expect(failure).toMatchObject({ code: 'INVALID_ENDPOINT' });
    expect(commands).toEqual([expect.objectContaining({ expected: original.versionId,
      payload: { id: original.id, endpoint: 'end', value: { kind: 'bound', itemId: a.item.id, side: 'top' } } })]);
    expect(await workspace.state()).toEqual(before); expect(await (await page.request.get(historyUrl)).json()).toEqual(history);
    expect(await connectorSvgEnds(line.locator('path'))).toEqual(initial);
    console.log('issue26-self-refusal', JSON.stringify({ commands, failure, original, initial, history }));
  } finally { page.off('request', record); }
});

test('切换直线折线曲线只改变SVG走线而保留端点', async ({ page, workspace }) => {
  const a = await seedConnectorCard(page, workspace, 'path-a', 130, 150), b = await seedConnectorCard(page, workspace, 'path-b', 700, 400);
  const projectId = (await workspace.state()).project.id;
  await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'connector.create', expected: null,
    payload: { id: 'path-line', path: 'straight', start: { kind: 'bound', itemId: a.item.id, side: 'right' }, end: { kind: 'bound', itemId: b.item.id, side: 'left' } } });
  await page.reload(); await expect(page.getByRole('status')).toHaveText('已保存到本机');
  const before = await workspace.state(), original = before.connectors![0]!, commands: Command[] = [];
  const historyUrl = workspace.origin + '/api/mapping/projects/' + encodeURIComponent(projectId) + '/history', history = await (await page.request.get(historyUrl)).json();
  const record = (request: import('@playwright/test').Request) => {
    if (request.url().endsWith('/api/mapping/execute') && request.postDataJSON()?.type === 'connector.path') commands.push(request.postDataJSON());
  };
  page.on('request', record);
  try {
    const line = page.getByRole('button', { name: '普通连线', exact: true }); await line.click();
    const choices = page.getByRole('group', { name: '连线路径', exact: true });
    expect(await choices.count(), '选中普通连线必须提供直线、折线和曲线的路径选择').toBe(1);
    await expect(choices.getByRole('button', { name: '直线', exact: true })).toHaveAttribute('aria-pressed', 'true');
    const endpoints = await connectorSvgEnds(line.locator('path')), initialD = await line.locator('path').getAttribute('d'), drawings = [];
    let version = original.versionId, previousD = initialD;
    for (const [name, path] of [['折线', 'elbow'], ['曲线', 'curve'], ['直线', 'straight']] as const) {
      const saved = page.waitForResponse(response => response.url().endsWith('/api/mapping/execute') && response.request().postDataJSON()?.type === 'connector.path');
      await choices.getByRole('button', { name, exact: true }).click(); expect((await saved).status()).toBe(200);
      await expect(choices.getByRole('button', { name, exact: true })).toHaveAttribute('aria-pressed', 'true');
      const after = await workspace.state(), changed = after.connectors![0]!;
      expect(commands.at(-1)).toMatchObject({ expected: version, payload: { id: original.id, path } });
      expect(changed).toMatchObject({ id: original.id, path, start: original.start, end: original.end });
      expect(after.cards).toEqual(before.cards); expect(after.connectors).toHaveLength(1);
      expect(await connectorSvgEnds(line.locator('path'))).toEqual(endpoints);
      const drawing = await line.locator('path').evaluate(element => ({ d: element.getAttribute('d'), length: (element as SVGPathElement).getTotalLength() }));
      expect(drawing.d).not.toBe(previousD);
      if (path === 'straight') expect(drawing.d).toBe(initialD);
      else expect(drawing.length).toBeGreaterThan(Math.hypot(endpoints.end.x - endpoints.start.x, endpoints.end.y - endpoints.start.y) + 1);
      drawings.push({ path, ...drawing }); previousD = drawing.d; version = changed.versionId;
    }
    expect(commands).toHaveLength(3); expect((await (await page.request.get(historyUrl)).json()).undo).toHaveLength(history.undo.length + 3);
    console.log('issue26-paths', JSON.stringify({ commands, endpoints, drawings, original }));
  } finally { page.off('request', record); }
});

test('整体拖动双自由端连线只平移两个自由端', async ({ page, workspace }) => {
  await seedConnectorCard(page, workspace, 'move-protected-card', 930, 90); const projectId = (await workspace.state()).project.id;
  const start = { x: 300, y: 300 }, end = { x: 600, y: 500 };
  await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'connector.create', expected: null,
    payload: { id: 'moving-free-line', path: 'straight', start: { kind: 'free', point: start }, end: { kind: 'free', point: end } } });
  await page.reload(); await expect(page.getByRole('status')).toHaveText('已保存到本机');
  const before = await workspace.state(), original = before.connectors![0]!, line = page.getByRole('button', { name: '普通连线', exact: true }), commands: Command[] = [];
  const historyUrl = workspace.origin + '/api/mapping/projects/' + encodeURIComponent(projectId) + '/history', history = await (await page.request.get(historyUrl)).json();
  const record = (request: import('@playwright/test').Request) => { if (request.url().endsWith('/api/mapping/execute')) commands.push(request.postDataJSON()); };
  page.on('request', record);
  try {
    await line.click(); const initial = await connectorSvgEnds(line.locator('path'));
    const hit = await line.locator('path').evaluate(element => {
      const path = element as SVGPathElement, point = path.getPointAtLength(path.getTotalLength() / 2), client = new DOMPoint(point.x, point.y).matrixTransform(path.getScreenCTM()!);
      return { x: client.x, y: client.y };
    });
    const destination = { x: hit.x + 80, y: hit.y + 40 }, from = await connectorWorldPoint(page, hit), to = await connectorWorldPoint(page, destination), delta = { dx: to.x - from.x, dy: to.y - from.y };
    await page.mouse.move(hit.x, hit.y); await page.mouse.down(); await page.mouse.move(destination.x, destination.y, { steps: 6 });
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    const preview = page.getByRole('img', { name: '连线预览', exact: true }); expect(await preview.count(), '整体拖动普通连线必须提供未提交的真实预览').toBe(1);
    const ends = await connectorSvgEnds(preview.locator('path'));
    expect(ends).toEqual({ start: { x: initial.start.x + 80, y: initial.start.y + 40 }, end: { x: initial.end.x + 80, y: initial.end.y + 40 } });
    expect(commands).toHaveLength(0); expect(await workspace.state()).toEqual(before);
    const saved = page.waitForResponse(response => response.url().endsWith('/api/mapping/execute') && response.request().postDataJSON()?.type === 'connector.move');
    await page.mouse.up(); expect((await saved).status()).toBe(200); await expect(preview).toHaveCount(0);
    const after = await workspace.state();
    expect(commands).toEqual([expect.objectContaining({ type: 'connector.move', expected: original.versionId, payload: { id: original.id, ...delta } })]);
    expect(after.connectors).toEqual([expect.objectContaining({ id: original.id, path: original.path,
      start: { kind: 'free', point: { x: start.x + delta.dx, y: start.y + delta.dy } }, end: { kind: 'free', point: { x: end.x + delta.dx, y: end.y + delta.dy } } })]);
    expect(after.cards).toEqual(before.cards); expect((await (await page.request.get(historyUrl)).json()).undo).toHaveLength(history.undo.length + 1);
    expect(await connectorSvgEnds(line.locator('path'))).toEqual(ends);
    console.log('issue26-free-move', JSON.stringify({ commands, initial, ends, hit, destination, delta, connector: after.connectors![0] }));
  } finally { page.off('request', record); await page.mouse.up(); }
});

test('整体拖动单端绑定连线只移动自由端', async ({ page, workspace }) => {
  const card = await seedConnectorCard(page, workspace, 'move-bound-card', 130, 150), projectId = (await workspace.state()).project.id, end = { x: 600, y: 500 };
  await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'connector.create', expected: null,
    payload: { id: 'moving-bound-line', path: 'straight', start: { kind: 'bound', itemId: card.item.id, side: 'right' }, end: { kind: 'free', point: end } } });
  await page.reload(); await expect(page.getByRole('status')).toHaveText('已保存到本机');
  const before = await workspace.state(), original = before.connectors![0]!, line = page.getByRole('button', { name: '普通连线', exact: true }), commands: Command[] = [];
  const historyUrl = workspace.origin + '/api/mapping/projects/' + encodeURIComponent(projectId) + '/history', history = await (await page.request.get(historyUrl)).json();
  const record = (request: import('@playwright/test').Request) => { if (request.url().endsWith('/api/mapping/execute')) commands.push(request.postDataJSON()); };
  page.on('request', record);
  try {
    await line.click(); const initial = await connectorSvgEnds(line.locator('path'));
    const hit = await line.locator('path').evaluate(element => {
      const path = element as SVGPathElement, p = path.getPointAtLength(path.getTotalLength() / 2), point = new DOMPoint(p.x, p.y).matrixTransform(path.getScreenCTM()!); return { x: point.x, y: point.y };
    });
    const destination = { x: hit.x + 80, y: hit.y + 40 }, from = await connectorWorldPoint(page, hit), to = await connectorWorldPoint(page, destination), delta = { dx: to.x - from.x, dy: to.y - from.y };
    await page.mouse.move(hit.x, hit.y); await page.mouse.down(); await page.mouse.move(destination.x, destination.y, { steps: 6 });
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    const preview = page.getByRole('img', { name: '连线预览', exact: true }); expect(await preview.count(), '单端绑定的整线拖动也必须提供只移动自由端的预览').toBe(1);
    const ends = await connectorSvgEnds(preview.locator('path')); expect(ends).toEqual({ start: initial.start, end: { x: initial.end.x + 80, y: initial.end.y + 40 } });
    expect(commands).toHaveLength(0); expect(await workspace.state()).toEqual(before);
    const saved = page.waitForResponse(response => response.url().endsWith('/api/mapping/execute') && response.request().postDataJSON()?.type === 'connector.move');
    await page.mouse.up(); expect((await saved).status()).toBe(200); await expect(preview).toHaveCount(0);
    const after = await workspace.state();
    expect(commands).toEqual([expect.objectContaining({ type: 'connector.move', expected: original.versionId, payload: { id: original.id, ...delta } })]);
    expect(after.connectors).toEqual([expect.objectContaining({ id: original.id, path: original.path, start: original.start, end: { kind: 'free', point: { x: end.x + delta.dx, y: end.y + delta.dy } } })]);
    expect(after.cards).toEqual(before.cards); expect((await (await page.request.get(historyUrl)).json()).undo).toHaveLength(history.undo.length + 1);
    expect(await connectorSvgEnds(line.locator('path'))).toEqual(ends);
    console.log('issue26-bound-move', JSON.stringify({ commands, initial, ends, hit, destination, delta, connector: after.connectors![0] }));
  } finally { page.off('request', record); await page.mouse.up(); }
});

test('整体拖动双端绑定连线不拆绑且不新增历史', async ({ page, workspace }) => {
  const a = await seedConnectorCard(page, workspace, 'fixed-start-card', 130, 150), b = await seedConnectorCard(page, workspace, 'fixed-end-card', 730, 450), projectId = (await workspace.state()).project.id;
  await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'connector.create', expected: null,
    payload: { id: 'fixed-bound-line', path: 'straight', start: { kind: 'bound', itemId: a.item.id, side: 'right' }, end: { kind: 'bound', itemId: b.item.id, side: 'left' } } });
  await page.reload(); await expect(page.getByRole('status')).toHaveText('已保存到本机');
  const before = await workspace.state(), line = page.getByRole('button', { name: '普通连线', exact: true }), commands: Command[] = [];
  const historyUrl = workspace.origin + '/api/mapping/projects/' + encodeURIComponent(projectId) + '/history', history = await (await page.request.get(historyUrl)).json();
  const record = (request: import('@playwright/test').Request) => { if (request.url().endsWith('/api/mapping/execute')) commands.push(request.postDataJSON()); };
  page.on('request', record);
  try {
    await line.click(); const initial = await connectorSvgEnds(line.locator('path'));
    const hit = await line.locator('path').evaluate(element => {
      const path = element as SVGPathElement, p = path.getPointAtLength(path.getTotalLength() / 2), point = new DOMPoint(p.x, p.y).matrixTransform(path.getScreenCTM()!); return { x: point.x, y: point.y };
    });
    expect(await line.evaluate((element, point) => element.contains(document.elementFromPoint(point.x, point.y)), hit)).toBe(true);
    await page.mouse.move(hit.x, hit.y); await page.mouse.down(); await page.mouse.move(hit.x + 80, hit.y + 40, { steps: 6 });
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    expect(await page.getByRole('img', { name: '连线预览', exact: true }).count()).toBe(0);
    expect(commands).toHaveLength(0); expect(await workspace.state()).toEqual(before); expect(await connectorSvgEnds(line.locator('path'))).toEqual(initial);
    await page.mouse.up(); await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(page.getByRole('status')).toHaveText('已保存到本机');
    expect(commands).toHaveLength(0); expect(await workspace.state()).toEqual(before); expect(await (await page.request.get(historyUrl)).json()).toEqual(history);
    expect(await connectorSvgEnds(line.locator('path'))).toEqual(initial);
    console.log('issue26-fixed-bound-move', JSON.stringify({ commands, initial, hit, connector: before.connectors![0], history }));
  } finally { page.off('request', record); await page.mouse.up(); }
});

test('重接普通连线未知ACK时明确重试原命令', async ({ page, workspace }) => {
  await connectorReconnectAckLoss(page, workspace);
});

test('重接普通连线确定版本冲突后不自动重发', async ({ page, workspace }) => {
  await connectorReconnectVersionConflict(page, workspace);
});
