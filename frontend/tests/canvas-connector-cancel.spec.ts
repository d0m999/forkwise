import { test, expect } from './writing-board-fixture';
import type { Locator } from '@playwright/test';
import type { Command, ProjectHistory, Receipt } from '../../backend/src/mapping/contracts';
import type { ProjectState } from '../src/api';
import { connectorDraftCancellation, connectorSvgEnds, connectorWorldPoint, seedConnectorCard } from './connector-ui-fixture';

test('Esc取消连线草稿后晚到松手不写入', async ({ page, workspace }) => {
  await connectorDraftCancellation(page, workspace, () => page.keyboard.press('Escape'));
});

test('pointercancel取消连线草稿后晚到松手不写入', async ({ page, workspace }) => {
  await connectorDraftCancellation(page, workspace, async pointerId => {
    await page.locator('main.canvas').evaluate((element, id) => {
      if (!element.hasPointerCapture(id)) throw new Error('真实连线手势应持有实际pointerId的捕获');
      element.dispatchEvent(new PointerEvent('pointercancel', { pointerId: id, pointerType: 'mouse', bubbles: true }));
    }, pointerId);
  });
});

test('丢失指针捕获只取消未提交的连线草稿', async ({ page, workspace }) => {
  await connectorDraftCancellation(page, workspace, async pointerId => {
    await page.locator('main.canvas').evaluate((element, id) => {
      if (!element.hasPointerCapture(id)) throw new Error('释放前必须有真实指针捕获');
      element.addEventListener('lostpointercapture', event => {
        (element as HTMLElement).dataset.issue26Lost = JSON.stringify({ pointerId: event.pointerId, trusted: event.isTrusted });
      }, { once: true });
      element.releasePointerCapture(id);
    }, pointerId);
    await page.mouse.move(660, 560);
    const lost = await page.locator('main.canvas').getAttribute('data-issue26-lost');
    expect(lost).not.toBeNull(); expect(JSON.parse(lost!)).toEqual({ pointerId, trusted: true });
    await page.locator('main.canvas').evaluate(element => { delete (element as HTMLElement).dataset.issue26Lost; });
  });
});

test('窗口失焦取消尚未提交的连线草稿', async ({ page, workspace }) => {
  await connectorDraftCancellation(page, workspace, async () => {
    await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  });
});

test('页面隐藏取消尚未提交的连线草稿', async ({ page, workspace }) => {
  await connectorDraftCancellation(page, workspace, async () => {
    const observation = await page.evaluate(() => {
      const prior = Object.getOwnPropertyDescriptor(document, 'visibilityState'), before = document.visibilityState;
      try {
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
        const during = document.visibilityState; document.dispatchEvent(new Event('visibilitychange'));
        return { before, during, injected: true };
      } finally {
        if (prior) Object.defineProperty(document, 'visibilityState', prior); else Reflect.deleteProperty(document, 'visibilityState');
      }
    });
    expect(observation.during).toBe('hidden');
    expect(await page.evaluate(() => document.visibilityState)).toBe(observation.before);
    console.log('issue26-visibility-event-injection', JSON.stringify(observation));
  });
});


test('切换工具取消未提交连线编辑后可明确新建', async ({ page, workspace }) => {
  const a = await seedConnectorCard(page, workspace, 'switch-edit-a', 130, 150), b = await seedConnectorCard(page, workspace, 'switch-edit-b', 700, 400);
  const projectId = (await workspace.state()).project.id, id = crypto.randomUUID(), unrelatedId = crypto.randomUUID();
  const fixtureCommands: Extract<Command, { type: 'connector.create' }>[] = [
    { commandId: crypto.randomUUID(), projectId, type: 'connector.create', expected: null, payload: { id, path: 'curve',
      start: { kind: 'bound', itemId: a.item.id, side: 'right' }, end: { kind: 'free', point: { x: 620, y: 330 } } } },
    { commandId: crypto.randomUUID(), projectId, type: 'connector.create', expected: null, payload: { id: unrelatedId, path: 'straight',
      start: { kind: 'free', point: { x: 70, y: 80 } }, end: { kind: 'bound', itemId: b.item.id, side: 'left' } } },
  ];
  for (const command of fixtureCommands) await workspace.execute(page, command);
  await page.reload(); await expect(page.getByRole('status')).toHaveText('已保存到本机');
  const baseline = await workspace.state(), historyUrl = workspace.origin + '/api/mapping/projects/' + encodeURIComponent(projectId) + '/history';
  const history = async () => { const response = await page.request.get(historyUrl); expect(response.status()).toBe(200); return await response.json() as ProjectHistory; };
  const baselineHistory = await history(), attempts: { command: Command; status: number; receipt: Receipt }[] = [];
  const line = page.getByRole('button', { name: '普通连线', exact: true }).nth(baseline.connectors!.findIndex(value => value.id === id));
  const tool = page.getByRole('button', { name: '连线', exact: true }), select = page.getByRole('button', { name: '选择', exact: true });
  const preview = page.getByRole('img', { name: '连线预览', exact: true }), free = page.getByRole('button', { name: '连线自由终点', exact: true });
  const blank = page.getByRole('button', { name: '从空白处开始连线', exact: true }), move = page.getByRole('button', { name: '移动连线', exact: true });
  const moveInstructions = page.getByText('方向键移动连线，Enter 确认，Escape 取消', { exact: true });
  const frame = async () => await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  async function tabTo(target: Locator) {
    await expect(target).toBeVisible();
    for (let step = 0; step < 100; step++) {
      if (await target.evaluate(element => element === document.activeElement)) return;
      await page.keyboard.press(await target.evaluate(element =>
        element.compareDocumentPosition(document.activeElement ?? document.body) & Node.DOCUMENT_POSITION_PRECEDING ? 'Tab' : 'Shift+Tab'));
    }
    throw new Error('正常 Tab 顺序无法到达连线编辑与工具切换控件');
  }
  async function unchanged(before: ProjectState, beforeHistory: ProjectHistory, count: number) {
    expect(attempts).toHaveLength(count); expect(await workspace.state()).toEqual(before); expect(await history()).toEqual(beforeHistory);
  }
  async function selectOriginal() { await tabTo(line); await page.keyboard.press('Enter'); await expect(line).toHaveAttribute('aria-pressed', 'true'); await expect(line).toBeFocused(); }
  async function chooseTool(target: Locator) { await tabTo(target); await page.keyboard.press('Enter'); await expect(target).toHaveAttribute('aria-pressed', 'true'); await frame(); }
  async function cancelled(phase: string, before: ProjectState, beforeHistory: ProjectHistory, count: number) {
    const state = await workspace.state(), savedHistory = await history();
    const controls = { previews: await preview.count(), endpointFree: await free.count(), wholeInstructions: await moveInstructions.count() };
    console.log('issue26-tool-switch-edit-cancel', JSON.stringify({ phase, before, beforeHistory, state, history: savedHistory, attempts, controls,
      linkPressed: await tool.getAttribute('aria-pressed'), selectPressed: await select.getAttribute('aria-pressed'),
      boundary: 'real explicit global tool activation completed; synchronous bounded old preview/control counts; no private state or synthetic cancellation' }));
    expect(state).toEqual(before); expect(savedHistory).toEqual(beforeHistory); expect(attempts).toHaveLength(count);
    expect(controls, '明确切换工具后旧未提交连线编辑必须取消且不保留旧编辑控件').toEqual({ previews: 0, endpointFree: 0, wholeInstructions: 0 });
  }
  async function createNew(phase: string) {
    const before = await workspace.state(), beforeHistory = await history(), count = attempts.length;
    await tabTo(blank); await page.keyboard.press('Enter'); await expect(preview).toHaveCount(1); await expect(free).toBeFocused();
    for (const key of ['ArrowRight', 'ArrowRight', 'ArrowDown']) await page.keyboard.press(key); await frame();
    const ends = await connectorSvgEnds(preview.locator('path')), expectedStart = await connectorWorldPoint(page, ends.start), expectedEnd = await connectorWorldPoint(page, ends.end);
    await unchanged(before, beforeHistory, count);
    const saved = page.waitForResponse(reply => reply.url().endsWith('/api/mapping/execute') && reply.request().postDataJSON()?.type?.startsWith('connector.'));
    await page.keyboard.press('Enter'); const response = await saved, receipt = await response.json() as Receipt; expect(response.status()).toBe(200);
    await expect(page.getByRole('status')).toHaveText('已保存到本机'); await expect(preview).toHaveCount(0); await expect(tool).toHaveAttribute('aria-pressed', 'false');
    const after = await workspace.state(), afterHistory = await history(); expect(attempts).toHaveLength(count + 1);
    const request = attempts[count]!, command = request.command; expect(request.status).toBe(200); expect(request.receipt).toEqual(receipt);
    expect(command.type).toBe('connector.create'); if (command.type !== 'connector.create') throw new Error('新工具意图必须只发送新的connector.create，不能提交旧编辑');
    expect(command).toMatchObject({ projectId, expected: null, payload: { path: 'straight', start: { kind: 'free' }, end: { kind: 'free' } } });
    expect(command.commandId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    expect(command.payload.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    expect(before.connectors!.some(value => value.id === command.payload.id)).toBe(false);
    if (command.payload.start.kind !== 'free' || command.payload.end.kind !== 'free') throw new Error('新明确空白创建应保留两个自由端');
    expect(command.payload.start.point.x).toBeCloseTo(expectedStart.x, 6); expect(command.payload.start.point.y).toBeCloseTo(expectedStart.y, 6);
    expect(command.payload.end.point.x).toBeCloseTo(expectedEnd.x, 6); expect(command.payload.end.point.y).toBeCloseTo(expectedEnd.y, 6);
    const created = after.connectors!.find(value => value.id === command.payload.id)!;
    expect(created).toEqual({ ...command.payload, kind: 'connector', versionId: receipt.connectorVersions![created.id] });
    expect(receipt.commandId).toBe(command.commandId); expect(receipt.projectId).toBe(projectId); expect(receipt.changedIds).toEqual([created.id]);
    expect(after.connectors).toEqual([...before.connectors!, created]);
    for (const key of ['cards', 'tags', 'texts', 'shapes', 'images', 'strokes'] as const) expect(after[key]).toEqual(before[key]);
    expect(after.project).toEqual({ ...before.project, revision: before.project.revision + 1 }); expect(afterHistory.revision).toBe(beforeHistory.revision + 1);
    expect(afterHistory.undo.slice(0, -1)).toEqual(beforeHistory.undo); expect(afterHistory.undo).toHaveLength(beforeHistory.undo.length + 1);
    expect(afterHistory.undo.at(-1)).toMatchObject({ id: command.commandId, label: 'connector.create', target: { id: created.id } }); expect(afterHistory.redo).toEqual(beforeHistory.redo);
    const rendered = page.getByRole('button', { name: '普通连线', exact: true }).nth(after.connectors!.findIndex(value => value.id === created.id));
    await expect(rendered).toHaveAttribute('aria-pressed', 'true'); await expect(rendered).toBeFocused(); expect(await connectorSvgEnds(rendered.locator('path'))).toEqual(ends);
    await selectOriginal(); await expect(rendered).toHaveAttribute('aria-pressed', 'false'); await expect(preview).toHaveCount(0); await unchanged(after, afterHistory, count + 1);
    console.log('issue26-tool-switch-new-create', JSON.stringify({ phase, command, receipt, before, beforeHistory, after, afterHistory, ends,
      originalLineSelectedAgain: await line.getAttribute('aria-pressed'), boundary: 'one actual new create200/newUUID/id/history+1; all original domains preserved; saved line focus then real reselect proves no orphan edit owner' }));
  }
  await page.route('**/api/mapping/execute', async route => {
    const command = route.request().postDataJSON() as Command;
    if (!command.type.startsWith('connector.')) { await route.continue(); return; }
    const response = await route.fetch(); attempts.push({ command, status: response.status(), receipt: await response.json() as Receipt }); await route.fulfill({ response });
  });
  try {
    await selectOriginal(); const handle = page.getByRole('button', { name: '连线终点', exact: true }); await tabTo(handle); await page.keyboard.press('Enter');
    await expect(preview).toHaveCount(1); await tabTo(free); const endpointInitial = await connectorSvgEnds(preview.locator('path'));
    await page.keyboard.press('ArrowRight'); await frame(); const endpointMoved = await connectorSvgEnds(preview.locator('path'));
    expect(endpointMoved.start).toEqual(endpointInitial.start); expect(endpointMoved.end.x).toBeGreaterThan(endpointInitial.end.x); await unchanged(baseline, baselineHistory, 0);
    await chooseTool(tool); await cancelled('endpoint-to-link', baseline, baselineHistory, 0); await createNew('endpoint-to-link');
    const beforeWhole = await workspace.state(), wholeHistory = await history(), count = attempts.length;
    await chooseTool(tool); await expect(preview).toHaveCount(0); await unchanged(beforeWhole, wholeHistory, count);
    await selectOriginal(); await tabTo(move); await page.keyboard.press('Enter'); await expect(moveInstructions).toBeVisible();
    await expect(preview).toHaveCount(1); const wholeInitial = await connectorSvgEnds(preview.locator('path'));
    await page.keyboard.press('ArrowRight'); await frame(); const wholeMoved = await connectorSvgEnds(preview.locator('path'));
    expect(wholeMoved.start).toEqual(wholeInitial.start); expect(wholeMoved.end.x).toBeGreaterThan(wholeInitial.end.x); await unchanged(beforeWhole, wholeHistory, count);
    console.log('issue26-tool-switch-idle-link-whole', JSON.stringify({ beforeWhole, wholeHistory, attempts, wholeInitial, wholeMoved,
      linkPressed: await tool.getAttribute('aria-pressed'), previewCount: await preview.count(), boundary: 'idle Link was activated before original-line selection; actual mode recorded without requiring retention; whole edit is the only draft before Select' }));
    await chooseTool(select); await cancelled('whole-to-select', beforeWhole, wholeHistory, count);
    await chooseTool(tool); await unchanged(beforeWhole, wholeHistory, count); await createNew('whole-to-select-then-link');
    expect(attempts).toHaveLength(2); expect(attempts.map(value => value.command.type)).toEqual(['connector.create', 'connector.create']);
    expect(new Set(attempts.map(value => value.command.commandId)).size).toBe(2);
    console.log('issue26-tool-switch-edit-complete', JSON.stringify({ fixtureCommands, attempts, state: await workspace.state(), history: await history(),
      boundary: 'both edit branches cancel on explicit tool switch; no old edit writes, no reload between rounds, two new explicit creations only; submitted/unknownACK cancellation not claimed' }));
  } finally { await page.unrouteAll({ behavior: 'wait' }); }
});
