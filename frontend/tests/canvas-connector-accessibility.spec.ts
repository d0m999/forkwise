import { test, expect } from './writing-board-fixture';
import type { Locator, Page } from '@playwright/test';
import type { Command, ProjectHistory, Receipt } from '../../backend/src/mapping/contracts';
import { connectorCardPair, connectorSvgEnds, seedConnectorCard } from './connector-ui-fixture';

async function tabTo(page: Page, target: Locator) {
  for (let step = 0; step < 100; step++) {
    if (await target.evaluate(element => element === document.activeElement)) return;
    await page.keyboard.press('Tab');
  }
  throw new Error('正常Tab顺序无法到达指定连线控件');
}

test('键盘四边入口可完成两个对象之间的普通连接', async ({ page, workspace }) => {
  const pair = await connectorCardPair(page, workspace), before = await workspace.state();
  const historyUrl = workspace.origin + '/api/mapping/projects/' + encodeURIComponent(before.project.id) + '/history', history = await (await page.request.get(historyUrl)).json();
  const commands: unknown[] = []; page.on('request', request => {
    if (request.url().endsWith('/api/mapping/execute') && request.postDataJSON()?.type === 'connector.create') commands.push(request.postDataJSON());
  });
  const tool = page.getByRole('button', { name: '连线', exact: true }); await tabTo(page, tool); await expect(tool).toBeFocused(); await page.keyboard.press('Enter'); await expect(tool).toHaveAttribute('aria-pressed', 'true');
  const entries = page.locator('.connector-entry'); await expect(entries).toHaveCount(8);
  const start = entries.nth(await entries.evaluateAll((nodes, id) => nodes.findIndex(node => (node as HTMLElement).dataset.connectorItem === id && (node as HTMLElement).dataset.connectorSide === 'right'), pair.a.item.id));
  const end = entries.nth(await entries.evaluateAll((nodes, id) => nodes.findIndex(node => (node as HTMLElement).dataset.connectorItem === id && (node as HTMLElement).dataset.connectorSide === 'right'), pair.b.item.id));
  await tabTo(page, start); await expect(start).toBeFocused(); await page.keyboard.press('Enter');
  const preview = page.getByRole('img', { name: '连线预览', exact: true }); expect(await preview.count(), '键盘确认首入口必须建立未提交的真实预览').toBe(1);
  await tabTo(page, end); await expect(end).toBeFocused(); const previewEnds = await connectorSvgEnds(preview.locator('path'));
  for (const [key, point] of [['start', pair.start], ['end', pair.end]] as const) { expect(previewEnds[key].x).toBeCloseTo(point.x, 0); expect(previewEnds[key].y).toBeCloseTo(point.y, 0); }
  expect(commands).toEqual([]); expect(await workspace.state()).toEqual(before); expect(await (await page.request.get(historyUrl)).json()).toEqual(history);
  await expect(start).toHaveAccessibleName(/卡片.*右/); await expect(end).toHaveAccessibleName(/卡片.*右/);
  const saved = page.waitForResponse(response => response.url().endsWith('/api/mapping/execute') && response.request().postDataJSON()?.type === 'connector.create');
  await page.keyboard.press('Space'); expect((await saved).status()).toBe(200); await expect(tool).toHaveAttribute('aria-pressed', 'false'); await expect(page.getByRole('status')).toHaveText('已保存到本机');
  const after = await workspace.state(), line = after.connectors![0]!; expect(commands).toHaveLength(1); expect(line).toMatchObject({ path: 'straight', start: pair.expected.start, end: pair.expected.end });
  for (const key of ['cards', 'tags', 'texts', 'shapes', 'images', 'strokes'] as const) expect(after[key]).toEqual(before[key]);
  const rendered = page.getByRole('button', { name: '普通连线', exact: true }); await expect(rendered).toHaveAttribute('aria-pressed', 'true'); await expect(rendered).toBeFocused(); expect(await connectorSvgEnds(rendered.locator('path'))).toEqual(previewEnds);
  const afterHistory = await (await page.request.get(historyUrl)).json(); expect(afterHistory.undo).toHaveLength(history.undo.length + 1); expect(afterHistory.undo.at(-1)).toMatchObject({ label: 'connector.create', target: { id: line.id } });
  console.log('issue26-keyboard-connect', JSON.stringify({ commands, previewEnds, line, protectedCards: after.cards, afterHistory, input: 'actual Tab then Enter start; actual Tab then Space end; selected line receives focus' }));
});

test('键盘端点手柄可重接到目标对象固定边', async ({ page, workspace }) => {
  const pair = await connectorCardPair(page, workspace), projectId = (await workspace.state()).project.id;
  await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'connector.create', expected: null,
    payload: { id: 'keyboard-edit-line', path: 'straight', start: { kind: 'free', point: { x: 70, y: 70 } }, end: { kind: 'bound', itemId: pair.a.item.id, side: 'right' } } });
  await page.reload(); await expect(page.getByRole('status')).toHaveText('已保存到本机');
  const before = await workspace.state(), original = before.connectors![0]!, historyUrl = workspace.origin + '/api/mapping/projects/' + encodeURIComponent(projectId) + '/history', history = await (await page.request.get(historyUrl)).json();
  const commands: unknown[] = []; page.on('request', request => { if (request.url().endsWith('/api/mapping/execute') && request.postDataJSON()?.type === 'connector.reconnect') commands.push(request.postDataJSON()); });
  const line = page.getByRole('button', { name: '普通连线', exact: true }); await tabTo(page, line); await page.keyboard.press('Enter'); await expect(line).toHaveAttribute('aria-pressed', 'true');
  const initial = await connectorSvgEnds(line.locator('path')), handle = page.getByRole('button', { name: '连线终点', exact: true }); await tabTo(page, handle); await expect(handle).toBeFocused(); await page.keyboard.press('Enter');
  const preview = page.getByRole('img', { name: '连线预览', exact: true }); expect(await preview.count(), '键盘端点确认必须进入未提交的重接预览').toBe(1);
  const entries = page.locator('.connector-entry'); await expect(entries).toHaveCount(8);
  const target = entries.nth(await entries.evaluateAll((nodes, id) => nodes.findIndex(node => (node as HTMLElement).dataset.connectorItem === id && (node as HTMLElement).dataset.connectorSide === 'right'), pair.b.item.id));
  await tabTo(page, target); await expect(target).toBeFocused(); const ends = await connectorSvgEnds(preview.locator('path'));
  expect(ends.start).toEqual(initial.start); expect(ends.end.x).toBeCloseTo(pair.end.x, 0); expect(ends.end.y).toBeCloseTo(pair.end.y, 0);
  expect(commands).toEqual([]); expect(await workspace.state()).toEqual(before); expect(await (await page.request.get(historyUrl)).json()).toEqual(history);
  const saved = page.waitForResponse(response => response.url().endsWith('/api/mapping/execute') && response.request().postDataJSON()?.type === 'connector.reconnect');
  await page.keyboard.press('Enter'); expect((await saved).status()).toBe(200); await expect(preview).toHaveCount(0); await expect(line).toBeFocused();
  const after = await workspace.state(), changed = after.connectors![0]!; expect(commands).toEqual([expect.objectContaining({ type: 'connector.reconnect', expected: original.versionId, payload: { id: original.id, endpoint: 'end', value: { kind: 'bound', itemId: pair.b.item.id, side: 'right' } } })]);
  expect(changed).toMatchObject({ id: original.id, path: original.path, start: original.start, end: { kind: 'bound', itemId: pair.b.item.id, side: 'right' } }); expect(changed.versionId).not.toBe(original.versionId); expect(after.connectors).toHaveLength(1); expect(after.cards).toEqual(before.cards); expect(await connectorSvgEnds(line.locator('path'))).toEqual(ends);
  const afterHistory = await (await page.request.get(historyUrl)).json(); expect(afterHistory.undo).toHaveLength(history.undo.length + 1); expect(afterHistory.undo.at(-1)).toMatchObject({ label: 'connector.reconnect', target: { id: original.id } });
  console.log('issue26-keyboard-reconnect', JSON.stringify({ commands, original, changed, initial, ends, afterHistory, input: 'actual Tab/Enter line selection and endpoint; Tab/Enter destination; same line focused after commit' }));
});

test('窄屏底栏的连线入口具有可见焦点且实际可达', async ({ page, workspace }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await seedConnectorCard(page, workspace, 'narrow-protected', 30, 150); const projectId = (await workspace.state()).project.id;
  await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'connector.create', expected: null,
    payload: { id: 'narrow-line', path: 'straight', start: { kind: 'free', point: { x: 40, y: 70 } }, end: { kind: 'free', point: { x: 300, y: 90 } } } });
  await page.reload(); await expect(page.getByRole('status')).toHaveText('已保存到本机');
  const before = await workspace.state(), historyUrl = workspace.origin + '/api/mapping/projects/' + encodeURIComponent(projectId) + '/history', history = await (await page.request.get(historyUrl)).json();
  const boxes: unknown[] = [], commands: unknown[] = []; page.on('request', request => { if (request.url().endsWith('/api/mapping/execute') && request.postDataJSON()?.type.startsWith('connector.')) commands.push(request.postDataJSON()); });
  const tool = page.getByRole('button', { name: '连线', exact: true });
  const initialBox = await tool.evaluate(element => { const b = element.getBoundingClientRect(); return { x: b.x, y: b.y, right: b.right, bottom: b.bottom, width: b.width, height: b.height }; });
  console.log('issue26-narrow-tool-initial', JSON.stringify(initialBox)); expect(initialBox.x >= 0 && initialBox.right <= 390 && initialBox.y >= 0 && initialBox.bottom <= 844, '390px实际连线入口不能被底栏裁出视口').toBe(true);
  async function reachable(control: Locator) {
    await tabTo(page, control); await expect(control).toBeFocused();
    const actual = await control.evaluate(element => {
      const b = element.getBoundingClientRect(), style = getComputedStyle(element), hit = document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2);
      return { name: element.getAttribute('aria-label') ?? element.textContent, x: b.x, y: b.y, right: b.right, bottom: b.bottom, width: b.width, height: b.height,
        focusVisible: element.matches(':focus-visible') && style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) > 0 && style.outlineColor !== 'rgba(0, 0, 0, 0)', hitSelf: hit === element || !!hit && element.contains(hit) };
    });
    boxes.push(actual); console.log('issue26-narrow-control', JSON.stringify(actual));
    expect(actual.x >= 0 && actual.right <= 390 && actual.y >= 0 && actual.bottom <= 844 && actual.width > 0 && actual.height > 0).toBe(true); expect(actual.focusVisible).toBe(true); expect(actual.hitSelf, '实际中心应命中本控件，不能被另一层工具覆盖').toBe(true);
  }
  await reachable(tool); await tool.click(); await expect(tool).toHaveAttribute('aria-pressed', 'true');
  const entries = page.locator('.connector-entry'); await expect(entries).toHaveCount(4); for (let i = 0; i < 4; i++) await reachable(entries.nth(i));
  await reachable(page.getByRole('button', { name: '选择', exact: true }));
  await page.getByRole('button', { name: '选择', exact: true }).click(); await expect(tool).toHaveAttribute('aria-pressed', 'false');
  const line = page.getByRole('button', { name: '普通连线', exact: true }); await tabTo(page, line); await page.keyboard.press('Enter');
  const controls = page.getByRole('group', { name: '连线路径', exact: true }); for (const name of ['直线', '折线', '曲线', '删除连线']) await reachable(controls.getByRole('button', { name, exact: true }));
  for (const name of ['连线起点', '连线终点']) await reachable(page.getByRole('button', { name, exact: true }));
  await reachable(tool);
  expect(commands).toEqual([]); expect(await workspace.state()).toEqual(before); expect(await (await page.request.get(historyUrl)).json()).toEqual(history);
  console.log('issue26-narrow-connectors', JSON.stringify({ viewport: { width: 390, height: 844 }, boxes, commands, protectedCard: before.cards[0], boundary: 'actual Tab focus, visible outline, all connector control boxes and elementFromPoint centers, real tool click' }));
});

test('键盘切换连线路径成功确认后恢复原控件焦点且尊重后来意图', async ({ page, workspace }) => {
  await page.setViewportSize({ width: 600, height: 870 });
  await seedConnectorCard(page, workspace, 'path-focus-protected-card', 30, 180);
  const projectId = (await workspace.state()).project.id, id = 'path-focus-line', protectedId = 'path-focus-other-line';
  for (const command of [
    { commandId: crypto.randomUUID(), projectId, type: 'connector.create', expected: null, payload: { id, path: 'straight',
      start: { kind: 'free', point: { x: 40, y: 70 } }, end: { kind: 'free', point: { x: 300, y: 90 } } } },
    { commandId: crypto.randomUUID(), projectId, type: 'connector.create', expected: null, payload: { id: protectedId, path: 'straight',
      start: { kind: 'free', point: { x: 40, y: 110 } }, end: { kind: 'free', point: { x: 300, y: 130 } } } },
  ]) await workspace.execute(page, command);
  await page.reload(); await expect(page.getByRole('status')).toHaveText('已保存到本机');
  const baseline = await workspace.state(), historyUrl = workspace.origin + '/api/mapping/projects/' + encodeURIComponent(projectId) + '/history';
  const history = async () => {
    const response = await page.request.get(historyUrl); expect(response.status()).toBe(200);
    return await response.json() as ProjectHistory;
  };
  const line = page.getByRole('button', { name: '普通连线', exact: true }).nth(baseline.connectors!.findIndex(value => value.id === id));
  const choices = page.getByRole('group', { name: '连线路径', exact: true }), navigation = page.getByRole('button', { name: '项目导航', exact: true });
  const commands: Command[] = [], releases: (() => void)[] = [];
  const attempts: { command: Extract<Command, { type: 'connector.path' }>; status: number; receipt: Receipt;
    ackReleased: boolean; ackDelivered: boolean; release: () => void }[] = [];
  const record = (request: import('@playwright/test').Request) => {
    if (request.url().endsWith('/api/mapping/execute') && request.method() === 'POST') commands.push(request.postDataJSON());
  };
  const frame = async () => await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  const focus = async () => await page.evaluate(() => ({ documentHasFocus: document.hasFocus(),
    active: { tag: document.activeElement?.tagName, role: document.activeElement?.getAttribute('role'),
      name: document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.textContent } }));
  page.on('request', record);
  await page.route('**/api/mapping/execute', async route => {
    const command = route.request().postDataJSON() as Command;
    if (command.type !== 'connector.path') { await route.continue(); return; }
    let release = () => {}; const gate = new Promise<void>(resolve => { release = resolve; }); releases.push(() => release());
    const response = await route.fetch(), attempt = { command, status: response.status(), receipt: await response.json() as Receipt,
      ackReleased: false, ackDelivered: false, release: () => {} };
    attempt.release = () => { attempt.ackReleased = true; release(); }; attempts.push(attempt);
    await gate; await route.fulfill({ response }); attempt.ackDelivered = true;
  });
  try {
    await tabTo(page, line); await page.keyboard.press('Enter'); await expect(line).toHaveAttribute('aria-pressed', 'true');
    const endpoints = await connectorSvgEnds(line.locator('path'));
    async function change(path: 'elbow' | 'curve', name: '折线' | '曲线', key: 'Space' | 'Enter', laterFocus?: Locator) {
      const before = await workspace.state(), beforeHistory = await history(), original = before.connectors!.find(value => value.id === id)!;
      const count = attempts.length, commandCount = commands.length, origin = choices.getByRole('button', { name, exact: true });
      await tabTo(page, origin); await expect(origin).toBeFocused();
      const box = await origin.evaluate(element => { const value = element.getBoundingClientRect(); return { x: value.x, y: value.y, right: value.right, bottom: value.bottom }; });
      expect(box.x >= 0 && box.y >= 0 && box.right <= 600 && box.bottom <= 870, '600x870真实Tab目标必须在视口内').toBe(true);
      const saved = page.waitForResponse(response => response.url().endsWith('/api/mapping/execute') &&
        response.request().postDataJSON()?.type === 'connector.path' && response.request().postDataJSON()?.payload?.path === path);
      await page.keyboard.press(key); await expect.poll(() => attempts.length).toBe(count + 1);
      const attempt = attempts[count]!; expect(attempt.status).toBe(200); expect(attempt.ackReleased).toBe(false); expect(attempt.ackDelivered).toBe(false);
      await expect(origin).toBeDisabled(); await expect(page.getByRole('status')).toHaveText('正在保存…');
      expect(commands.slice(commandCount)).toEqual([attempt.command]);
      expect(attempt.command).toMatchObject({ projectId, type: 'connector.path', expected: original.versionId, payload: { id, path } });
      expect(attempt.command.commandId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
      expect(attempt.receipt.commandId).toBe(attempt.command.commandId); expect(attempt.receipt.projectId).toBe(projectId); expect(attempt.receipt.changedIds).toEqual([id]);
      const committed = await workspace.state(), committedHistory = await history();
      const changed = { ...original, path, versionId: attempt.receipt.connectorVersions![id] };
      expect(changed.versionId).not.toBe(original.versionId);
      expect(committed.connectors).toEqual(before.connectors!.map(value => value.id === id ? changed : value));
      const committedLine = committed.connectors!.find(value => value.id === id)!;
      expect(committedLine.start).toEqual(original.start); expect(committedLine.end).toEqual(original.end);
      expect(committed.connectors!.find(value => value.id === protectedId)).toEqual(baseline.connectors!.find(value => value.id === protectedId));
      for (const domain of ['cards', 'tags', 'texts', 'shapes', 'images', 'strokes'] as const) expect(committed[domain]).toEqual(baseline[domain]);
      expect(committed.project).toEqual({ ...before.project, revision: before.project.revision + 1 });
      expect(committedHistory.revision).toBe(beforeHistory.revision + 1); expect(committedHistory.undo.slice(0, -1)).toEqual(beforeHistory.undo);
      expect(committedHistory.undo).toHaveLength(beforeHistory.undo.length + 1);
      expect(committedHistory.undo.at(-1)).toMatchObject({ id: attempt.command.commandId, label: 'connector.path', target: { id } });
      expect(committedHistory.redo).toEqual(beforeHistory.redo);
      if (laterFocus) { await tabTo(page, laterFocus); await expect(laterFocus).toBeFocused(); }
      console.log('issue26-path-focus-held-ack', JSON.stringify({ key, command: attempt.command, receipt: attempt.receipt,
        status: attempt.status, ackReleased: attempt.ackReleased, ackDelivered: attempt.ackDelivered, before, beforeHistory,
        committed, committedHistory, focus: await focus(), laterFocus: !!laterFocus, viewport: { width: 600, height: 870 } }));
      attempt.release(); const response = await saved; expect(response.status()).toBe(200); expect(await response.json()).toEqual(attempt.receipt);
      await expect(page.getByRole('status')).toHaveText('已保存到本机'); await expect(origin).toBeEnabled();
      await expect(origin).toHaveAttribute('aria-pressed', 'true'); await expect(line).toHaveAttribute('aria-pressed', 'true');
      await expect(page.locator('.workspace')).toHaveAttribute('data-revision', String(committed.project.revision));
      expect(await workspace.state()).toEqual(committed); expect(await history()).toEqual(committedHistory);
      expect(await connectorSvgEnds(line.locator('path'))).toEqual(endpoints); expect(commands).toHaveLength(commandCount + 1); expect(attempts).toHaveLength(count + 1);
      await frame();
      console.log('issue26-path-focus-after-ack', JSON.stringify({ key, path, command: attempt.command, receipt: attempt.receipt,
        ackReleased: attempt.ackReleased, ackDelivered: attempt.ackDelivered, focus: await focus(), expectedFocus: laterFocus ? '项目导航' : name,
        boundary: 'actual Tab then Space/Enter; original real200 ACK withheld while disabled; exact one path write/history, original endpoints and other objects; no arbitrary sleep' }));
      await expect(laterFocus ?? origin, laterFocus ? '晚到路径确认不得抢占后来真实Tab选择的控件' : '成功ACK并重新enabled后必须恢复同一个路径按钮的逻辑焦点').toBeFocused();
      return { committed, committedHistory, origin };
    }
    const first = await change('elbow', '折线', 'Space');
    const count = commands.length; await page.keyboard.press('Space'); await frame();
    await expect(first.origin).toBeFocused(); expect(commands).toHaveLength(count); expect(attempts).toHaveLength(1);
    expect(await workspace.state()).toEqual(first.committed); expect(await history()).toEqual(first.committedHistory);
    await change('curve', '曲线', 'Enter', navigation);
    expect(commands).toHaveLength(2); expect(attempts).toHaveLength(2); expect(new Set(attempts.map(value => value.command.commandId)).size).toBe(2);
  } finally { for (const release of releases) release(); page.off('request', record); await page.unrouteAll({ behavior: 'wait' }); }
});

test('编辑器组合输入和Delete不触发连线操作', async ({ page, workspace }) => {
  const card = await seedConnectorCard(page, workspace, 'ime-protected', 130, 150), projectId = (await workspace.state()).project.id;
  await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'connector.create', expected: null,
    payload: { id: 'ime-line', path: 'straight', start: { kind: 'free', point: { x: 500, y: 100 } }, end: { kind: 'bound', itemId: card.item.id, side: 'right' } } });
  await page.reload(); await expect(page.getByRole('status')).toHaveText('已保存到本机');
  const before = await workspace.state(), historyUrl = workspace.origin + '/api/mapping/projects/' + encodeURIComponent(projectId) + '/history', history = await (await page.request.get(historyUrl)).json();
  const connectorCommands: unknown[] = [], titleCommands: unknown[] = []; page.on('request', request => {
    if (!request.url().endsWith('/api/mapping/execute')) return; const command = request.postDataJSON(); if (command?.type.startsWith('connector.')) connectorCommands.push(command); if (command?.type === 'thought.title') titleCommands.push(command);
  });
  const line = page.getByRole('button', { name: '普通连线', exact: true }); await tabTo(page, line); await expect(line).toHaveAttribute('aria-pressed', 'false');
  for (const event of [{ key: 'Enter', code: 'Enter', isComposing: true }, { key: 'Enter', code: 'Enter', keyCode: 229, which: 229 }]) {
    await line.dispatchEvent('keydown', event); await expect(line).toHaveAttribute('aria-pressed', 'false'); await expect(line).toBeFocused();
  }
  await page.keyboard.press('Enter'); await expect(line).toHaveAttribute('aria-pressed', 'true');
  await page.locator('.thought-card .title-button').dblclick(); const editor = page.getByRole('textbox', { name: '卡片标题', exact: true });
  await editor.dispatchEvent('compositionstart'); await editor.fill('组合文字');
  await editor.dispatchEvent('keydown', { key: 'Delete', code: 'Delete', isComposing: true }); await editor.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 229, which: 229 });
  await editor.press('Enter'); await expect(editor).toBeFocused(); await expect(editor).toHaveValue('组合文字');
  expect((await workspace.state()).cards[0]!.title).toBe(card.title); expect(titleCommands).toEqual([]); expect(connectorCommands).toEqual([]);
  const saved = page.waitForResponse(response => response.url().endsWith('/api/mapping/execute') && response.request().postDataJSON()?.type === 'thought.title');
  await editor.dispatchEvent('compositionend'); await editor.press('ArrowLeft'); await editor.press('Delete'); await expect(editor).toHaveValue('组合文'); await editor.press('Enter'); expect((await saved).status()).toBe(200);
  await expect.poll(async () => (await workspace.state()).cards[0]!.title).toBe('组合文'); await expect(page.getByRole('status')).toHaveText('已保存到本机');
  expect(connectorCommands).toEqual([]); expect((await workspace.state()).connectors).toEqual(before.connectors); await expect(page.getByRole('button', { name: '连线', exact: true })).toHaveAttribute('aria-pressed', 'false'); await expect(page.getByRole('img', { name: '连线预览', exact: true })).toHaveCount(0);
  const afterHistory = await (await page.request.get(historyUrl)).json(); expect(afterHistory.undo.slice(history.undo.length).filter((entry: { label: string }) => entry.label.startsWith('connector.'))).toEqual([]);
  console.log('issue26-connector-ime-editor', JSON.stringify({ connectorCommands, titleCommands, beforeLine: before.connectors![0], finalTitle: '组合文', synthetic: ['isComposing Enter on focused SVG', '229 Enter on focused SVG', 'compositionstart/end and Delete/229 in focused title editor'], actualKeys: ['Enter during app composition state', 'ArrowLeft/Delete/Enter after composition'], boundary: 'headless event routing and actual editor character deletion; native input method not claimed' }));
});

test('已有编辑保存失败时连线工具保持未启用', async ({ page, workspace }) => {
  const card = await seedConnectorCard(page, workspace, 'failed-save-card', 130, 150), projectId = (await workspace.state()).project.id;
  let release = () => {}; const gate = new Promise<void>(resolve => { release = resolve; }), commands: unknown[] = [], attempts: { command: unknown; status: number; body: unknown }[] = [], connectorCommands: unknown[] = [];
  await page.route('**/api/mapping/execute', async route => {
    const command = route.request().postDataJSON(); if (command?.type.startsWith('connector.')) connectorCommands.push(command);
    if (command?.type !== 'thought.title') { await route.continue(); return; }
    commands.push(command); await gate; const response = await route.fetch(); attempts.push({ command, status: response.status(), body: await response.json() }); await route.fulfill({ response });
  });
  try {
    await page.locator('.thought-card .title-button').dblclick(); const editor = page.getByRole('textbox', { name: '卡片标题', exact: true }); await editor.fill('仍需保留的本地标题');
    const refused = page.waitForResponse(response => response.url().endsWith('/api/mapping/execute') && response.request().postDataJSON()?.type === 'thought.title'); await editor.press('Enter'); await expect.poll(() => commands.length).toBe(1);
    await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'thought.title', expected: card.versionId, payload: { id: card.id, title: '对方已保存的标题' } });
    const peer = await workspace.state(), historyUrl = workspace.origin + '/api/mapping/projects/' + encodeURIComponent(projectId) + '/history', history = await (await page.request.get(historyUrl)).json();
    release(); expect((await refused).status()).toBe(409); await expect(page.getByRole('region', { name: '保存冲突', exact: true })).toBeVisible(); expect(attempts).toEqual([expect.objectContaining({ status: 409, body: expect.objectContaining({ code: 'VERSION_CONFLICT' }), command: expect.objectContaining({ expected: card.versionId }) })]);
    const tool = page.getByRole('button', { name: '连线', exact: true }); await tool.click();
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(tool).toHaveAttribute('aria-pressed', 'false'); await expect(page.getByRole('img', { name: '连线预览', exact: true })).toHaveCount(0);
    await page.mouse.move(460, 450); await page.mouse.down(); await page.mouse.move(650, 550, { steps: 4 }); await page.mouse.up();
    await expect(tool).toHaveAttribute('aria-pressed', 'false'); expect(connectorCommands).toEqual([]); expect(commands).toHaveLength(1); expect(await workspace.state()).toEqual(peer); expect(await (await page.request.get(historyUrl)).json()).toEqual(history); await expect(page.getByRole('region', { name: '保存冲突', exact: true })).toBeVisible();
    console.log('issue26-connector-save-refusal', JSON.stringify({ attempts, connectorCommands, peer, history, boundary: 'own title command held before execute, real peer version update, real409 then actual line tool click and canvas gesture; failed draft not bypassed' }));
  } finally { release(); await page.unrouteAll({ behavior: 'wait' }); }
});

test('迟到保存确认不覆盖后来明确选择的工具', async ({ page, workspace }) => {
  const card = await seedConnectorCard(page, workspace, 'late-ack-card', 130, 150), projectId = (await workspace.state()).project.id;
  let release = () => {}, released = false, acks = 0; const gate = new Promise<void>(resolve => { release = () => { released = true; resolve(); }; });
  const attempts: { command: unknown; status: number; receipt: unknown }[] = [], connectorCommands: unknown[] = [];
  await page.route('**/api/mapping/execute', async route => {
    const command = route.request().postDataJSON(); if (command?.type.startsWith('connector.')) connectorCommands.push(command);
    if (command?.type !== 'thought.title') { await route.continue(); return; }
    const response = await route.fetch(); attempts.push({ command, status: response.status(), receipt: await response.json() }); await gate; await route.fulfill({ response }); acks++;
  });
  try {
    await page.locator('.thought-card .title-button').dblclick(); const editor = page.getByRole('textbox', { name: '卡片标题', exact: true }); await editor.fill('晚到确认');
    const saved = page.waitForResponse(response => response.url().endsWith('/api/mapping/execute') && response.request().postDataJSON()?.type === 'thought.title'); await editor.press('Enter'); await expect.poll(() => attempts.length).toBe(1); expect(attempts[0]!.status).toBe(200); expect(acks).toBe(0); expect(released).toBe(false);
    const committed = await workspace.state(), historyUrl = workspace.origin + '/api/mapping/projects/' + encodeURIComponent(projectId) + '/history', committedHistory = await (await page.request.get(historyUrl)).json(); expect(committed.cards.find(value => value.id === card.id)!.title).toBe('晚到确认');
    const tool = page.getByRole('button', { name: '连线', exact: true }), move = page.getByRole('button', { name: '移动', exact: true }); await tool.click();
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(tool).toHaveAttribute('aria-pressed', 'false'); expect(released).toBe(false); expect(acks).toBe(0);
    await move.click(); await expect(move).toHaveAttribute('aria-pressed', 'true'); expect(released).toBe(false); expect(connectorCommands).toEqual([]);
    release(); expect((await saved).status()).toBe(200); await expect(page.getByRole('status')).toHaveText('已保存到本机');
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    const modes = { line: await tool.getAttribute('aria-pressed'), move: await move.getAttribute('aria-pressed') }; console.log('issue26-late-ack-modes', JSON.stringify({ modes, acks, released, attempts }));
    expect(modes, '较早连线启用请求的晚确认不得覆盖后来明确选择的移动工具').toEqual({ line: 'false', move: 'true' });
    expect(acks).toBe(1); expect(attempts).toHaveLength(1); expect(connectorCommands).toEqual([]); expect(await workspace.state()).toEqual(committed); expect(await (await page.request.get(historyUrl)).json()).toEqual(committedHistory); await expect(page.getByRole('img', { name: '连线预览', exact: true })).toHaveCount(0);
    console.log('issue26-late-ack-tool', JSON.stringify({ modes, attempts, committedHistory, boundary: 'real own save200 held before browser ACK; connector preparation waiting; later actual Move click remains authoritative after old ACK' }));
  } finally { release(); await page.unrouteAll({ behavior: 'wait' }); }
});


test('从连线切换创作工具后只执行新工具意图', async ({ page, workspace }) => {
  const protectedCard = await seedConnectorCard(page, workspace, 'switch-tool-card', 130, 150);
  const tool = page.getByRole('button', { name: '连线', exact: true });
  const writes: { type: string; [key: string]: unknown }[] = [];
  const record = (request: import('@playwright/test').Request) => {
    if (request.url().endsWith('/api/mapping/execute') && request.method() === 'POST') writes.push(request.postDataJSON());
  };
  page.on('request', record);
  const variants = [
    { name: '卡片', type: 'thought.create', key: 'cards' }, { name: '文字', type: 'text.create', key: 'texts' },
    { name: '形状', type: 'shape.create', key: 'shapes' }, { name: '画笔', type: 'stroke.create', key: 'strokes' },
  ] as const;
  async function choose(name: string) {
    await page.getByRole('button', { name, exact: true }).click();
    if (name === '形状') await page.getByRole('menu', { name: '形状预设', exact: true }).getByRole('menuitem', { name: '矩形', exact: true }).click();
    if (name === '画笔') await page.getByRole('menu', { name: '画笔类型', exact: true }).getByRole('menuitem', { name: '普通笔', exact: true }).click();
  }
  async function create(variant: typeof variants[number], phase: string) {
    const before = await workspace.state(), start = writes.length, pane = page.locator('.react-flow__pane');
    const point = await pane.evaluate(element => {
      const box = element.getBoundingClientRect();
      for (const y of [440, 100, 340, 520]) for (const x of [560, 860, 430, 700, 100]) {
        if (x + 85 >= box.width || y + 35 >= box.height) continue;
        if ([{ x, y }, { x: x + 40, y: y + 15 }, { x: x + 80, y: y + 30 }].every(p => document.elementFromPoint(box.x + p.x, box.y + p.y) === element))
          return { x, y, screenX: box.x + x, screenY: box.y + y };
      }
      throw new Error('当前画布缺少本用例可实际命中的空白创作点');
    });
    if (variant.name === '画笔') {
      await page.mouse.move(point.screenX, point.screenY); await page.mouse.down();
      await page.mouse.move(point.screenX + 80, point.screenY + 30, { steps: 5 }); await page.mouse.up();
    } else {
      await pane.click({ position: point });
      if (variant.name === '卡片') {
        const editor = page.getByRole('textbox', { name: '卡片标题', exact: true }); await editor.fill(phase + '卡片'); await editor.press('Enter');
      } else if (variant.name === '文字') {
        const editor = page.getByRole('textbox', { name: '独立文字', exact: true }); await editor.fill(phase + '文字'); await editor.press('Escape');
      }
    }
    await expect.poll(async () => (await workspace.state())[variant.key]?.length ?? 0).toBe((before[variant.key]?.length ?? 0) + 1);
    await expect(page.getByRole('status')).toHaveText('已保存到本机');
    const after = await workspace.state(), commands = writes.slice(start);
    expect(commands.filter(value => value.type.endsWith('.create')).map(value => value.type)).toEqual([variant.type]);
    expect(commands.filter(value => value.type.startsWith('connector.'))).toEqual([]);
    for (const key of ['cards', 'texts', 'shapes', 'strokes', 'images', 'tags', 'connectors'] as const) {
      if (key === variant.key) {
        const originalIds = new Set((before[key] ?? []).map(value => value.id));
        expect((after[key] ?? []).filter(value => originalIds.has(value.id))).toEqual(before[key]);
      } else expect(after[key]).toEqual(before[key]);
    }
    console.log('issue26-tool-only-create', JSON.stringify({ tool: variant.name, phase, commands, before, after }));
  }
  try {
    for (const variant of variants) {
      await page.reload(); await expect(page.getByRole('status')).toHaveText('已保存到本机');
      await tool.click(); await expect(tool).toHaveAttribute('aria-pressed', 'true');
      await choose(variant.name); await expect(page.getByRole('button', { name: variant.name, exact: true })).toHaveAttribute('aria-pressed', 'true');
      const idleModes = { line: await tool.getAttribute('aria-pressed'), selected: await page.getByRole('button', { name: variant.name, exact: true }).getAttribute('aria-pressed') };
      console.log('issue26-idle-tool-switch', JSON.stringify({ tool: variant.name, modes: idleModes, writes }));
      expect(idleModes, '明确选择创作工具后旧连线模式必须退出').toEqual({ line: 'false', selected: 'true' });
      await expect(page.getByRole('img', { name: '连线预览', exact: true })).toHaveCount(0);
      await create(variant, '已启用后切换');
      await page.reload(); await expect(page.getByRole('status')).toHaveText('已保存到本机');
      let release = () => {}, released = false, delivered = 0;
      const gate = new Promise<void>(resolve => { release = () => { released = true; resolve(); }; });
      const attempts: { command: unknown; status: number; receipt: unknown }[] = [];
      await page.route('**/api/mapping/execute', async route => {
        const command = route.request().postDataJSON();
        if (command?.type !== 'thought.title' || command.payload.id !== protectedCard.id) { await route.continue(); return; }
        const response = await route.fetch(); attempts.push({ command, status: response.status(), receipt: await response.json() });
        await gate; await route.fulfill({ response }); delivered++;
      });
      try {
        const node = page.locator('.react-flow__node[data-id="' + protectedCard.item.id + '"]');
        await node.locator('.title-button').dblclick();
        const editor = page.getByRole('textbox', { name: '卡片标题', exact: true }); await editor.fill('晚确认后选择' + variant.name);
        const saved = page.waitForResponse(response => response.url().endsWith('/api/mapping/execute') && response.request().postDataJSON()?.type === 'thought.title');
        await editor.press('Enter'); await expect.poll(() => attempts.length).toBe(1); expect(attempts[0]!.status).toBe(200); expect(delivered).toBe(0);
        const committed = await workspace.state(), start = writes.length;
        await tool.click(); await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
        await expect(tool).toHaveAttribute('aria-pressed', 'false'); expect(released).toBe(false);
        await choose(variant.name); expect(released).toBe(false); expect(delivered).toBe(0);
        expect(writes.slice(start).filter(value => value.type.startsWith('connector.'))).toEqual([]);
        release(); expect((await saved).status()).toBe(200); await expect(page.getByRole('status')).toHaveText('已保存到本机');
        await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
        await expect(page.getByRole('button', { name: variant.name, exact: true })).toHaveAttribute('aria-pressed', 'true');
        const modes = { line: await tool.getAttribute('aria-pressed'), selected: await page.getByRole('button', { name: variant.name, exact: true }).getAttribute('aria-pressed') };
        console.log('issue26-late-prepare-tool-switch', JSON.stringify({ tool: variant.name, modes, attempts, delivered, released, committed, current: await workspace.state() }));
        expect(modes, '较早连线prepare的晚确认不得清除新工具或重启旧连线').toEqual({ line: 'false', selected: 'true' });
        expect(delivered).toBe(1); expect(attempts).toHaveLength(1); expect(await workspace.state()).toEqual(committed);
        await expect(page.getByRole('img', { name: '连线预览', exact: true })).toHaveCount(0);
      } finally { release(); await page.unrouteAll({ behavior: 'wait' }); }
      await create(variant, '较早确认后切换');
    }
  } finally { page.off('request', record); }
});
