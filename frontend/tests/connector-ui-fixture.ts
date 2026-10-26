import { expect, type Locator, type Page } from '@playwright/test';
import type { Workspace } from './writing-board-fixture';
import type { ConnectorEndpoint } from '../../backend/src/mapping/connector-contracts';
import type { Command, Receipt } from '../../backend/src/mapping/contracts';

export async function seedConnectorCard(page: Page, workspace: Workspace, id = 'connector-card', x = 180, y = 170) {
  const projectId = (await workspace.state()).project.id;
  await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'thought.create', expected: null,
    payload: { id, title: '连线的卡片', text: '保留卡片正文', x, y } });
  const layout = page.waitForResponse(response => response.url().endsWith('/api/mapping/execute') &&
    response.request().postDataJSON()?.type === 'card.layout');
  await page.reload(); expect((await layout).status()).toBe(200);
  await expect(page.getByRole('status')).toHaveText('已保存到本机');
  const state = await workspace.state();
  await expect(page.locator('.workspace')).toHaveAttribute('data-revision', String(state.project.revision));
  return state.cards.find(card => card.id === id)!;
}

export async function connectorWorldPoint(page: Page, point: { x: number; y: number }) {
  return page.locator('.react-flow__viewport').evaluate((element, value) => {
    const frame = element.closest('.react-flow__renderer')!.getBoundingClientRect();
    const inverse = new DOMMatrix(getComputedStyle(element).transform).inverse();
    const world = new DOMPoint(value.x - frame.left, value.y - frame.top).matrixTransform(inverse);
    return { x: world.x, y: world.y };
  }, point);
}

type Point = { x: number; y: number };
export async function connectorSvgEnds(path: Locator) {
  return path.evaluate(element => {
    const curve = element as SVGPathElement, matrix = curve.getScreenCTM();
    if (!matrix) throw new Error('实际SVG路径没有屏幕变换');
    const a = curve.getPointAtLength(0), b = curve.getPointAtLength(curve.getTotalLength());
    const start = new DOMPoint(a.x, a.y).matrixTransform(matrix), end = new DOMPoint(b.x, b.y).matrixTransform(matrix);
    return { start: { x: start.x, y: start.y }, end: { x: end.x, y: end.y } };
  });
}
export async function connectorSurfaceBox(page: Page, itemId: string, selector = 'article.thought-card') {
  return page.locator('.react-flow__node[data-id]').evaluateAll((nodes, input) => {
    const node = nodes.find(value => (value as HTMLElement).dataset.id === input.itemId);
    const surface = node?.querySelector(input.selector), box = surface?.getBoundingClientRect();
    if (!box?.width || !box.height) throw new Error('测试绑定对象缺少实际可见surface');
    return { x: box.x, y: box.y, width: box.width, height: box.height };
  }, { itemId, selector });
}
export async function connectorCardPair(page: Page, workspace: Workspace) {
  const a = await seedConnectorCard(page, workspace, 'first-card', 130, 150), b = await seedConnectorCard(page, workspace, 'second-card', 700, 400);
  const first = await connectorSurfaceBox(page, a.item.id), second = await connectorSurfaceBox(page, b.item.id);
  const start = { x: first.x + first.width, y: first.y + first.height / 2 }, end = { x: second.x + second.width, y: second.y + second.height / 2 };
  return { a, b, start, end, expected: { start: { kind: 'bound' as const, itemId: a.item.id, side: 'right' as const },
    end: { kind: 'bound' as const, itemId: b.item.id, side: 'right' as const }, screenStart: start, screenEnd: end } };
}
export async function connectorGesture(page: Page, workspace: Workspace, start: Point, end: Point,
  expected: { start: ConnectorEndpoint; end: ConnectorEndpoint; screenStart: Point; screenEnd: Point }, activate = true) {
  if (activate) await page.getByRole('button', { name: '连线', exact: true }).click();
  await expect(page.getByRole('button', { name: '连线', exact: true })).toHaveAttribute('aria-pressed', 'true');
  const before = await workspace.state(), commands: unknown[] = [];
  const record = (request: import('@playwright/test').Request) => {
    if (request.url().endsWith('/api/mapping/execute') && request.method() === 'POST' && request.postDataJSON()?.type === 'connector.create') commands.push(request.postDataJSON());
  };
  page.on('request', record);
  try {
    await page.mouse.move(start.x, start.y); await page.mouse.down(); await page.mouse.move(end.x, end.y, { steps: 6 });
    const preview = page.getByRole('img', { name: '连线预览', exact: true }); expect(await preview.count()).toBe(1);
    const actual = await connectorSvgEnds(preview.locator('path'));
    for (const [key, point] of [['start', expected.screenStart], ['end', expected.screenEnd]] as const) {
      expect(actual[key].x).toBeCloseTo(point.x, 0); expect(actual[key].y).toBeCloseTo(point.y, 0);
    }
    expect(commands).toHaveLength(0); expect(await workspace.state()).toEqual(before);
    const saved = page.waitForResponse(response => response.url().endsWith('/api/mapping/execute') && response.request().postDataJSON()?.type === 'connector.create');
    await page.mouse.up(); expect((await saved).status()).toBe(200);
    await expect(page.getByRole('status')).toHaveText('已保存到本机'); expect(commands).toHaveLength(1);
    const state = await workspace.state(), created = state.connectors!.find(value => !before.connectors?.some(old => old.id === value.id))!;
    expect(created).toMatchObject({ path: 'straight', start: expected.start, end: expected.end });
    for (const key of ['cards', 'tags', 'texts', 'shapes', 'strokes', 'images'] as const) expect(state[key]).toEqual(before[key]);
    const line = page.getByRole('button', { name: '普通连线', exact: true }).filter({ has: page.locator('path') }).last();
    expect(await connectorSvgEnds(line.locator('path'))).toEqual(actual);
    expect(state.project.revision).toBe(before.project.revision + 1);
    console.log('issue26-bound-gesture', JSON.stringify({ start, end, expected, actual, commands, created, protectedCards: state.cards }));
    return created;
  } finally { page.off('request', record); }
}

export async function connectorDraftCancellation(page: Page, workspace: Workspace, cancel: (pointerId: number) => Promise<void>) {
  await seedConnectorCard(page, workspace, 'protected-card', 930, 90);
  const before = await workspace.state(), commands: unknown[] = [];
  const history = async () => {
    const response = await page.request.get(workspace.origin + '/api/mapping/projects/' + encodeURIComponent(before.project.id) + '/history');
    expect(response.status()).toBe(200); return response.json();
  };
  const priorHistory = await history(), record = (request: import('@playwright/test').Request) => {
    if (request.url().endsWith('/api/mapping/execute') && request.method() === 'POST' && request.postDataJSON()?.type === 'connector.create') commands.push(request.postDataJSON());
  };
  page.on('request', record);
  try {
    await page.getByRole('button', { name: '连线', exact: true }).click();
    await expect(page.getByRole('button', { name: '连线', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await page.evaluate(() => window.addEventListener('pointerdown', event => {
      (window as Window & { __issue26Pointer?: number }).__issue26Pointer = event.pointerId;
    }, { once: true, capture: true }));
    await page.mouse.move(280, 450); await page.mouse.down(); await page.mouse.move(650, 550, { steps: 5 });
    const pointerId = await page.evaluate(() => (window as Window & { __issue26Pointer?: number }).__issue26Pointer);
    expect(typeof pointerId).toBe('number');
    const preview = page.getByRole('img', { name: '连线预览', exact: true }); await expect(preview).toBeVisible();
    expect(commands).toHaveLength(0); expect(await workspace.state()).toEqual(before); expect(await history()).toEqual(priorHistory);
    await cancel(pointerId!);
    expect(await preview.count(), '取消必须移除未提交的真实手势预览').toBe(0);
    await page.mouse.move(720, 590); await page.mouse.up();
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())));
    expect(await preview.count()).toBe(0); expect(commands).toHaveLength(0);
    expect(await workspace.state()).toEqual(before); expect(await history()).toEqual(priorHistory);
    console.log('issue26-draft-cancel', JSON.stringify({ pointerId, commands, revision: before.project.revision, history: priorHistory, lateUp: 'actual mouse move/up after cancellation; no execute/state/history change' }));
  } finally {
    page.off('request', record);
    await page.evaluate(() => { delete (window as Window & { __issue26Pointer?: number }).__issue26Pointer; });
  }
}

export async function connectorDirtyCardDelete(page: Page, workspace: Workspace) {
  const pair = await connectorCardPair(page, workspace), projectId = (await workspace.state()).project.id;
  await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'connector.create', expected: null,
    payload: { id: 'own-save-incident', path: 'straight', start: pair.expected.start, end: pair.expected.end } });
  await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'connector.create', expected: null,
    payload: { id: 'own-save-unrelated', path: 'straight', start: { kind: 'free', point: { x: 800, y: 90 } }, end: { kind: 'free', point: { x: 1000, y: 90 } } } });
  await page.reload(); await expect(page.getByRole('status')).toHaveText('已保存到本机');
  const before = await workspace.state(), card = before.cards.find(value => value.id === pair.a.id)!, incident = before.connectors!.find(value => value.id === 'own-save-incident')!;
  const historyUrl = workspace.origin + '/api/mapping/projects/' + encodeURIComponent(projectId) + '/history', history = await (await page.request.get(historyUrl)).json();
  let releaseExecute = () => {}, releaseAck = () => {}, ackReleased = false;
  const executeGate = new Promise<void>(resolve => { releaseExecute = resolve; });
  const ackGate = new Promise<void>(resolve => { releaseAck = () => { ackReleased = true; resolve(); }; });
  const ownCommands: Command[] = [], ownReplies: { command: Command; status: number; receipt: Receipt }[] = [];
  const attempts: { command: Command; status: number; body: unknown }[] = [];
  await page.route('**/api/mapping/execute', async route => {
    const command = route.request().postDataJSON() as Command;
    if (command.type === 'thought.title' && command.payload.id === card.id) {
      ownCommands.push(command); await executeGate; const response = await route.fetch();
      ownReplies.push({ command, status: response.status(), receipt: await response.json() });
      await ackGate; await route.fulfill({ response });
    } else if (command.type === 'thought.delete') {
      const response = await route.fetch(); attempts.push({ command, status: response.status(), body: await response.json() }); await route.fulfill({ response });
    } else await route.continue();
  });
  try {
    await page.locator('.thought-card').first().locator('.title-button').dblclick();
    const editor = page.getByRole('textbox', { name: '卡片标题', exact: true }); await editor.fill('自己的新标题'); await editor.press('Enter');
    await expect.poll(() => ownCommands.length).toBe(1); expect(ownReplies).toHaveLength(0);
    expect(ownCommands[0]).toMatchObject({ type: 'thought.title', projectId, expected: card.versionId, payload: { id: card.id, title: '自己的新标题' } });
    await page.locator('.thought-card').first().locator('.title-button').click();
    await page.getByRole('toolbar', { name: '卡片操作' }).getByRole('button', { name: '更多', exact: true }).click();
    await expect(page.locator('.workspace')).toHaveAttribute('data-revision', String(before.project.revision));
    await page.getByRole('dialog', { name: '更多', exact: true }).getByRole('button', { name: '删除卡片', exact: true }).click();
    await expect(page.getByRole('dialog', { name: '更多', exact: true })).toHaveCount(0);
    expect(ackReleased).toBe(false); expect(ownReplies).toHaveLength(0); expect(attempts).toHaveLength(0);
    expect(await workspace.state()).toEqual(before); expect(await (await page.request.get(historyUrl)).json()).toEqual(history);
    releaseExecute(); await expect.poll(() => ownReplies.length).toBe(1);
    const own = ownReplies[0]!; expect(own.status).toBe(200); expect(ackReleased).toBe(false); expect(attempts).toHaveLength(0);
    const saved = await workspace.state(), savedHistory = await (await page.request.get(historyUrl)).json();
    expect(saved.cards).toEqual(before.cards.map(value => value.id === card.id ? { ...value, title: '自己的新标题', versionId: own.receipt.versions!.thought } : value));
    expect(saved.connectors).toEqual(before.connectors); expect(savedHistory.undo).toHaveLength(history.undo.length + 1);
    const deleted = page.waitForResponse(response => response.url().endsWith('/api/mapping/execute') && response.request().postDataJSON()?.type === 'thought.delete');
    releaseAck(); const response = await deleted, body = await response.json();
    const after = await workspace.state(), afterHistory = await (await page.request.get(historyUrl)).json();
    console.log('issue26-own-save-delete', JSON.stringify({ before, history, ownCommands, ownReplies, saved, savedHistory, attempts, deleteStatus: response.status(), body, after, afterHistory,
      ordering: 'original card+incident projection -> own title held before execute -> actual delete intent/menu closed -> own real200 held before ACK -> release ACK -> original delete', boundary: 'title own receipt only; body/pose/appearance/cardTags advancement not claimed' }));
    expect(response.status(), '正常自身保存确认后首次删卡应成功，不能使用保存前宿主版本自触冲突').toBe(200);
    expect(attempts).toHaveLength(1); expect(attempts[0]!.command).toMatchObject({ type: 'thought.delete', projectId, payload: { id: card.id }, expected: {
      thought: own.receipt.versions!.thought, body: card.body.versionId, pose: card.item.versionId, appearance: card.appearance?.versionId ?? null, cardTags: card.cardTags?.versionId ?? null, connectors: { [incident.id]: incident.versionId } } });
    expect(after.cards).toEqual(before.cards.filter(value => value.id !== card.id)); expect(after.connectors).toEqual(before.connectors!.filter(value => value.id !== incident.id));
    for (const key of ['tags', 'texts', 'shapes', 'strokes', 'images'] as const) expect(after[key]).toEqual(before[key]);
    expect(body.deletedIds).toEqual(expect.arrayContaining([card.id, card.body.id, card.item.id, incident.id]));
    expect(after.project.revision).toBe(before.project.revision + 2); expect(afterHistory.undo).toHaveLength(history.undo.length + 2);
    expect(afterHistory.undo.at(-1)).toMatchObject({ label: 'thought.delete', target: { id: card.id, title: '自己的新标题' } });
    await expect(page.locator('.workspace')).toHaveAttribute('data-revision', String(after.project.revision));
    await expect(page.locator('.thought-card')).toHaveCount(1); await expect(page.getByRole('button', { name: '普通连线', exact: true })).toHaveCount(1);
  } finally { releaseExecute(); releaseAck(); await page.unrouteAll({ behavior: 'wait' }); }
}

export async function connectorReconnectAckLoss(page: Page, workspace: Workspace) {
  const pair = await connectorCardPair(page, workspace), c = await seedConnectorCard(page, workspace, 'retry-target', 950, 90), projectId = (await workspace.state()).project.id;
  await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'connector.create', expected: null,
    payload: { id: 'reconnect-ack-line', path: 'straight', start: { kind: 'bound', itemId: pair.a.item.id, side: 'right' }, end: { kind: 'bound', itemId: pair.b.item.id, side: 'left' } } });
  await page.reload(); await expect(page.getByRole('status')).toHaveText('已保存到本机');
  const before = await workspace.state(), original = before.connectors![0]!, historyUrl = workspace.origin + '/api/mapping/projects/' + encodeURIComponent(projectId) + '/history', history = await (await page.request.get(historyUrl)).json();
  const attempts: { command: Record<string, unknown>; status: number; receipt: unknown }[] = [];
  await page.route('**/api/mapping/execute', async route => {
    const command = route.request().postDataJSON(); if (command?.type !== 'connector.reconnect') { await route.continue(); return; }
    const response = await route.fetch(); attempts.push({ command, status: response.status(), receipt: await response.json() });
    if (attempts.length === 1) await route.abort('connectionreset'); else await route.fulfill({ response });
  });
  try {
    const line = page.getByRole('button', { name: '普通连线', exact: true }); await line.click();
    const box = await connectorSurfaceBox(page, c.item.id), target = { x: box.x, y: box.y + box.height / 2 };
    await page.getByRole('button', { name: '连线终点', exact: true }).hover(); await page.mouse.down(); await page.mouse.move(target.x, target.y, { steps: 6 }); await page.mouse.up();
    const retry = page.getByRole('button', { name: '重试保存', exact: true }); await expect(retry).toBeVisible(); expect(attempts).toHaveLength(1); expect(attempts[0]!.status).toBe(200);
    expect(attempts[0]!.command).toMatchObject({ type: 'connector.reconnect', expected: original.versionId, payload: { id: original.id, endpoint: 'end', value: { kind: 'bound', itemId: c.item.id, side: 'left' } } });
    const committed = await workspace.state(), committedLine = committed.connectors![0]!, committedHistory = await (await page.request.get(historyUrl)).json(); expect(committedLine).toMatchObject({ id: original.id, start: original.start, end: { kind: 'bound', itemId: c.item.id, side: 'left' } }); expect(committed.cards).toEqual(before.cards); expect(committedHistory.undo).toHaveLength(history.undo.length + 1);
    await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'connector.path', expected: committedLine.versionId, payload: { id: original.id, path: 'curve' } });
    const peer = await workspace.state(), peerHistory = await (await page.request.get(historyUrl)).json(); expect(peer.connectors![0]!.versionId).not.toBe(committedLine.versionId);
    const confirmed = page.waitForResponse(response => response.url().endsWith('/api/mapping/execute') && response.request().postDataJSON()?.type === 'connector.reconnect');
    await retry.click(); expect((await confirmed).status()).toBe(200); await expect(retry).toHaveCount(0); await expect(page.getByRole('status')).toHaveText('已保存到本机'); await expect(page.getByRole('img', { name: '连线预览', exact: true })).toHaveCount(0);
    expect(attempts).toHaveLength(2); expect(attempts[1]).toEqual(attempts[0]); expect(attempts[1]!.command.expected).toBe(original.versionId); expect(await workspace.state()).toEqual(peer); expect(await (await page.request.get(historyUrl)).json()).toEqual(peerHistory); expect(peerHistory.undo.filter((entry: { label: string }) => entry.label === 'connector.reconnect')).toHaveLength(1);
    console.log('issue26-reconnect-ack-loss', JSON.stringify({ attempts, original, committedLine, peerLine: peer.connectors![0], peerHistory, boundary: 'real reconnect200 ACK aborted; peer changes same line version/path; explicit original command+receipt retry never rebases expected or duplicates history' }));
  } finally { await page.unrouteAll({ behavior: 'wait' }); }
}

export async function connectorReconnectVersionConflict(page: Page, workspace: Workspace) {
  const pair = await connectorCardPair(page, workspace), c = await seedConnectorCard(page, workspace, 'conflict-target', 950, 90), projectId = (await workspace.state()).project.id;
  await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'connector.create', expected: null,
    payload: { id: 'reconnect-conflict-line', path: 'straight', start: { kind: 'bound', itemId: pair.a.item.id, side: 'right' }, end: { kind: 'bound', itemId: pair.b.item.id, side: 'left' } } });
  await page.reload(); await expect(page.getByRole('status')).toHaveText('已保存到本机');
  const before = await workspace.state(), original = before.connectors![0]!, historyUrl = workspace.origin + '/api/mapping/projects/' + encodeURIComponent(projectId) + '/history';
  let release = () => {}; const gate = new Promise<void>(resolve => { release = resolve; });
  const commands: Record<string, unknown>[] = [], attempts: { command: Record<string, unknown>; status: number; body: unknown }[] = [];
  await page.route('**/api/mapping/execute', async route => {
    const command = route.request().postDataJSON(); if (command?.type !== 'connector.reconnect') { await route.continue(); return; }
    commands.push(command); if (commands.length === 1) await gate;
    const response = await route.fetch(); attempts.push({ command, status: response.status(), body: await response.json() }); await route.fulfill({ response });
  });
  try {
    const line = page.getByRole('button', { name: '普通连线', exact: true }); await line.click();
    const box = await connectorSurfaceBox(page, c.item.id), target = { x: box.x, y: box.y + box.height / 2 }, handle = page.getByRole('button', { name: '连线终点', exact: true });
    const refused = page.waitForResponse(response => response.url().endsWith('/api/mapping/execute') && response.request().postDataJSON()?.type === 'connector.reconnect');
    await handle.hover(); await page.mouse.down(); await page.mouse.move(target.x, target.y, { steps: 6 }); await page.mouse.up(); await expect.poll(() => commands.length).toBe(1);
    await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'connector.path', expected: original.versionId, payload: { id: original.id, path: 'curve' } });
    const peer = await workspace.state(), peerLine = peer.connectors![0]!, peerHistory = await (await page.request.get(historyUrl)).json(); expect(peerLine.end).toEqual(original.end); expect(peerLine.versionId).not.toBe(original.versionId); expect(peer.cards).toEqual(before.cards);
    release(); expect((await refused).status()).toBe(409); await expect(page.getByRole('alert')).toContainText('连线已更新，请重新读取');
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    expect(attempts).toEqual([expect.objectContaining({ status: 409, body: { code: 'VERSION_CONFLICT', message: '连线已更新，请重新读取' }, command: expect.objectContaining({ expected: original.versionId }) })]);
    expect(commands).toHaveLength(1); expect(await workspace.state()).toEqual(peer); expect(await (await page.request.get(historyUrl)).json()).toEqual(peerHistory);
    const ready = await handle.isEnabled(); console.log('issue26-reconnect-known-conflict', JSON.stringify({ attempts, peerLine, ready, previewCount: await page.getByRole('img', { name: '连线预览', exact: true }).count() }));
    expect(ready, '确定版本拒绝后应退出未确认请求，允许本人再次明确重接').toBe(true);
    const saved = page.waitForResponse(response => response.url().endsWith('/api/mapping/execute') && response.request().postDataJSON()?.type === 'connector.reconnect' && response.request().postDataJSON()?.commandId !== commands[0]!.commandId);
    await handle.hover(); await page.mouse.down(); await page.mouse.move(target.x, target.y, { steps: 6 }); await page.mouse.up(); expect((await saved).status()).toBe(200); await expect(page.getByRole('status')).toHaveText('已保存到本机'); await expect(page.getByRole('img', { name: '连线预览', exact: true })).toHaveCount(0);
    expect(commands).toHaveLength(2); expect(commands[1]!.commandId).not.toBe(commands[0]!.commandId); expect(commands[1]).toMatchObject({ type: 'connector.reconnect', expected: peerLine.versionId, payload: { id: original.id, endpoint: 'end', value: { kind: 'bound', itemId: c.item.id, side: 'left' } } });
    const after = await workspace.state(), afterHistory = await (await page.request.get(historyUrl)).json(); expect(after.connectors![0]).toMatchObject({ id: original.id, path: 'curve', start: original.start, end: { kind: 'bound', itemId: c.item.id, side: 'left' } }); expect(after.cards).toEqual(before.cards); expect(afterHistory.undo).toHaveLength(peerHistory.undo.length + 1); expect(afterHistory.undo.filter((entry: { label: string }) => entry.label === 'connector.reconnect')).toHaveLength(1);
    console.log('issue26-reconnect-conflict-resolution', JSON.stringify({ commands, attempts, peerLine, afterLine: after.connectors![0], afterHistory, boundary: 'real old-version409 without automatic resend/partial writes; only a new explicit endpoint gesture creates fresh identity and captured peer version' }));
  } finally { release(); await page.unrouteAll({ behavior: 'wait' }); }
}
