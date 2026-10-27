import { test, expect } from './writing-board-fixture';
import type { Locator } from '@playwright/test';
import type { Command, ProjectHistory, Receipt } from '../../backend/src/mapping/contracts';
import type { ConnectorEndpoint } from '../../backend/src/mapping/connector-contracts';
import type { ProjectState } from '../src/api';
import { connectorSurfaceBox, connectorSvgEnds, connectorWorldPoint, seedConnectorCard } from './connector-ui-fixture';

test('键盘可创建包含自由端的普通连线', async ({ page, workspace }) => {
  const initial = await workspace.state(), projectId = initial.project.id;
  const historyUrl = workspace.origin + '/api/mapping/projects/' + encodeURIComponent(projectId) + '/history';
  const history = async () => { const response = await page.request.get(historyUrl); expect(response.status()).toBe(200); return await response.json() as ProjectHistory; };
  const initialHistory = await history(), attempts: { command: Extract<Command, { type: 'connector.create' }>; status: number; receipt: Receipt }[] = [];
  const tool = page.getByRole('button', { name: '连线', exact: true }), blank = page.getByRole('button', { name: '从空白处开始连线', exact: true });
  const free = page.getByRole('button', { name: '连线自由终点', exact: true }), preview = page.getByRole('img', { name: '连线预览', exact: true });
  const instructions = page.getByText('方向键调整自由终点，Enter 确认，Escape 取消', { exact: true });
  const frame = async () => await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  async function tabTo(target: Locator) {
    await expect(target).toBeVisible();
    for (let step = 0; step < 100; step++) {
      if (await target.evaluate(element => element === document.activeElement)) return;
      await page.keyboard.press(await target.evaluate(element =>
        element.compareDocumentPosition(document.activeElement ?? document.body) & Node.DOCUMENT_POSITION_PRECEDING ? 'Tab' : 'Shift+Tab'));
    }
    throw new Error('正常 Tab 顺序无法到达自由端连线控件');
  }
  async function unchanged(before: ProjectState, beforeHistory: ProjectHistory, count: number) {
    expect(attempts).toHaveLength(count); expect(await workspace.state()).toEqual(before); expect(await history()).toEqual(beforeHistory);
  }
  async function activate() { await tabTo(tool); await page.keyboard.press('Enter'); await expect(tool).toHaveAttribute('aria-pressed', 'true'); }
  async function beginBlank() {
    await tabTo(blank); await page.keyboard.press('Enter'); await expect(preview).toBeVisible(); await expect(free).toBeFocused(); await expect(instructions).toBeVisible();
    return await connectorSvgEnds(preview.locator('path'));
  }
  function endpoint(actual: ConnectorEndpoint, expected: ConnectorEndpoint) {
    expect(actual.kind).toBe(expected.kind);
    if (actual.kind === 'free' && expected.kind === 'free') {
      expect(Number.isFinite(actual.point.x) && Number.isFinite(actual.point.y)).toBe(true);
      expect(actual.point.x).toBeCloseTo(expected.point.x, 6); expect(actual.point.y).toBeCloseTo(expected.point.y, 6);
    } else expect(actual).toEqual(expected);
  }
  async function finish(variant: string, expectedStart: ConnectorEndpoint, expectedEnd: ConnectorEndpoint) {
    const before = await workspace.state(), beforeHistory = await history(), count = attempts.length, previewEnds = await connectorSvgEnds(preview.locator('path'));
    await unchanged(before, beforeHistory, count);
    const saved = page.waitForResponse(response => response.url().endsWith('/api/mapping/execute') && response.request().postDataJSON()?.type === 'connector.create');
    await page.keyboard.press('Enter'); const response = await saved, receipt = await response.json() as Receipt; expect(response.status()).toBe(200);
    await expect(page.getByRole('status')).toHaveText('已保存到本机'); await expect(tool).toHaveAttribute('aria-pressed', 'false');
    await expect(page.getByRole('button', { name: '选择', exact: true })).toHaveAttribute('aria-pressed', 'true'); await expect(preview).toHaveCount(0);
    const after = await workspace.state(), afterHistory = await history(); expect(attempts).toHaveLength(count + 1);
    const request = attempts[count]!, command = request.command, created = after.connectors!.find(value => value.id === command.payload.id)!;
    expect(request.status).toBe(200); expect(request.receipt).toEqual(receipt); expect(command).toMatchObject({ projectId, type: 'connector.create', expected: null, payload: { path: 'straight' } });
    expect(command.commandId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    expect(command.payload.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    expect(before.connectors?.some(value => value.id === command.payload.id)).toBe(false); endpoint(command.payload.start, expectedStart); endpoint(command.payload.end, expectedEnd);
    expect(created).toEqual({ ...command.payload, kind: 'connector', versionId: receipt.connectorVersions![command.payload.id],
      style: { startMarker: 'none', endMarker: 'open-arrow', color: '#626e81', width: 4, dash: 'solid' } });
    expect(receipt.commandId).toBe(command.commandId); expect(receipt.changedIds).toEqual([created.id]);
    expect(after.connectors).toEqual([...(before.connectors ?? []), created]);
    for (const key of ['cards', 'tags', 'texts', 'shapes', 'images', 'strokes'] as const) expect(after[key]).toEqual(before[key]);
    expect(after.project.revision).toBe(before.project.revision + 1); expect(afterHistory.revision).toBe(beforeHistory.revision + 1);
    expect(afterHistory.undo.slice(0, -1)).toEqual(beforeHistory.undo); expect(afterHistory.undo).toHaveLength(beforeHistory.undo.length + 1);
    expect(afterHistory.undo.at(-1)).toMatchObject({ id: command.commandId, label: 'connector.create', target: { id: created.id } }); expect(afterHistory.redo).toEqual(beforeHistory.redo);
    const rendered = page.getByRole('button', { name: '普通连线', exact: true }).last(); await expect(rendered).toHaveAttribute('aria-pressed', 'true'); await expect(rendered).toBeFocused();
    const renderedEnds = await connectorSvgEnds(rendered.locator('path')); expect(renderedEnds).toEqual(previewEnds);
    console.log('issue26-keyboard-free-created', JSON.stringify({ variant, command, receipt, expectedStart, expectedEnd, before, beforeHistory, after, afterHistory, previewEnds, renderedEnds,
      boundary: 'actual Tab/Arrow/Enter; original HTTP200 and new identities; exactly one create history; existing lines/hosts/content retained; completed selection and focus' }));
  }
  await page.route('**/api/mapping/execute', async route => {
    const command = route.request().postDataJSON() as Command;
    if (command.type !== 'connector.create') { await route.continue(); return; }
    const response = await route.fetch(); attempts.push({ command, status: response.status(), receipt: await response.json() as Receipt }); await route.fulfill({ response });
  });
  try {
    expect(initial.cards).toEqual([]); expect(initial.connectors ?? []).toEqual([]); await activate();
    const anchorCount = await page.locator('.connector-entry').count(), entryCount = await blank.count();
    await unchanged(initial, initialHistory, 0);
    console.log('issue26-keyboard-free-entry', JSON.stringify({ initial, initialHistory, anchorCount, entryCount, attempts,
      labels: { blank: '从空白处开始连线', free: '连线自由终点', instructions: '方向键调整自由终点，Enter 确认，Escape 取消' },
      boundary: 'empty project, real keyboard connector activation, no anchor prerequisite; bounded actual public start-from-blank entry availability' }));
    expect(anchorCount).toBe(0); expect(entryCount, '空项目也必须提供可由键盘到达的从空白处开始连线入口').toBe(1); expect(await blank.isEnabled()).toBe(true);
    const cancelled = await beginBlank();
    await free.dispatchEvent('keydown', { key: 'ArrowRight', code: 'ArrowRight', isComposing: true, bubbles: true });
    await free.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 229, bubbles: true }); await frame();
    expect(await connectorSvgEnds(preview.locator('path'))).toEqual(cancelled); await unchanged(initial, initialHistory, 0);
    await page.keyboard.press('ArrowRight'); await frame(); const cancelling = await connectorSvgEnds(preview.locator('path'));
    expect(cancelling.start).toEqual(cancelled.start); expect(cancelling.end.x).toBeGreaterThan(cancelled.end.x); await unchanged(initial, initialHistory, 0);
    await page.keyboard.press('Escape'); await frame(); expect(await preview.count()).toBe(0); await expect(blank).toBeFocused(); await unchanged(initial, initialHistory, 0);
    console.log('issue26-keyboard-free-cancel-ime', JSON.stringify({ cancelled, cancelling, attempts, state: await workspace.state(), history: await history(),
      boundary: 'synthetic isComposing Arrow and keyCode229 Enter ignored; actual Arrow then Escape cancels without writes; focus returns to blank entry; native IME not claimed' }));
    const first = await beginBlank();
    for (const key of ['ArrowRight', 'ArrowRight', 'ArrowDown']) await page.keyboard.press(key); await frame();
    const moved = await connectorSvgEnds(preview.locator('path')); expect(moved.start).toEqual(first.start); expect(moved.end.x).toBeGreaterThan(first.end.x); expect(moved.end.y).toBeGreaterThan(first.end.y);
    await finish('free-free', { kind: 'free', point: await connectorWorldPoint(page, moved.start) }, { kind: 'free', point: await connectorWorldPoint(page, moved.end) });
    const host = await seedConnectorCard(page, workspace, 'keyboard-free-host', 130, 150);
    await activate(); const second = await beginBlank();
    const right = page.locator('.connector-entry[data-connector-item="' + host.item.id + '"][data-connector-side="right"]');
    await tabTo(right); await expect(right).toHaveAccessibleName(/卡片.*右/); const boundEnd = await connectorSvgEnds(preview.locator('path')), surface = await connectorSurfaceBox(page, host.item.id);
    expect(boundEnd.start).toEqual(second.start); expect(boundEnd.end.x).toBeCloseTo(surface.x + surface.width, 0); expect(boundEnd.end.y).toBeCloseTo(surface.y + surface.height / 2, 0);
    await finish('free-bound', { kind: 'free', point: await connectorWorldPoint(page, second.start) }, { kind: 'bound', itemId: host.item.id, side: 'right' });
    await activate(); const left = page.locator('.connector-entry[data-connector-item="' + host.item.id + '"][data-connector-side="left"]');
    await tabTo(left); await page.keyboard.press('Enter'); await expect(preview).toBeVisible(); await tabTo(free); await expect(instructions).toBeVisible();
    const third = await connectorSvgEnds(preview.locator('path')); for (const key of ['ArrowRight', 'ArrowDown']) await page.keyboard.press(key); await frame();
    const freeEnd = await connectorSvgEnds(preview.locator('path')); expect(freeEnd.start).toEqual(third.start); expect(freeEnd.end.x).toBeGreaterThan(third.end.x); expect(freeEnd.end.y).toBeGreaterThan(third.end.y);
    await finish('bound-free', { kind: 'bound', itemId: host.item.id, side: 'left' }, { kind: 'free', point: await connectorWorldPoint(page, freeEnd.end) });
    expect(attempts).toHaveLength(3); expect(new Set(attempts.map(value => value.command.commandId)).size).toBe(3); expect(new Set(attempts.map(value => value.command.payload.id)).size).toBe(3);
    console.log('issue26-keyboard-free-complete', JSON.stringify({ attempts, variants: ['free-free', 'free-bound', 'bound-free'], boundary: 'one complete behavior test; three actual creations plus zero-write cancel/IME routing; no reconnect/move test coverage claimed' }));
  } finally { await page.unrouteAll({ behavior: 'wait' }); }
});


test('键盘可解绑并调整普通连线自由端', async ({ page, workspace }) => {
  const a = await seedConnectorCard(page, workspace, 'keyboard-endpoint-a', 130, 150), b = await seedConnectorCard(page, workspace, 'keyboard-endpoint-b', 700, 400);
  const projectId = (await workspace.state()).project.id, id = crypto.randomUUID(), unrelatedId = crypto.randomUUID();
  const fixtureCommands: Extract<Command, { type: 'connector.create' }>[] = [
    { commandId: crypto.randomUUID(), projectId, type: 'connector.create', expected: null, payload: { id, path: 'curve',
      start: { kind: 'bound', itemId: a.item.id, side: 'right' }, end: { kind: 'bound', itemId: b.item.id, side: 'left' } } },
    { commandId: crypto.randomUUID(), projectId, type: 'connector.create', expected: null, payload: { id: unrelatedId, path: 'straight',
      start: { kind: 'free', point: { x: 70, y: 80 } }, end: { kind: 'free', point: { x: 190, y: 95 } } } },
  ];
  for (const command of fixtureCommands) await workspace.execute(page, command);
  await page.reload(); await expect(page.getByRole('status')).toHaveText('已保存到本机');
  const baseline = await workspace.state(), historyUrl = workspace.origin + '/api/mapping/projects/' + encodeURIComponent(projectId) + '/history';
  const history = async () => { const response = await page.request.get(historyUrl); expect(response.status()).toBe(200); return await response.json() as ProjectHistory; };
  const baselineHistory = await history(), attempts: { command: Command; status: number; receipt: Receipt }[] = [];
  const line = page.getByRole('button', { name: '普通连线', exact: true }).nth(baseline.connectors!.findIndex(value => value.id === id));
  const preview = page.getByRole('img', { name: '连线预览', exact: true }), instructions = page.getByText('方向键调整自由端，Enter 确认，Escape 取消', { exact: true });
  const baselineEnds = await connectorSvgEnds(line.locator('path'));
  const frame = async () => await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  async function tabTo(target: Locator) {
    await expect(target).toBeVisible();
    for (let step = 0; step < 100; step++) {
      if (await target.evaluate(element => element === document.activeElement)) return;
      await page.keyboard.press(await target.evaluate(element =>
        element.compareDocumentPosition(document.activeElement ?? document.body) & Node.DOCUMENT_POSITION_PRECEDING ? 'Tab' : 'Shift+Tab'));
    }
    throw new Error('正常 Tab 顺序无法到达连线端点编辑控件');
  }
  async function unchanged(before: ProjectState, beforeHistory: ProjectHistory, count: number) {
    expect(attempts).toHaveLength(count); expect(await workspace.state()).toEqual(before); expect(await history()).toEqual(beforeHistory);
  }
  async function begin(side: 'start' | 'end') {
    await tabTo(line); await page.keyboard.press('Enter'); await expect(line).toHaveAttribute('aria-pressed', 'true');
    const handle = page.getByRole('button', { name: side === 'end' ? '连线终点' : '连线起点', exact: true });
    await tabTo(handle); await page.keyboard.press('Enter'); await expect(preview).toBeVisible();
    return { handle, free: page.getByRole('button', { name: side === 'end' ? '连线自由终点' : '连线自由起点', exact: true }) };
  }
  await page.route('**/api/mapping/execute', async route => {
    const command = route.request().postDataJSON() as Command;
    if (!command.type.startsWith('connector.')) { await route.continue(); return; }
    const response = await route.fetch(); attempts.push({ command, status: response.status(), receipt: await response.json() as Receipt }); await route.fulfill({ response });
  });
  try {
    const opened = await begin('end'), entryCount = await opened.free.count(); await unchanged(baseline, baselineHistory, 0);
    console.log('issue26-keyboard-endpoint-free-entry', JSON.stringify({ fixtureCommands, baseline, baselineHistory, attempts, entryCount,
      previewCount: await preview.count(), handleFocused: await opened.handle.evaluate(element => element === document.activeElement),
      labels: { start: '连线自由起点', end: '连线自由终点', instructions: '方向键调整自由端，Enter 确认，Escape 取消' },
      boundary: 'real keyboard line selection and endpoint activation; bounded visible free-control availability; fixture commands precede baseline' }));
    expect(entryCount, '键盘编辑已绑定端点必须提供明确的自由端控件').toBe(1); expect(await opened.free.isEnabled()).toBe(true);
    await tabTo(opened.free); await expect(instructions).toBeVisible(); const cancelled = await connectorSvgEnds(preview.locator('path'));
    await opened.free.dispatchEvent('keydown', { key: 'ArrowRight', code: 'ArrowRight', isComposing: true, bubbles: true });
    await opened.free.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 229, bubbles: true }); await frame();
    expect(await connectorSvgEnds(preview.locator('path'))).toEqual(cancelled); await unchanged(baseline, baselineHistory, 0);
    await page.keyboard.press('ArrowRight'); await page.keyboard.press('ArrowDown'); await frame(); const cancelling = await connectorSvgEnds(preview.locator('path'));
    expect(cancelling.start).toEqual(cancelled.start); expect(cancelling.end.x).toBeGreaterThan(cancelled.end.x); expect(cancelling.end.y).toBeGreaterThan(cancelled.end.y);
    await unchanged(baseline, baselineHistory, 0); await page.keyboard.press('Escape'); await frame(); expect(await preview.count()).toBe(0);
    await expect(opened.handle).toBeFocused(); expect(await connectorSvgEnds(line.locator('path'))).toEqual(baselineEnds); await unchanged(baseline, baselineHistory, 0);
    console.log('issue26-keyboard-endpoint-cancel-ime', JSON.stringify({ cancelled, cancelling, attempts, state: await workspace.state(), history: await history(),
      boundary: 'synthetic IME ignored; actual Arrow then Escape; zero execute/state/history; focus returns to original endpoint; native IME not claimed' }));
    for (const [side, previousKind, variant] of [['end', 'bound', 'detach-end'], ['end', 'free', 'adjust-end'], ['start', 'bound', 'detach-start'], ['start', 'free', 'adjust-start']] as const) {
      const before = await workspace.state(), beforeHistory = await history(), count = attempts.length, original = before.connectors!.find(value => value.id === id)!;
      expect(original[side].kind).toBe(previousKind); const other = side === 'end' ? 'start' : 'end', controls = await begin(side);
      const initial = await connectorSvgEnds(preview.locator('path')); await tabTo(controls.free); await expect(instructions).toBeVisible();
      const freePreview = await connectorSvgEnds(preview.locator('path')); expect(freePreview[other]).toEqual(initial[other]);
      await page.keyboard.press('ArrowRight'); await page.keyboard.press('ArrowDown'); await frame(); const moved = await connectorSvgEnds(preview.locator('path'));
      expect(moved[other]).toEqual(initial[other]); expect(moved[side].x).toBeGreaterThan(freePreview[side].x); expect(moved[side].y).toBeGreaterThan(freePreview[side].y);
      await unchanged(before, beforeHistory, count); const expectedPoint = await connectorWorldPoint(page, moved[side]);
      const saved = page.waitForResponse(reply => reply.url().endsWith('/api/mapping/execute') && reply.request().postDataJSON()?.type?.startsWith('connector.'));
      await page.keyboard.press('Enter'); const response = await saved, receipt = await response.json() as Receipt; expect(response.status()).toBe(200);
      await expect(page.getByRole('status')).toHaveText('已保存到本机'); await expect(preview).toHaveCount(0); await expect(line).toBeFocused(); await expect(line).toHaveAttribute('aria-pressed', 'true');
      const after = await workspace.state(), afterHistory = await history(), changed = after.connectors!.find(value => value.id === id)!;
      expect(attempts).toHaveLength(count + 1); const request = attempts[count]!, command = request.command; expect(request.status).toBe(200); expect(request.receipt).toEqual(receipt);
      expect(command.type).toBe('connector.reconnect'); if (command.type !== 'connector.reconnect' || command.payload.value.kind !== 'free') throw new Error('明确自由端编辑必须只发送一次真实reconnect自由端命令');
      expect(command).toMatchObject({ projectId, expected: original.versionId, payload: { id, endpoint: side, value: { kind: 'free' } } });
      expect(command.commandId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
      expect(command.payload.value.point.x).toBeCloseTo(expectedPoint.x, 6); expect(command.payload.value.point.y).toBeCloseTo(expectedPoint.y, 6);
      expect(receipt.commandId).toBe(command.commandId); expect(receipt.projectId).toBe(projectId); expect(receipt.changedIds).toEqual([id]);
      expect(changed).toEqual({ ...original, [side]: command.payload.value, versionId: receipt.connectorVersions![id] }); expect(changed.versionId).not.toBe(original.versionId);
      expect(changed[other]).toEqual(original[other]); expect(changed.path).toBe('curve'); expect(after.connectors).toEqual(before.connectors!.map(value => value.id === id ? changed : value));
      for (const key of ['cards', 'tags', 'texts', 'shapes', 'images', 'strokes'] as const) expect(after[key]).toEqual(before[key]);
      expect(after.project).toEqual({ ...before.project, revision: before.project.revision + 1 }); expect(afterHistory.revision).toBe(beforeHistory.revision + 1);
      expect(afterHistory.undo.slice(0, -1)).toEqual(beforeHistory.undo); expect(afterHistory.undo).toHaveLength(beforeHistory.undo.length + 1);
      expect(afterHistory.undo.at(-1)).toMatchObject({ id: command.commandId, label: 'connector.reconnect', target: { id } }); expect(afterHistory.redo).toEqual(beforeHistory.redo);
      expect(await connectorSvgEnds(line.locator('path'))).toEqual(moved);
      console.log('issue26-keyboard-endpoint-saved', JSON.stringify({ variant, side, command, receipt, before, beforeHistory, after, afterHistory, initial, freePreview, moved,
        boundary: 'actual keyboard free-control/Arrow/Enter; same line/path/other endpoint and protected domains; new UUID/version; one true200 and history+1; original line focus' }));
    }
    expect(attempts).toHaveLength(4); expect(new Set(attempts.map(value => value.command.commandId)).size).toBe(4);
    console.log('issue26-keyboard-endpoint-complete', JSON.stringify({ attempts, variants: ['detach-end', 'adjust-end', 'detach-start', 'adjust-start'], boundary: 'one endpoint-keyboard behavior, no whole-line move coverage' }));
  } finally { await page.unrouteAll({ behavior: 'wait' }); }
});


test('键盘移动整线仅调整自由端', async ({ page, workspace }) => {
  const a = await seedConnectorCard(page, workspace, 'keyboard-move-a', 130, 150), b = await seedConnectorCard(page, workspace, 'keyboard-move-b', 700, 400);
  const projectId = (await workspace.state()).project.id, historyUrl = workspace.origin + '/api/mapping/projects/' + encodeURIComponent(projectId) + '/history';
  const history = async () => { const response = await page.request.get(historyUrl); expect(response.status()).toBe(200); return await response.json() as ProjectHistory; };
  const free = (x: number, y: number): ConnectorEndpoint => ({ kind: 'free', point: { x, y } });
  const fixtureCommands: Extract<Command, { type: 'connector.create' }>[] = ([
    { path: 'straight', start: free(70, 70), end: free(190, 95) },
    { path: 'curve', start: { kind: 'bound', itemId: a.item.id, side: 'right' }, end: free(600, 300) },
    { path: 'elbow', start: free(480, 260), end: { kind: 'bound', itemId: b.item.id, side: 'left' } },
    { path: 'curve', start: { kind: 'bound', itemId: a.item.id, side: 'right' }, end: { kind: 'bound', itemId: b.item.id, side: 'left' } },
  ] satisfies Omit<Extract<Command, { type: 'connector.create' }>['payload'], 'id'>[]).map(payload => ({ commandId: crypto.randomUUID(), projectId, type: 'connector.create', expected: null, payload: { ...payload, id: crypto.randomUUID() } }));
  for (const command of fixtureCommands) await workspace.execute(page, command);
  await page.reload(); await expect(page.getByRole('status')).toHaveText('已保存到本机');
  const baseline = await workspace.state(), baselineHistory = await history(), attempts: { command: Command; status: number; receipt: Receipt }[] = [];
  const line = (id: string) => page.getByRole('button', { name: '普通连线', exact: true }).nth(baseline.connectors!.findIndex(value => value.id === id));
  const move = page.getByRole('button', { name: '移动连线', exact: true }), preview = page.getByRole('img', { name: '连线预览', exact: true });
  const instructions = page.getByText('方向键移动连线，Enter 确认，Escape 取消', { exact: true });
  const frame = async () => await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  async function tabTo(target: Locator) {
    await expect(target).toBeVisible();
    for (let step = 0; step < 100; step++) {
      if (await target.evaluate(element => element === document.activeElement)) return;
      await page.keyboard.press(await target.evaluate(element =>
        element.compareDocumentPosition(document.activeElement ?? document.body) & Node.DOCUMENT_POSITION_PRECEDING ? 'Tab' : 'Shift+Tab'));
    }
    throw new Error('正常 Tab 顺序无法到达移动连线控件');
  }
  async function unchanged(before: ProjectState, beforeHistory: ProjectHistory, count: number) {
    expect(attempts).toHaveLength(count); expect(await workspace.state()).toEqual(before); expect(await history()).toEqual(beforeHistory);
  }
  async function select(id: string) { await tabTo(line(id)); await page.keyboard.press('Enter'); await expect(line(id)).toHaveAttribute('aria-pressed', 'true'); }
  async function begin(id: string) {
    await select(id); await tabTo(move); await page.keyboard.press('Enter'); await expect(preview).toBeVisible(); await expect(move).toBeFocused(); await expect(instructions).toBeVisible();
  }
  const shifted = (endpoint: ConnectorEndpoint): ConnectorEndpoint => endpoint.kind === 'free' ? free(endpoint.point.x + 20, endpoint.point.y + 10) : endpoint;
  await page.route('**/api/mapping/execute', async route => {
    const command = route.request().postDataJSON() as Command;
    if (!command.type.startsWith('connector.')) { await route.continue(); return; }
    const response = await route.fetch(); attempts.push({ command, status: response.status(), receipt: await response.json() as Receipt }); await route.fulfill({ response });
  });
  try {
    const firstId = fixtureCommands[0]!.payload.id; await select(firstId); const entryCount = await move.count(); await unchanged(baseline, baselineHistory, 0);
    console.log('issue26-keyboard-move-entry', JSON.stringify({ fixtureCommands, baseline, baselineHistory, attempts, entryCount,
      lineFocused: await line(firstId).evaluate(element => element === document.activeElement), label: '移动连线',
      boundary: 'real keyboard line selection; bounded public move entry availability; all fixtures precede baseline' }));
    expect(entryCount, '可移动普通连线必须提供明确的键盘整线移动入口').toBe(1); expect(await move.isEnabled()).toBe(true);
    await begin(firstId); const cancelled = await connectorSvgEnds(preview.locator('path'));
    await move.dispatchEvent('keydown', { key: 'ArrowRight', code: 'ArrowRight', isComposing: true, bubbles: true });
    await move.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 229, bubbles: true }); await frame();
    expect(await connectorSvgEnds(preview.locator('path'))).toEqual(cancelled); await unchanged(baseline, baselineHistory, 0);
    await page.keyboard.press('ArrowRight'); await frame(); const cancelling = await connectorSvgEnds(preview.locator('path'));
    expect(cancelling.start.x).toBeGreaterThan(cancelled.start.x); expect(cancelling.end.x).toBeGreaterThan(cancelled.end.x);
    await unchanged(baseline, baselineHistory, 0); await page.keyboard.press('Escape'); await frame(); expect(await preview.count()).toBe(0);
    await expect(move).toBeFocused(); await unchanged(baseline, baselineHistory, 0);
    console.log('issue26-keyboard-move-cancel-ime', JSON.stringify({ cancelled, cancelling, attempts, state: await workspace.state(), history: await history(),
      boundary: 'synthetic IME ignored; real Arrow/Escape zero writes; persistent move entry receives original focus; native IME not claimed' }));
    for (const [index, variant] of ['both-free', 'bound-start-free-end', 'free-start-bound-end'].entries()) {
      const id = fixtureCommands[index]!.payload.id, before = await workspace.state(), beforeHistory = await history(), count = attempts.length, original = before.connectors!.find(value => value.id === id)!;
      await begin(id); const initial = await connectorSvgEnds(preview.locator('path'));
      for (const key of ['ArrowRight', 'ArrowRight', 'ArrowDown']) await page.keyboard.press(key); await frame(); const moved = await connectorSvgEnds(preview.locator('path'));
      for (const side of ['start', 'end'] as const) {
        const endpoint = original[side];
        if (endpoint.kind === 'free') { const point = await connectorWorldPoint(page, moved[side]); expect(point.x).toBeCloseTo(endpoint.point.x + 20, 6); expect(point.y).toBeCloseTo(endpoint.point.y + 10, 6); }
        else { expect(moved[side]).toEqual(initial[side]); const box = await connectorSurfaceBox(page, endpoint.itemId);
          expect(moved[side].x).toBeCloseTo(endpoint.side === 'right' ? box.x + box.width : box.x, 0); expect(moved[side].y).toBeCloseTo(box.y + box.height / 2, 0); }
      }
      await unchanged(before, beforeHistory, count); const saved = page.waitForResponse(reply => reply.url().endsWith('/api/mapping/execute') && reply.request().postDataJSON()?.type?.startsWith('connector.'));
      await page.keyboard.press('Enter'); const response = await saved, receipt = await response.json() as Receipt; expect(response.status()).toBe(200);
      await expect(page.getByRole('status')).toHaveText('已保存到本机'); await expect(preview).toHaveCount(0); await expect(line(id)).toBeFocused(); await expect(line(id)).toHaveAttribute('aria-pressed', 'true');
      const after = await workspace.state(), afterHistory = await history(), changed = after.connectors!.find(value => value.id === id)!;
      expect(attempts).toHaveLength(count + 1); const request = attempts[count]!, command = request.command; expect(request.status).toBe(200); expect(request.receipt).toEqual(receipt);
      expect(command.type).toBe('connector.move'); if (command.type !== 'connector.move') throw new Error('键盘整线移动必须只发送真实connector.move');
      expect(command).toMatchObject({ projectId, expected: original.versionId, payload: { id, dx: 20, dy: 10 } });
      expect(command.commandId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
      expect(changed).toEqual({ ...original, start: shifted(original.start), end: shifted(original.end), versionId: receipt.connectorVersions![id] }); expect(changed.versionId).not.toBe(original.versionId);
      expect(receipt.commandId).toBe(command.commandId); expect(receipt.projectId).toBe(projectId); expect(receipt.changedIds).toEqual([id]);
      expect(after.connectors).toEqual(before.connectors!.map(value => value.id === id ? changed : value));
      for (const key of ['cards', 'tags', 'texts', 'shapes', 'images', 'strokes'] as const) expect(after[key]).toEqual(before[key]);
      expect(after.project).toEqual({ ...before.project, revision: before.project.revision + 1 }); expect(afterHistory.revision).toBe(beforeHistory.revision + 1);
      expect(afterHistory.undo.slice(0, -1)).toEqual(beforeHistory.undo); expect(afterHistory.undo).toHaveLength(beforeHistory.undo.length + 1);
      expect(afterHistory.undo.at(-1)).toMatchObject({ id: command.commandId, label: 'connector.move', target: { id } }); expect(afterHistory.redo).toEqual(beforeHistory.redo);
      expect(await connectorSvgEnds(line(id).locator('path'))).toEqual(moved);
      console.log('issue26-keyboard-move-saved', JSON.stringify({ variant, command, receipt, before, beforeHistory, after, afterHistory, initial, moved,
        boundary: 'real keyboard Arrow delta20/10; free endpoints only; captured expected/newUUID/version; same line/path/bound fixed sides/other lines/hosts/content; one200/history+1 and line focus' }));
    }
    const beforeLocked = await workspace.state(), lockedHistory = await history(), lockedId = fixtureCommands[3]!.payload.id; await select(lockedId); await expect(move).toBeDisabled();
    await page.keyboard.press('ArrowRight'); await page.keyboard.press('Enter'); await frame(); expect(await preview.count()).toBe(0); await unchanged(beforeLocked, lockedHistory, 3);
    expect(attempts).toHaveLength(3); expect(new Set(attempts.map(value => value.command.commandId)).size).toBe(3);
    console.log('issue26-keyboard-move-complete', JSON.stringify({ attempts, lockedId, lockedState: await workspace.state(), lockedHistory: await history(),
      variants: ['both-free', 'bound-start-free-end', 'free-start-bound-end'], boundary: 'both-bound entry disabled; real keys cannot detach or write; one complete whole-line movement behavior' }));
  } finally { await page.unrouteAll({ behavior: 'wait' }); }
});

test('键盘未移动自由端直接确认不创建零长度连线', async ({ page, workspace }) => {
  const before = await workspace.state(), projectId = before.project.id;
  const historyUrl = workspace.origin + '/api/mapping/projects/' + encodeURIComponent(projectId) + '/history';
  const history = async () => { const response = await page.request.get(historyUrl); expect(response.status()).toBe(200); return await response.json() as ProjectHistory; };
  const beforeHistory = await history(), commands: Command[] = [];
  const tool = page.getByRole('button', { name: '连线', exact: true }), blank = page.getByRole('button', { name: '从空白处开始连线', exact: true });
  const free = page.getByRole('button', { name: '连线自由终点', exact: true }), preview = page.getByRole('img', { name: '连线预览', exact: true });
  const frame = async () => await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  const record = (request: import('@playwright/test').Request) => {
    if (request.url().endsWith('/api/mapping/execute') && request.method() === 'POST' && request.postDataJSON()?.type === 'connector.create') commands.push(request.postDataJSON());
  };
  async function tabTo(target: Locator) {
    await expect(target).toBeVisible();
    for (let step = 0; step < 100; step++) {
      if (await target.evaluate(element => element === document.activeElement)) return;
      await page.keyboard.press(await target.evaluate(element =>
        element.compareDocumentPosition(document.activeElement ?? document.body) & Node.DOCUMENT_POSITION_PRECEDING ? 'Tab' : 'Shift+Tab'));
    }
    throw new Error('正常 Tab 顺序无法到达连线创建控件');
  }
  page.on('request', record);
  try {
    await tabTo(tool); await page.keyboard.press('Enter'); await expect(tool).toHaveAttribute('aria-pressed', 'true');
    await tabTo(blank); await page.keyboard.press('Enter'); await expect(preview).toBeVisible(); await expect(free).toBeFocused();
    await page.keyboard.press('Enter'); await frame();
    expect(commands, '未移动自由端就确认不应提交普通连线').toHaveLength(0);
    await expect(preview).toHaveCount(0); await expect(blank).toBeFocused();
    expect(await workspace.state()).toEqual(before); expect(await history()).toEqual(beforeHistory);
    await expect(tool).toHaveAttribute('aria-pressed', 'true');
    await page.keyboard.press('Enter'); await expect(preview).toBeVisible(); await expect(free).toBeFocused();
    for (const key of ['ArrowRight', 'ArrowDown']) await page.keyboard.press(key); await frame();
    const saved = page.waitForResponse(response => response.url().endsWith('/api/mapping/execute') && response.request().postDataJSON()?.type === 'connector.create');
    await page.keyboard.press('Enter'); expect((await saved).status()).toBe(200);
    await expect(page.getByRole('status')).toHaveText('已保存到本机'); expect(commands).toHaveLength(1);
    expect((await workspace.state()).connectors).toHaveLength(1);
    console.log('issue26-keyboard-no-move', JSON.stringify({ commands, connectors: (await workspace.state()).connectors }));
  } finally { page.off('request', record); }
});
