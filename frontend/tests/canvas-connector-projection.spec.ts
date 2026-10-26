import { test, expect, type Workspace } from './writing-board-fixture';
import type { Page } from '@playwright/test';
import { readCompactMap, syncCompactMap, type WorkspaceProjection } from '../src/compact-map';
import type { CompactPage, DetailChunk } from '../../backend/src/mapping/compact-contracts';

function gate() {
  let release!: () => void;
  const wait = new Promise<void>(resolve => { release = resolve; });
  return { wait, release };
}
type MapRecord = { query: URLSearchParams; body: CompactPage };
type Failure = { status: number; body: { code: string; details: { requiredBytes?: number; recovery: { type: string; view: string; projectId: string; snapshot?: string } } } };
function reader(page: Page, workspace: Workspace, records: MapRecord[], hold: (record: MapRecord) => Promise<void>, onError?: (failure: Failure) => void) {
  return async <T,>(path: string): Promise<T> => {
    const response = await page.request.get(workspace.origin + '/api/mapping' + path);
    const body = await response.json();
    if (!response.ok()) { onError?.({ status: response.status(), body }); throw Object.assign(new Error(body.message), body); }
    expect(Buffer.byteLength(JSON.stringify(body), 'utf8')).toBe(body.bytes);
    expect(body.bytes).toBeLessThanOrEqual(131072);
    const record = { query: new URL(response.url()).searchParams, body };
    records.push(record); await hold(record);
    return body as T;
  };
}

 test('完整连线投影冷开收齐同快照详情后才发布且保留固定端点', async ({ page, workspace }) => {
  const projectId = (await workspace.state()).project.id;
  const execute = (type: string, payload: unknown, expected: unknown = null) => workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type, expected, payload });
  await execute('thought.create', { id: 'protected-card', title: '连线保护卡', text: '完整正文与原身份保留', x: 650, y: 130 });
  await execute('text.create', { id: 'protected-text', content: { runs: [{ text: '连线保护文字' }], fontSize: 18, lineHeight: 1.5, align: 'left', widthMode: 'fixed', width: 190 }, pose: { x: 650, y: 420, width: 190, height: 27 } });
  await execute('shape.create', { id: 'protected-shape', content: { shapeType: 'diamond', shortText: '连线保护形状' }, pose: { x: 280, y: 180, width: 180, height: 100 } });
  await page.reload();
  await expect(page.getByRole('button', { name: '连线保护卡', exact: true })).toBeVisible();
  await expect(page.locator('.canvas-text-content')).toHaveText('连线保护文字');
  await expect(page.getByRole('status')).toHaveText('已保存到本机');
  await expect.poll(async () => await page.locator('.workspace').getAttribute('data-revision') === String((await workspace.state()).project.revision)).toBe(true);
  const hosts = await workspace.state();
  const card = hosts.cards[0]!, shape = hosts.shapes![0]!;
  await execute('connector.create', { id: 'line-bound', start: { kind: 'bound', itemId: card.item.id, side: 'right' }, end: { kind: 'bound', itemId: shape.item.id, side: 'left' } });
  await execute('connector.create', { id: 'line-tail', start: { kind: 'free', point: { x: -80, y: 60 } }, end: { kind: 'free', point: { x: 180, y: -40 } } });
  const pinned = await workspace.state();
  const moduleGate = gate(), servedGate = gate(), nextPoll = gate();
  const moduleRecords: MapRecord[] = [], servedRecords: MapRecord[] = [];
  let moduleHeld: MapRecord | undefined, moduleProjection: WorkspaceProjection | undefined, moduleError: unknown, settled = false;
  let servedHeld: MapRecord | undefined, servedRoot: CompactPage | undefined;
  const request = reader(page, workspace, moduleRecords, async record => {
    if (record.query.get('view') === 'connector-detail' && record.query.get('connectorId') === 'line-tail') { moduleHeld = record; await moduleGate.wait; }
  });
  const pending = readCompactMap(projectId, request).then(value => { moduleProjection = value; settled = true; }, error => { moduleError = error; settled = true; });
  try {
    await expect.poll(() => Boolean(moduleHeld) || settled).toBe(true);
    const root = moduleRecords.find(record => record.query.get('view') === 'index')!.body;
    console.log('issue26-module-cold', JSON.stringify({ snapshot: root.snapshot, revision: root.revision, views: moduleRecords.map(record => record.query.get('view')), settled, heldConnector: moduleHeld?.query.get('connectorId') ?? null, returnedConnectorCount: moduleProjection?.connectors?.length ?? null }));
    expect(moduleError).toBeUndefined();
    expect(moduleHeld, '完整模块投影必须请求最后一条connector-detail，不能先返回缺线对象').toBeDefined();
    expect(settled).toBe(false);
    expect(moduleHeld!.body.snapshot).toBe(root.snapshot); expect(moduleHeld!.body.revision).toBe(root.revision);
    const line = pinned.connectors!.find(value => value.id === 'line-bound')!;
    await execute('connector.reconnect', { id: line.id, endpoint: 'end', value: { kind: 'free', point: { x: 420, y: 80 } } }, line.versionId);
    moduleGate.release(); await pending;
    expect(moduleError).toBeUndefined(); expect(moduleProjection).toEqual({ ...pinned, snapshot: root.snapshot });
    for (const record of moduleRecords) { expect(record.body.snapshot).toBe(root.snapshot); expect(record.body.revision).toBe(root.revision); }
    for (const view of ['index', 'tags', 'text-index', 'shape-index', 'stroke-index', 'image-index', 'connector-index']) expect(moduleRecords.some(record => record.query.get('view') === view)).toBe(true);
    const servedExpected = await workspace.state();
    await page.route(/\/api\/mapping\/projects\/[^/]+\/map\?/, async route => {
      const response = await route.fetch(), body = await response.json();
      const record = { query: new URL(route.request().url()).searchParams, body };
      servedRecords.push(record);
      if (record.query.get('view') === 'index') servedRoot = body;
      if (record.query.get('view') === 'connector-detail' && record.query.get('connectorId') === 'line-tail') { servedHeld = record; await servedGate.wait; }
      await route.fulfill({ response });
    });
    await page.reload();
    await expect.poll(async () => Boolean(servedHeld) || Boolean(servedRoot && (await page.locator('.workspace').evaluateAll(elements => elements.map(element => element.getAttribute('data-snapshot')))).includes(servedRoot.snapshot))).toBe(true);
    expect(servedHeld, '真实served工作台不能在最后连线详情完成前发布根快照').toBeDefined();
    expect(servedHeld!.body.snapshot).toBe(servedRoot!.snapshot); expect(servedHeld!.body.revision).toBe(servedRoot!.revision);
    expect(servedRoot!.revision).toBe(servedExpected.project.revision);
    await page.route(/\/api\/mapping\/projects\/[^/]+\/changes\?/, async route => { await nextPoll.wait; await route.continue(); });
    const latest = servedExpected.connectors!.find(value => value.id === line.id)!;
    await execute('connector.reconnect', { id: line.id, endpoint: 'end', value: { kind: 'free', point: { x: 700, y: -120 } } }, latest.versionId);
    const waitingMarkers = await page.locator('.workspace').evaluateAll(elements => elements.map(element => element.getAttribute('data-snapshot')));
    expect(waitingMarkers).not.toContain(servedRoot!.snapshot);
    await expect(page.locator('.react-flow__node-thought')).toHaveCount(0);
    await expect(page.locator('.canvas-text-content')).toHaveCount(0);
    const heldLine = JSON.parse((servedHeld!.body.items as DetailChunk[]).map(chunk => chunk.jsonText).join(''));
    expect(heldLine).toEqual(servedExpected.connectors!.find(value => value.id === 'line-tail'));
    console.log('issue26-served-cold', JSON.stringify({ snapshot: servedRoot!.snapshot, revision: servedRoot!.revision, waitingMarkers, heldConnector: heldLine.id, evidence: 'actual route.fetch body delayed; no response fabrication' }));
    servedGate.release();
    await expect(page.locator('.workspace')).toHaveAttribute('data-snapshot', servedRoot!.snapshot);
    await expect(page.locator('.workspace')).toHaveAttribute('data-revision', String(servedRoot!.revision));
    await expect(page.getByRole('button', { name: '连线保护卡', exact: true })).toBeVisible();
    await expect(page.locator('.canvas-text-content')).toHaveText('连线保护文字');
    for (const record of servedRecords) { expect(record.body.snapshot).toBe(servedRoot!.snapshot); expect(record.body.revision).toBe(servedRoot!.revision); expect(Buffer.byteLength(JSON.stringify(record.body), 'utf8')).toBe(record.body.bytes); }
    const current = await workspace.state();
    for (const key of ['cards', 'texts', 'shapes', 'images', 'strokes', 'tags'] as const) expect(current[key]).toEqual(pinned[key]);
    expect(current.connectors!.find(value => value.id === line.id)!.end).toEqual({ kind: 'free', point: { x: 700, y: -120 } });
  } finally {
    moduleGate.release(); servedGate.release(); nextPoll.release(); await pending;
    await page.unrouteAll({ behavior: 'wait' });
  }
});


type Execute = (type: string, payload: unknown, expected?: unknown) => Promise<any>;
async function syncCycle(page: Page, workspace: Workspace, advance: (execute: Execute, previous: WorkspaceProjection) => Promise<void>, holdBudgetLayout = false) {
  const projectId = (await workspace.state()).project.id;
  const execute: Execute = (type, payload, expected = null) => workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type, expected, payload });
  await execute('thought.create', { id: 'cycle-card', title: '同步保护卡', text: '固定正文保持', x: 650, y: 130 });
  await execute('text.create', { id: 'cycle-text', content: { runs: [{ text: '同步保护文字' }], fontSize: 18, lineHeight: 1.5, align: 'left', widthMode: 'fixed', width: 190 }, pose: { x: 650, y: 420, width: 190, height: 27 } });
  await execute('shape.create', { id: 'cycle-shape', content: { shapeType: 'diamond', shortText: '同步保护形状' }, pose: { x: 280, y: 180, width: 180, height: 100 } });
  await page.reload();
  await expect.poll(async () => await page.locator('.workspace').getAttribute('data-revision') === String((await workspace.state()).project.revision)).toBe(true);
  const hosts = await workspace.state();
  await execute('connector.create', { id: 'cycle-line', start: { kind: 'bound', itemId: hosts.cards[0]!.item.id, side: 'right' }, end: { kind: 'free', point: { x: 100, y: 80 } } });
  await execute('connector.create', { id: 'cycle-tail', start: { kind: 'free', point: { x: -30, y: 40 } }, end: { kind: 'free', point: { x: 200, y: 10 } } });
  await expect.poll(async () => await page.locator('.workspace').getAttribute('data-revision') === String((await workspace.state()).project.revision)).toBe(true);
  const firstPoll = gate(), laterPoll = gate(), moduleGate = gate(), servedGate = gate(), laterMap = gate(), layoutGate = gate();
  let entered = false, servedChange: MapRecord | undefined, servedRoot: CompactPage | undefined, servedHeld: MapRecord | undefined;
  const moduleRecords: MapRecord[] = [], servedRecords: MapRecord[] = [], laterReads: MapRecord[] = [];
  const layoutRequests: unknown[] = [];
  let moduleHeld: MapRecord | undefined, moduleProjection: WorkspaceProjection | undefined, moduleError: unknown, settled = false;
  let pending = Promise.resolve(), moduleFailure: Failure | undefined, servedFailure: Failure | undefined;
  await page.route(/\/api\/mapping\/projects\/[^/]+\/changes\?/, async route => {
    if (entered) await laterPoll.wait;
    else { entered = true; await firstPoll.wait; }
    const response = await route.fetch(), body = await response.json();
    servedChange ??= { query: new URL(route.request().url()).searchParams, body };
    if (!response.ok()) servedFailure ??= { status: response.status(), body };
    await route.fulfill({ response });
  });
  try {
    await expect.poll(() => entered).toBe(true);
    const oldMarker = await page.locator('.workspace').getAttribute('data-snapshot');
    const previous = await readCompactMap(projectId, reader(page, workspace, [], async () => {}));
    await advance(execute, previous);
    const pinned = await workspace.state();
    pending = syncCompactMap(previous, reader(page, workspace, moduleRecords, async record => {
      if (record.query.get('view') === 'connector-detail' && record.query.get('connectorId') === 'cycle-tail') { moduleHeld = record; await moduleGate.wait; }
    }, failure => { moduleFailure = failure; })).then(value => { moduleProjection = value; settled = true; }, error => { moduleError = error; settled = true; });
    await expect.poll(() => Boolean(moduleHeld) || settled).toBe(true);
    expect(moduleError).toBeUndefined(); expect(moduleHeld, '同步模块必须收齐连线详情').toBeDefined(); expect(settled).toBe(false);
    const moduleRoot = moduleRecords.find(record => record.query.get('view') === 'index')!.body;
    const line = pinned.connectors!.find(value => value.id === 'cycle-line')!;
    await execute('connector.reconnect', { id: line.id, endpoint: 'end', value: { kind: 'free', point: { x: 777, y: 333 } } }, line.versionId);
    moduleGate.release(); await pending;
    expect(moduleError).toBeUndefined(); expect(moduleProjection).toEqual({ ...pinned, snapshot: moduleRoot.snapshot });
    for (const record of moduleRecords.filter(record => record.query.has('view'))) { expect(record.body.snapshot).toBe(moduleRoot.snapshot); expect(record.body.revision).toBe(moduleRoot.revision); }
    const servedExpected = await workspace.state();
    if (holdBudgetLayout) await page.route('**/api/mapping/execute', async route => {
      const command = route.request().postDataJSON();
      if (command.type === 'card.layout' && command.payload.id === 'large-budget-card') { layoutRequests.push(command); await layoutGate.wait; }
      await route.continue();
    });
    await page.route(/\/api\/mapping\/projects\/[^/]+\/map\?/, async route => {
      const response = await route.fetch(), body = await response.json();
      const record = { query: new URL(route.request().url()).searchParams, body };
      expect(response.ok()).toBe(true); expect(Buffer.byteLength(JSON.stringify(body), 'utf8')).toBe(body.bytes); expect(body.bytes).toBeLessThanOrEqual(131072);
      const isRoot = record.query.get('view') === 'index' && !record.query.has('cursor');
      if (isRoot && servedRoot) { laterReads.push(record); await laterMap.wait; await route.fulfill({ response }); return; }
      if (isRoot) servedRoot = Object.freeze(body);
      else expect(record.query.get('snapshot')).toBe(servedRoot!.snapshot);
      expect(body.snapshot).toBe(servedRoot!.snapshot); expect(body.revision).toBe(servedRoot!.revision); servedRecords.push(record);
      if (record.query.get('view') === 'connector-detail' && record.query.get('connectorId') === 'cycle-tail') { servedHeld = record; await servedGate.wait; }
      await route.fulfill({ response });
    });
    firstPoll.release();
    await expect.poll(async () => Boolean(servedHeld) || Boolean(servedRoot && await page.locator('.workspace').getAttribute('data-snapshot') === servedRoot.snapshot)).toBe(true);
    expect(servedHeld, '真实served同步必须等完整连线投影').toBeDefined();
    const recoveryRoot = servedRoot!;
    expect(recoveryRoot.revision).toBe(servedExpected.project.revision);
    if (servedFailure?.body.details.recovery.snapshot) expect(recoveryRoot.snapshot).toBe(servedFailure.body.details.recovery.snapshot);
    await expect(page.locator('.workspace')).toHaveAttribute('data-snapshot', oldMarker!);
    await expect(page.locator('.workspace')).toHaveAttribute('data-revision', String(previous.project.revision));
    await expect(page.getByRole('button', { name: '同步保护卡', exact: true })).toBeVisible();
    const current = servedExpected.connectors!.find(value => value.id === line.id)!;
    await execute('connector.reconnect', { id: line.id, endpoint: 'end', value: { kind: 'free', point: { x: 888, y: 444 } } }, current.versionId);
    expect(JSON.parse((servedHeld!.body.items as DetailChunk[]).map(chunk => chunk.jsonText).join(''))).toEqual(servedExpected.connectors!.find(value => value.id === 'cycle-tail'));
    console.log('issue26-sync-cycle', JSON.stringify({ oldMarker, previousRevision: previous.project.revision, moduleSnapshot: moduleRoot.snapshot, moduleRevision: moduleRoot.revision, servedSnapshot: servedRoot!.snapshot, servedRevision: servedRoot!.revision, heldConnector: 'cycle-tail', moduleChanges: moduleRecords.filter(record => !record.query.has('view')).map(record => record.body), servedChange: servedChange!.body, evidence: 'actual HTTP bodies delayed; full module equality distinct from served markers' }));
    servedGate.release();
    await expect(page.locator('.workspace')).toHaveAttribute('data-snapshot', recoveryRoot.snapshot);
    await expect(page.locator('.workspace')).toHaveAttribute('data-revision', String(recoveryRoot.revision));
    await expect(page.locator('.canvas-text-content')).toHaveText('同步保护文字');
    for (const record of servedRecords) { expect(record.body.snapshot).toBe(recoveryRoot.snapshot); expect(record.body.revision).toBe(recoveryRoot.revision); expect(Buffer.byteLength(JSON.stringify(record.body), 'utf8')).toBe(record.body.bytes); }
    for (const view of ['index', 'tags', 'text-index', 'shape-index', 'stroke-index', 'image-index', 'connector-index']) expect(servedRecords.some(record => record.query.get('view') === view)).toBe(true);
    for (const connector of servedExpected.connectors!) {
      const chunks = servedRecords.filter(record => record.query.get('view') === 'connector-detail' && record.query.get('connectorId') === connector.id).flatMap(record => record.body.items as DetailChunk[]);
      expect(chunks.every((chunk, i) => chunk.id === connector.id && chunk.chunkIndex === i && chunk.chunkCount === chunks.length)).toBe(true);
      expect(JSON.parse(chunks.map(chunk => chunk.jsonText).join(''))).toEqual(connector);
    }
    console.log('issue26-cycle-boundary', JSON.stringify({ recoveryRoot: { snapshot: recoveryRoot.snapshot, revision: recoveryRoot.revision }, views: servedRecords.map(record => record.query.get('view')), laterReads: laterReads.map(record => ({ snapshot: record.body.snapshot, revision: record.body.revision, bytes: record.body.bytes })), layoutRequests }));
    for (const key of ['cards', 'texts', 'shapes', 'images', 'strokes', 'tags'] as const) expect((await workspace.state())[key]).toEqual(servedExpected[key]);
    return { moduleRecords, servedChange: servedChange!.body, moduleFailure, servedFailure, moduleRoot, servedRoot: recoveryRoot };
  } finally { moduleGate.release(); servedGate.release(); firstPoll.release(); layoutGate.release(); laterMap.release(); laterPoll.release(); await pending; await page.unrouteAll({ behavior: 'wait' }); }
}

test('完整连线投影同步保旧图直到固定终点详情全部完成', async ({ page, workspace }) => {
  const result = await syncCycle(page, workspace, async (execute, previous) => {
    const line = previous.connectors!.find(value => value.id === 'cycle-line')!;
    await execute('connector.reconnect', { id: line.id, endpoint: 'end', value: { kind: 'free', point: { x: 250, y: 120 } } }, line.versionId);
  });
  expect(result.servedChange).toMatchObject({ status: 'OK', complete: true });
});


test('真实预算错误恢复完整连线投影并等待第七视图一次发布', async ({ page, workspace }) => {
  const result = await syncCycle(page, workspace, async execute => {
    await execute('thought.create', { id: 'large-budget-card', title: '真实预算恢复卡', text: '实'.repeat(70000), x: 1200, y: 130 });
  }, true);
  for (const failure of [result.moduleFailure, result.servedFailure]) {
    expect(failure).toMatchObject({ status: 413, body: { code: 'ITEM_EXCEEDS_BUDGET', details: { recovery: { type: 'map', view: 'index' } } } });
    expect(failure!.body.details.requiredBytes).toBeGreaterThan(131072);
  }
  expect(result.moduleFailure!.body.details.recovery.snapshot).toBe(result.moduleRoot.snapshot);
  expect(result.servedFailure!.body.details.recovery.snapshot).toBe(result.servedRoot.snapshot);
  console.log('issue26-real-budget', JSON.stringify({ module: result.moduleFailure, served: result.servedFailure, payloadUtf8Bytes: Buffer.byteLength('实'.repeat(70000), 'utf8'), source: 'real public thought.create and production observe budget; no fabricated error' }));
});

test('真实变更窗口RESET恢复完整连线投影并等待第七视图一次发布', async ({ page, workspace }) => {
  test.setTimeout(120000);
  const result = await syncCycle(page, workspace, async (execute, previous) => {
    const line = previous.connectors!.find(value => value.id === 'cycle-line')!;
    let version = line.versionId;
    for (let i = 0; i < 1001; i++) {
      const receipt = await execute('connector.path', { id: line.id, path: i % 2 ? 'curve' : 'elbow' }, version);
      expect(receipt.revision).toBe(previous.project.revision + i + 1); expect(receipt.changedIds).toEqual([line.id]);
      expect(receipt.connectorVersions[line.id]).not.toBe(version); version = receipt.connectorVersions[line.id];
    }
    console.log('issue26-real-window', JSON.stringify({ successfulChanges: 1001, fromRevision: previous.project.revision, finalRevision: previous.project.revision + 1001, finalVersion: version, source: 'public HTTP execute; default1000 window unchanged' }));
  });
  const moduleChanges = result.moduleRecords.filter(record => !record.query.has('view'));
  expect(moduleChanges).toHaveLength(1);
  expect(moduleChanges[0]!.body).toMatchObject({ status: 'RESET_REQUIRED', reason: 'CURSOR_TOO_OLD', complete: true, changes: [], recovery: { type: 'map', view: 'index', snapshot: result.moduleRoot.snapshot } });
  expect(result.servedChange).toMatchObject({ status: 'RESET_REQUIRED', reason: 'CURSOR_TOO_OLD', complete: true, changes: [], recovery: { type: 'map', view: 'index', snapshot: result.servedRoot.snapshot } });
  expect(result.moduleFailure).toBeUndefined(); expect(result.servedFailure).toBeUndefined();
});

test('服务重开使旧快照过期后完整连线投影恢复再一次发布', async ({ page, workspace }) => {
  let oldModule = '', oldServed = '';
  const result = await syncCycle(page, workspace, async (_execute, previous) => {
    oldModule = previous.snapshot; oldServed = (await page.locator('.workspace').getAttribute('data-snapshot'))!;
    await workspace.restart();
  });
  for (const failure of [result.moduleFailure, result.servedFailure]) {
    expect(failure).toMatchObject({ status: 409, body: { code: 'SNAPSHOT_EXPIRED', details: { recovery: { type: 'map', view: 'index' } } } });
    expect(failure!.body.details.recovery.snapshot).toBeUndefined();
  }
  expect(result.moduleRoot.snapshot).not.toBe(oldModule); expect(result.servedRoot.snapshot).not.toBe(oldServed);
  console.log('issue26-real-expiry', JSON.stringify({ oldModule, oldServed, module: result.moduleFailure, served: result.servedFailure, recoveredModule: result.moduleRoot.snapshot, recoveredServed: result.servedRoot.snapshot, source: 'actual same-directory workspace.restart; memory snapshots expire naturally' }));
});

test('刷新和同库服务重开保持普通连线身份与受保护对象', async ({ page, workspace }) => {
  const projectId = (await workspace.state()).project.id;
  const execute: Execute = (type, payload, expected = null) => workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type, expected, payload });
  await execute('thought.create', { id: 'reopen-card', title: '重开保护卡', text: '原身份正文🧠', x: 650, y: 130 });
  await execute('text.create', { id: 'reopen-text', content: { runs: [{ text: '重开保护文字' }], fontSize: 18, lineHeight: 1.5, align: 'left', widthMode: 'fixed', width: 190 }, pose: { x: 650, y: 420, width: 190, height: 27 } });
  await execute('shape.create', { id: 'reopen-shape', content: { shapeType: 'diamond', shortText: '重开保护形状' }, pose: { x: 280, y: 180, width: 180, height: 100 } });
  await page.reload();
  await expect.poll(async () => await page.locator('.workspace').getAttribute('data-revision') === String((await workspace.state()).project.revision)).toBe(true);
  const hosts = await workspace.state();
  await execute('connector.create', { id: 'reopen-bound', start: { kind: 'bound', itemId: hosts.cards[0]!.item.id, side: 'bottom' }, end: { kind: 'bound', itemId: hosts.shapes![0]!.item.id, side: 'top' }, path: 'elbow' });
  await execute('connector.create', { id: 'reopen-free', start: { kind: 'free', point: { x: -55, y: 91 } }, end: { kind: 'free', point: { x: 144, y: -33 } }, path: 'curve' });
  await expect.poll(async () => await page.locator('.workspace').getAttribute('data-revision') === String((await workspace.state()).project.revision)).toBe(true);
  const original = await workspace.state(), reads: { phase: string; snapshot: string; revision: number; views: (string | null)[] }[] = [];
  async function assertComplete(phase: string) {
    await expect(page.locator('.workspace')).toHaveAttribute('data-revision', String(original.project.revision));
    const marker = (await page.locator('.workspace').getAttribute('data-snapshot'))!;
    const records: MapRecord[] = [];
    const complete = await readCompactMap(projectId, reader(page, workspace, records, async () => {}));
    expect(complete).toEqual({ ...original, snapshot: complete.snapshot });
    const servedPinned = await readCompactMap(projectId, reader(page, workspace, [], async () => {}), marker);
    expect(servedPinned).toEqual({ ...original, snapshot: marker });
    for (const view of ['index', 'tags', 'text-index', 'shape-index', 'stroke-index', 'image-index', 'connector-index']) expect(records.some(record => record.query.get('view') === view)).toBe(true);
    await expect(page.getByRole('button', { name: '重开保护卡', exact: true })).toBeVisible();
    await expect(page.locator('.canvas-text-content')).toHaveText('重开保护文字');
    await expect(page.getByRole('img', { name: '重开保护形状', exact: true })).toBeVisible();
    expect(await workspace.state()).toEqual(original);
    reads.push({ phase, snapshot: marker, revision: original.project.revision, views: records.map(record => record.query.get('view')) });
  }
  await assertComplete('before-refresh');
  await page.reload(); await expect(page.getByRole('status')).toHaveText('已保存到本机'); await assertComplete('after-refresh');
  await workspace.restart(); await workspace.open(page); await assertComplete('after-same-directory-restart');
  console.log('issue26-reopen-identity', JSON.stringify({ connectors: original.connectors, reads, evidence: 'whole module object + real HTTP pinned to served snapshot + actual page markers; no line DOM claim' }));
});
