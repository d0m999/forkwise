import { test, expect } from './writing-board-fixture';
import type { Command, ProjectHistory } from '../../backend/src/mapping/contracts';
import { connectorCardPair, connectorSurfaceBox, connectorSvgEnds } from './connector-ui-fixture';

test('重接自连拒绝后可继续明确操作', async ({ page, workspace }) => {
  const pair = await connectorCardPair(page, workspace), projectId = (await workspace.state()).project.id;
  await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'connector.create', expected: null,
    payload: { id: 'self-refusal-recovery-line', path: 'straight', start: pair.expected.start, end: pair.expected.end } });
  await page.reload(); await expect(page.getByRole('status')).toHaveText('已保存到本机');
  const before = await workspace.state(), original = before.connectors![0]!;
  const historyUrl = workspace.origin + '/api/mapping/projects/' + encodeURIComponent(projectId) + '/history';
  const history = await (await page.request.get(historyUrl)).json() as ProjectHistory;
  const attempts: { command: Command; status: number; body: unknown }[] = [];
  await page.route('**/api/mapping/execute', async route => {
    const command = route.request().postDataJSON() as Command;
    if (command.type !== 'connector.reconnect') { await route.continue(); return; }
    const response = await route.fetch(); attempts.push({ command, status: response.status(), body: await response.json() }); await route.fulfill({ response });
  });
  try {
    const line = page.getByRole('button', { name: '普通连线', exact: true }); await line.click();
    const handle = page.getByRole('button', { name: '连线终点', exact: true });
    const initial = await connectorSvgEnds(line.locator('path')), a = await connectorSurfaceBox(page, pair.a.item.id);
    const selfTarget = { x: a.x + a.width / 2, y: a.y };
    const refused = page.waitForResponse(response => response.url().endsWith('/api/mapping/execute') && response.request().postDataJSON()?.type === 'connector.reconnect');
    await handle.hover(); await page.mouse.down(); await page.mouse.move(selfTarget.x, selfTarget.y, { steps: 6 }); await page.mouse.up();
    const response = await refused, failure = await response.json() as { code: string; message: string };
    expect(response.status()).toBe(400); expect(failure.code).toBe('INVALID_ENDPOINT');
    await expect(page.getByRole('alert').filter({ hasText: failure.message })).toBeVisible();
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    const unchanged = await workspace.state(), unchangedHistory = await (await page.request.get(historyUrl)).json() as ProjectHistory;
    expect(attempts).toHaveLength(1); expect(attempts[0]!.command).toMatchObject({ projectId, type: 'connector.reconnect', expected: original.versionId,
      payload: { id: original.id, endpoint: 'end', value: { kind: 'bound', itemId: pair.a.item.id, side: 'top' } } });
    expect(unchanged).toEqual(before); expect(unchangedHistory).toEqual(history);
    expect(await connectorSvgEnds(line.locator('path'))).toEqual(initial);
    const ready = await handle.isEnabled(), previewCount = await page.getByRole('img', { name: '连线预览', exact: true }).count();
    console.log('issue26-self-rejection-ready', JSON.stringify({ attempts, before, history, unchanged, unchangedHistory, initial, ready, previewCount,
      boundary: 'real original backend400 INVALID_ENDPOINT after pointer reconnect from B to A; zero state/history writes and no automatic retry; bounded actual handle availability' }));
    expect(ready, '确定自连拒绝后必须释放未确认命令，允许本人重新明确重接').toBe(true);
    expect(previewCount).toBe(0);
    const b = await connectorSurfaceBox(page, pair.b.item.id), legalTarget = { x: b.x + b.width / 2, y: b.y };
    const saved = page.waitForResponse(reply => reply.url().endsWith('/api/mapping/execute') && reply.request().postDataJSON()?.type === 'connector.reconnect' && reply.request().postDataJSON()?.commandId !== attempts[0]!.command.commandId);
    await handle.hover(); await page.mouse.down(); await page.mouse.move(legalTarget.x, legalTarget.y, { steps: 6 }); await page.mouse.up();
    const success = await saved, receipt = await success.json(); expect(success.status()).toBe(200);
    await expect(page.getByRole('status')).toHaveText('已保存到本机'); await expect(page.getByRole('img', { name: '连线预览', exact: true })).toHaveCount(0);
    const after = await workspace.state(), afterHistory = await (await page.request.get(historyUrl)).json() as ProjectHistory;
    expect(attempts).toHaveLength(2); expect(attempts.map(value => value.status)).toEqual([400, 200]);
    expect(attempts[1]!.command.commandId).not.toBe(attempts[0]!.command.commandId);
    expect(attempts[1]!.command).toMatchObject({ projectId, type: 'connector.reconnect', expected: original.versionId,
      payload: { id: original.id, endpoint: 'end', value: { kind: 'bound', itemId: pair.b.item.id, side: 'top' } } });
    expect(after.connectors).toEqual([expect.objectContaining({ id: original.id, path: original.path, start: original.start,
      end: { kind: 'bound', itemId: pair.b.item.id, side: 'top' } })]);
    expect(after.connectors![0]!.versionId).not.toBe(original.versionId);
    for (const key of ['cards', 'tags', 'texts', 'shapes', 'strokes', 'images'] as const) expect(after[key]).toEqual(before[key]);
    expect(receipt.changedIds).toEqual([original.id]); expect(after.project.revision).toBe(before.project.revision + 1);
    expect(afterHistory.undo).toHaveLength(history.undo.length + 1); expect(afterHistory.undo.at(-1)).toMatchObject({ label: 'connector.reconnect', target: { id: original.id } });
    await expect(page.getByRole('button', { name: '普通连线', exact: true })).toHaveCount(1); await expect(handle).toBeEnabled();
    console.log('issue26-self-rejection-recovery', JSON.stringify({ attempts, original, receipt, after, afterHistory,
      boundary: 'only new explicit legal B-top reconnect succeeds with a new UUID, same line and untouched other endpoint; only success adds one history action' }));
  } finally { await page.unrouteAll({ behavior: 'wait' }); }
});


test('前置保存冲突解决后可继续明确编辑连线', async ({ page, workspace }) => {
  const pair = await connectorCardPair(page, workspace), projectId = (await workspace.state()).project.id;
  await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'connector.create', expected: null,
    payload: { id: 'preflight-conflict-line', path: 'straight', start: pair.expected.start, end: pair.expected.end } });
  await page.reload(); await expect(page.getByRole('status')).toHaveText('已保存到本机');
  const before = await workspace.state(), card = before.cards.find(value => value.id === pair.a.id)!, original = before.connectors![0]!;
  const historyUrl = workspace.origin + '/api/mapping/projects/' + encodeURIComponent(projectId) + '/history';
  let release = () => {}; const gate = new Promise<void>(resolve => { release = resolve; });
  const localTitle = '本地待保存标题', titleCommands: Command[] = [], events: string[] = [];
  const titleReplies: { command: Command; status: number; body: unknown }[] = [], connectorReplies: { command: Command; status: number; body: unknown }[] = [];
  await page.route('**/api/mapping/execute', async route => {
    const command = route.request().postDataJSON() as Command;
    if (command.type === 'thought.title' && command.payload.id === card.id) {
      titleCommands.push(command);
      if (command.payload.title === localTitle) { events.push('original-title-request-held'); await gate; }
      const response = await route.fetch(); titleReplies.push({ command, status: response.status(), body: await response.json() });
      events.push('title-response-' + response.status()); await route.fulfill({ response });
    } else if (command.type.startsWith('connector.')) {
      const response = await route.fetch(); connectorReplies.push({ command, status: response.status(), body: await response.json() }); await route.fulfill({ response });
    } else await route.continue();
  });
  try {
    const node = page.locator('.react-flow__node[data-id="' + card.item.id + '"]'); await node.locator('.title-button').dblclick();
    const editor = page.getByRole('textbox', { name: '卡片标题', exact: true }); await editor.fill(localTitle);
    const originalSave = page.waitForResponse(response => response.url().endsWith('/api/mapping/execute') && response.request().postDataJSON()?.type === 'thought.title');
    await editor.press('Enter'); await expect.poll(() => titleCommands.length).toBe(1); expect(titleReplies).toHaveLength(0);
    expect(titleCommands[0]).toMatchObject({ projectId, type: 'thought.title', expected: card.versionId, payload: { id: card.id, title: localTitle } });
    await page.getByRole('button', { name: '普通连线', exact: true }).click();
    const curve = page.getByRole('group', { name: '连线路径', exact: true }).getByRole('button', { name: '曲线', exact: true });
    await expect(curve).toBeEnabled(); events.push('explicit-path-intent-before-title-response'); await curve.click();
    expect(titleReplies).toHaveLength(0); expect(connectorReplies).toHaveLength(0);
    await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'thought.title', expected: card.versionId,
      payload: { id: card.id, title: '对方已保存的标题' } }); events.push('peer-title-real200');
    const peer = await workspace.state(), peerHistory = await (await page.request.get(historyUrl)).json() as ProjectHistory;
    release(); const refused = await originalSave, failure = await refused.json(); expect(refused.status()).toBe(409); expect(failure.code).toBe('VERSION_CONFLICT');
    const conflict = page.getByRole('region', { name: '保存冲突', exact: true }); await expect(conflict).toBeVisible();
    await expect(conflict.getByRole('textbox', { name: '我的标题', exact: true })).toHaveValue(localTitle);
    expect(connectorReplies).toHaveLength(0); expect(await workspace.state()).toEqual(peer); expect(await (await page.request.get(historyUrl)).json()).toEqual(peerHistory);
    events.push('explicit-remote-title-resolution'); await conflict.getByRole('button', { name: '确认保留已保存的标题', exact: true }).click();
    await expect(conflict).toHaveCount(0); await expect(page.getByRole('status')).toHaveText('已保存到本机');
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    const resolved = await workspace.state(), resolvedHistory = await (await page.request.get(historyUrl)).json() as ProjectHistory;
    expect(resolved).toEqual(peer); expect(resolvedHistory).toEqual(peerHistory); expect(connectorReplies).toHaveLength(0);
    const ready = await curve.isEnabled();
    console.log('issue26-preflight-conflict-ready', JSON.stringify({ before, peer, peerHistory, events, titleCommands, titleReplies, connectorReplies, resolved, resolvedHistory, ready,
      boundary: 'actual path click waits original title execute; real peer200 makes original409; explicit existing UI remote-title choice; no connector execute before new user intent' }));
    expect(ready, '前置保存冲突已解决后，连线编辑必须释放未提交锁并允许再次明确操作').toBe(true);
    const saved = page.waitForResponse(response => response.url().endsWith('/api/mapping/execute') && response.request().postDataJSON()?.type === 'connector.path');
    await curve.click(); const success = await saved, receipt = await success.json(); expect(success.status()).toBe(200);
    await expect(page.getByRole('status')).toHaveText('已保存到本机');
    const after = await workspace.state(), afterHistory = await (await page.request.get(historyUrl)).json() as ProjectHistory;
    expect(connectorReplies).toHaveLength(1); expect(connectorReplies[0]!.command).toMatchObject({ projectId, type: 'connector.path', expected: original.versionId,
      payload: { id: original.id, path: 'curve' } });
    expect(after.connectors).toEqual([{ ...original, path: 'curve', versionId: receipt.connectorVersions[original.id] }]);
    for (const key of ['cards', 'tags', 'texts', 'shapes', 'strokes', 'images'] as const) expect(after[key]).toEqual(resolved[key]);
    expect(after.project.revision).toBe(resolved.project.revision + 1); expect(afterHistory.undo).toHaveLength(resolvedHistory.undo.length + 1);
    expect(afterHistory.undo.at(-1)).toMatchObject({ label: 'connector.path', target: { id: original.id } });
    console.log('issue26-preflight-conflict-recovery', JSON.stringify({ titleReplies, connectorReplies, resolved, resolvedHistory, receipt, after, afterHistory,
      boundary: 'only a new explicit path choice executes200; original line ID/endpoints and content domains retained; only successful connector edit adds one history action' }));
  } finally { release(); await page.unrouteAll({ behavior: 'wait' }); }
});


test('连线编辑确定拒绝后可继续明确操作', async ({ page, workspace }) => {
  const { connectorWorldPoint } = await import('./connector-ui-fixture');
  const pair = await connectorCardPair(page, workspace), projectId = (await workspace.state()).project.id;
  const historyUrl = workspace.origin + '/api/mapping/projects/' + encodeURIComponent(projectId) + '/history';
  const history = async () => await (await page.request.get(historyUrl)).json() as ProjectHistory;
  type Mode = 'path' | 'move' | 'delete' | 'reconnect';
  type EditCommand = Extract<Command, { type: 'connector.path' | 'connector.move' | 'connector.delete' | 'connector.reconnect' }>;
  async function perform(mode: Mode, line: import('@playwright/test').Locator) {
    if (mode === 'path' || mode === 'delete') {
      await page.getByRole('group', { name: '连线路径', exact: true }).getByRole('button', { name: mode === 'path' ? '曲线' : '删除连线', exact: true }).click(); return;
    }
    if (mode === 'reconnect') {
      const b = await connectorSurfaceBox(page, pair.b.item.id);
      await page.getByRole('button', { name: '连线终点', exact: true }).hover(); await page.mouse.down();
      await page.mouse.move(b.x + b.width / 2, b.y, { steps: 6 }); await page.mouse.up(); return;
    }
    const hit = await line.locator('path').evaluate(element => {
      const path = element as SVGPathElement, p = path.getPointAtLength(path.getTotalLength() / 2), value = new DOMPoint(p.x, p.y).matrixTransform(path.getScreenCTM()!);
      return { x: value.x, y: value.y };
    });
    const destination = { x: hit.x + 60, y: hit.y + 35 }, from = await connectorWorldPoint(page, hit), to = await connectorWorldPoint(page, destination);
    await page.mouse.move(hit.x, hit.y); await page.mouse.down(); await page.mouse.move(destination.x, destination.y, { steps: 6 }); await page.mouse.up();
    return { dx: to.x - from.x, dy: to.y - from.y };
  }
  for (const mode of ['path', 'move', 'delete', 'reconnect'] as const) {
    const fixtureCommands: { command: Command; receipt: unknown }[] = [], events: string[] = [];
    const fixture = async (command: Command) => { const receipt = await workspace.execute(page, command); fixtureCommands.push({ command, receipt }); };
    for (const line of (await workspace.state()).connectors ?? []) await fixture({ commandId: crypto.randomUUID(), projectId, type: 'connector.delete', expected: line.versionId, payload: { id: line.id } });
    const id = 'refusal-' + mode, survivorId = id + '-survivor';
    await fixture({ commandId: crypto.randomUUID(), projectId, type: 'connector.create', expected: null,
      payload: { id, path: 'straight', start: pair.expected.start, end: { kind: 'free', point: { x: 600, y: 500 } } } });
    await fixture({ commandId: crypto.randomUUID(), projectId, type: 'connector.create', expected: null,
      payload: { id: survivorId, path: 'straight', start: { kind: 'free', point: { x: 800, y: 90 } }, end: { kind: 'free', point: { x: 1000, y: 90 } } } });
    await page.reload(); await expect(page.getByRole('status')).toHaveText('已保存到本机'); events.push('fixture-complete-before-baseline');
    const before = await workspace.state(), beforeHistory = await history(), original = before.connectors!.find(value => value.id === id)!;
    expect(before.connectors!.map(value => value.id)).toEqual([id, survivorId]);
    const lines = page.getByRole('button', { name: '普通连线', exact: true }); await expect(lines).toHaveCount(2);
    const line = lines.first(); await line.press('Enter');
    const peerCommand: Command = mode === 'reconnect'
      ? { commandId: crypto.randomUUID(), projectId, type: 'connector.delete', expected: original.versionId, payload: { id } }
      : { commandId: crypto.randomUUID(), projectId, type: 'connector.path', expected: original.versionId, payload: { id, path: 'elbow' } };
    const peerReceipt = await workspace.execute(page, peerCommand); events.push('real-peer200-before-stale-UI-intent');
    const peer = await workspace.state(), peerHistory = await history();
    expect(peer.project.revision).toBe(before.project.revision + 1); expect(peerHistory.undo).toHaveLength(beforeHistory.undo.length + 1);
    expect(peer.cards).toEqual(before.cards); await expect(page.locator('.workspace')).toHaveAttribute('data-revision', String(before.project.revision));
    const attempts: { command: EditCommand; status: number; body: unknown }[] = [];
    await page.route('**/api/mapping/execute', async route => {
      const command = route.request().postDataJSON() as Command;
      if (command.type !== 'connector.path' && command.type !== 'connector.move' && command.type !== 'connector.delete' && command.type !== 'connector.reconnect') { await route.continue(); return; }
      const response = await route.fetch(); attempts.push({ command, status: response.status(), body: await response.json() }); await route.fulfill({ response });
    });
    try {
      const refused = page.waitForResponse(response => response.url().endsWith('/api/mapping/execute') && response.request().postDataJSON()?.type === 'connector.' + mode);
      events.push('actual-user-stale-command'); const refusedMotion = await perform(mode, line), response = await refused, failure = await response.json() as { code: string; message: string };
      expect(response.status()).toBe(mode === 'reconnect' ? 404 : 409); expect(failure.code).toBe(mode === 'reconnect' ? 'NOT_FOUND' : 'VERSION_CONFLICT');
      await expect(page.getByRole('alert').filter({ hasText: failure.message })).toBeVisible();
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      const unchanged = await workspace.state(), unchangedHistory = await history();
      expect(attempts).toHaveLength(1); expect(attempts[0]!.command).toMatchObject({ projectId, type: 'connector.' + mode, expected: original.versionId, payload: { id } });
      expect(attempts[0]!.command.commandId).not.toBe(peerCommand.commandId); expect(unchanged).toEqual(peer); expect(unchangedHistory).toEqual(peerHistory);
      const recoveryId = mode === 'reconnect' ? survivorId : id, recoveryLine = mode === 'reconnect' ? lines.last() : lines.first();
      await recoveryLine.press('Enter');
      const control = mode === 'reconnect' ? page.getByRole('button', { name: '连线终点', exact: true })
        : page.getByRole('group', { name: '连线路径', exact: true }).getByRole('button', { name: mode === 'delete' ? '删除连线' : '曲线', exact: true });
      const ready = await control.isEnabled(), previewCount = await page.getByRole('img', { name: '连线预览', exact: true }).count();
      console.log('issue26-definite-rejection-ready', JSON.stringify({ mode, fixtureCommands, events, before, beforeHistory, original, peerCommand, peerReceipt, peer, peerHistory,
        attempts, refusedMotion, unchanged, unchangedHistory, recoveryId, ready, previewCount, boundary: 'fixture before baseline; real peer precedes stale UI command; actual backend rejection causes no write/history or automatic resend; bounded real recovery control' }));
      expect(ready, mode + '确定拒绝后必须释放未确认编辑并允许新的明确操作').toBe(true); expect(previewCount).toBe(0);
      const base = peer.connectors!.find(value => value.id === recoveryId)!;
      const saved = page.waitForResponse(reply => reply.url().endsWith('/api/mapping/execute') && reply.request().postDataJSON()?.type === 'connector.' + mode && reply.request().postDataJSON()?.commandId !== attempts[0]!.command.commandId);
      events.push('new-explicit-user-command'); const successMotion = await perform(mode, recoveryLine), success = await saved, receipt = await success.json(); expect(success.status()).toBe(200);
      await expect(page.getByRole('status')).toHaveText('已保存到本机'); await expect(page.getByRole('img', { name: '连线预览', exact: true })).toHaveCount(0);
      const after = await workspace.state(), afterHistory = await history();
      expect(attempts).toHaveLength(2); expect(attempts.map(value => value.status)).toEqual([mode === 'reconnect' ? 404 : 409, 200]);
      expect(attempts[1]!.command.commandId).not.toBe(attempts[0]!.command.commandId);
      expect(attempts[1]!.command).toMatchObject({ projectId, type: 'connector.' + mode, expected: base.versionId, payload: { id: recoveryId } });
      expect(receipt.commandId).toBe(attempts[1]!.command.commandId);
      if (mode === 'delete') {
        expect(after.connectors).toEqual(peer.connectors!.filter(value => value.id !== recoveryId)); expect(receipt.deletedIds).toContain(recoveryId);
      } else {
        const expectedLine = { ...base, versionId: receipt.connectorVersions[recoveryId] as string };
        expect(expectedLine.versionId).not.toBe(base.versionId);
        if (mode === 'path') expectedLine.path = 'curve';
        else if (mode === 'reconnect') expectedLine.end = { kind: 'bound', itemId: pair.b.item.id, side: 'top' };
        else {
          if (base.end.kind !== 'free' || !successMotion) throw new Error('移动恢复测试必须保留自由端和实际拖动位移');
          expectedLine.end = { kind: 'free', point: { x: base.end.point.x + successMotion.dx, y: base.end.point.y + successMotion.dy } };
          expect(attempts[1]!.command.payload).toMatchObject(successMotion);
        }
        expect(after.connectors).toEqual(peer.connectors!.map(value => value.id === recoveryId ? expectedLine : value));
      }
      for (const key of ['cards', 'tags', 'texts', 'shapes', 'strokes', 'images'] as const) expect(after[key]).toEqual(peer[key]);
      expect(after.project.revision).toBe(peer.project.revision + 1); expect(afterHistory.revision).toBe(peerHistory.revision + 1);
      expect(afterHistory.undo.slice(0, -1)).toEqual(peerHistory.undo); expect(afterHistory.undo).toHaveLength(peerHistory.undo.length + 1);
      expect(afterHistory.undo.at(-1)).toMatchObject({ id: attempts[1]!.command.commandId, label: 'connector.' + mode, target: { id: recoveryId } }); expect(afterHistory.redo).toEqual(peerHistory.redo);
      console.log('issue26-definite-rejection-recovery', JSON.stringify({ mode, events, attempts, base, successMotion, receipt, after, afterHistory,
        boundary: 'new UUID only; successful explicit command adds one history action; exact connector projection preserves identity, other endpoint and unrelated line; all hosts/content/other domains retained' }));
    } finally { await page.unrouteAll({ behavior: 'wait' }); }
  }
});
