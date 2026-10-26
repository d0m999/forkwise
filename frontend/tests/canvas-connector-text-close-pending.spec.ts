import { test, expect } from './writing-board-fixture';
import type { Command, Receipt } from '../../backend/src/mapping/contracts';
import { seedConnectorCard } from './connector-ui-fixture';

test('文字保存ACK在途后清空结束不会把后来同步的关联线纳入删除', async ({ page, workspace }) => {
  const card = await seedConnectorCard(page, workspace, 'pending-text-protected', 700, 400);
  const projectId = (await workspace.state()).project.id;
  await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'text.create', expected: null,
    payload: { id: 'pending-close-text', content: { runs: [{ text: '原始文字' }], fontSize: 18, lineHeight: 1.5, align: 'left', widthMode: 'fixed', width: 260 }, pose: { x: 250, y: 190, width: 260, height: 27 } } });
  const original = (await workspace.state()).texts![0]!;
  await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'connector.create', expected: null,
    payload: { id: 'pending-close-original-line', path: 'straight', start: { kind: 'bound', itemId: original.item.id, side: 'right' }, end: { kind: 'bound', itemId: card.item.id, side: 'left' } } });
  await page.reload(); await expect(page.getByRole('status')).toHaveText('已保存到本机');
  const before = await workspace.state(), incident = before.connectors![0]!;
  const historyUrl = workspace.origin + '/api/mapping/projects/' + encodeURIComponent(projectId) + '/history';
  let releaseAck = () => {}, releaseSync = () => {}, blockedSync = 0;
  const ackGate = new Promise<void>(resolve => { releaseAck = resolve; });
  const syncGate = new Promise<void>(resolve => { releaseSync = resolve; });
  const saves: { command: Command; status: number; receipt: Receipt }[] = [];
  const deletes: { command: Command; status: number; body: unknown }[] = [];
  await page.route('**/api/mapping/projects/*/changes?*', async route => {
    blockedSync++; await syncGate; await route.continue();
  });
  await page.route('**/api/mapping/execute', async route => {
    const command = route.request().postDataJSON() as Command;
    if ((command.type !== 'text.edit' && command.type !== 'text.delete') || command.payload.id !== original.id) {
      await route.continue(); return;
    }
    const response = await route.fetch();
    if (command.type === 'text.edit') {
      saves.push({ command, status: response.status(), receipt: await response.json() });
      await ackGate;
    } else deletes.push({ command, status: response.status(), body: await response.json() });
    await route.fulfill({ response });
  });
  try {
    await expect.poll(() => blockedSync).toBeGreaterThan(0);
    await page.locator('.canvas-text-content').dblclick();
    const editor = page.getByRole('textbox', { name: '独立文字', exact: true });
    await editor.fill('已经真实保存但响应仍在途');
    await expect.poll(() => saves.length).toBe(1); expect(saves[0]!.status).toBe(200);
    const saved = await workspace.state();
    expect(saved.texts![0]!.versionId).toBe(saves[0]!.receipt.textVersions!.text);
    expect(saved.texts![0]!.content.runs.map(run => run.text).join('')).toBe('已经真实保存但响应仍在途');
    expect(saved.connectors).toEqual(before.connectors);
    await editor.fill(' \n '); await editor.press('Escape'); expect(deletes).toEqual([]);
    await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'connector.create', expected: null,
      payload: { id: 'pending-close-peer-line', path: 'straight', start: { kind: 'bound', itemId: original.item.id, side: 'top' }, end: { kind: 'free', point: { x: 600, y: 90 } } } });
    const peer = await workspace.state(), peerHistory = await (await page.request.get(historyUrl)).json();
    releaseSync();
    await expect(page.locator('.workspace')).toHaveAttribute('data-revision', String(peer.project.revision));
    await expect(page.getByRole('button', { name: '普通连线', exact: true })).toHaveCount(2);
    const responsePromise = page.waitForResponse(response => response.url().endsWith('/api/mapping/execute') && response.request().postDataJSON()?.type === 'text.delete');
    releaseAck(); const response = await responsePromise;
    const after = await workspace.state(), afterHistory = await (await page.request.get(historyUrl)).json();
    console.log('issue26-pending-text-close', JSON.stringify({ before, saved, saves, peer, peerHistory, deletes, after, afterHistory,
      boundary: 'real text.edit200 ACK held, blank Escape, real peer connector.create, ordinary sync published peer revision, then original ACK delivered; no synthetic successful response or private-state mutation' }));
    expect(response.status(), '结束编辑后新增的关联线必须使原删除范围冲突').toBe(409);
    expect(deletes).toHaveLength(1);
    expect(deletes[0]!.command).toMatchObject({ type: 'text.delete', payload: { id: original.id }, expected: {
      text: saves[0]!.receipt.textVersions!.text, pose: original.item.versionId, connectors: { [incident.id]: incident.versionId } } });
    await expect(page.getByRole('region', { name: '独立文字保存冲突', exact: true })).toBeVisible();
    expect(after).toEqual(peer); expect(afterHistory).toEqual(peerHistory);
  } finally { releaseSync(); releaseAck(); await page.unrouteAll({ behavior: 'wait' }); }
});

test('先结束非空文字后继续清空需再次明确结束才删除关联线', async ({ page, workspace }) => {
  const card = await seedConnectorCard(page, workspace, 'continued-text-protected', 700, 400);
  const projectId = (await workspace.state()).project.id;
  await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'text.create', expected: null,
    payload: { id: 'continued-close-text', content: { runs: [{ text: '原始文字' }], fontSize: 18, lineHeight: 1.5, align: 'left', widthMode: 'fixed', width: 260 }, pose: { x: 250, y: 190, width: 260, height: 27 } } });
  const original = (await workspace.state()).texts![0]!;
  await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'connector.create', expected: null,
    payload: { id: 'continued-close-original-line', path: 'straight', start: { kind: 'bound', itemId: original.item.id, side: 'right' }, end: { kind: 'bound', itemId: card.item.id, side: 'left' } } });
  await page.reload(); await expect(page.getByRole('status')).toHaveText('已保存到本机');
  const before = await workspace.state(), historyUrl = workspace.origin + '/api/mapping/projects/' + encodeURIComponent(projectId) + '/history';
  let releaseAck = () => {}, releaseSync = () => {}, blockedSync = 0, deleteCompleted = () => {};
  const ackGate = new Promise<void>(resolve => { releaseAck = resolve; });
  const syncGate = new Promise<void>(resolve => { releaseSync = resolve; });
  const deleted = new Promise<'deleted'>(resolve => { deleteCompleted = () => resolve('deleted'); });
  const saves: { command: Command; status: number; receipt: Receipt }[] = [];
  const deletes: { command: Command; status: number; body: unknown }[] = [];
  await page.route('**/api/mapping/projects/*/changes?*', async route => { blockedSync++; await syncGate; await route.continue(); });
  await page.route('**/api/mapping/execute', async route => {
    const command = route.request().postDataJSON() as Command;
    if ((command.type !== 'text.edit' && command.type !== 'text.delete') || command.payload.id !== original.id) { await route.continue(); return; }
    const response = await route.fetch();
    if (command.type === 'text.edit') {
      saves.push({ command, status: response.status(), receipt: await response.json() }); await ackGate;
    } else deletes.push({ command, status: response.status(), body: await response.json() });
    await route.fulfill({ response }); if (command.type === 'text.delete') deleteCompleted();
  });
  try {
    await expect.poll(() => blockedSync).toBeGreaterThan(0);
    await page.locator('.canvas-text-content').dblclick();
    const editor = page.getByRole('textbox', { name: '独立文字', exact: true });
    await editor.fill('非空结束时的保存稿'); await expect.poll(() => saves.length).toBe(1); expect(saves[0]!.status).toBe(200);
    await editor.press('Escape'); await expect(editor).toBeVisible();
    await editor.fill(' \n ');
    await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'connector.create', expected: null,
      payload: { id: 'continued-close-peer-line', path: 'straight', start: { kind: 'bound', itemId: original.item.id, side: 'top' }, end: { kind: 'free', point: { x: 600, y: 90 } } } });
    const peer = await workspace.state(), peerHistory = await (await page.request.get(historyUrl)).json();
    releaseSync(); await expect(page.locator('.workspace')).toHaveAttribute('data-revision', String(peer.project.revision));
    await expect(page.getByRole('button', { name: '普通连线', exact: true })).toHaveCount(2);
    const retained = page.getByLabel('创作工具', { exact: true }).getByText('文字已变化，请再次明确结束编辑', { exact: true }).waitFor({ state: 'visible' }).then(() => 'retained' as const);
    const acknowledged = page.waitForResponse(response => response.url().endsWith('/api/mapping/execute') && response.request().postDataJSON()?.commandId === saves[0]!.command.commandId);
    releaseAck(); await acknowledged; const completion = await Promise.race([deleted, retained]);
    const afterFirst = await workspace.state(), afterFirstHistory = await (await page.request.get(historyUrl)).json();
    console.log('issue26-nonempty-close-first', JSON.stringify({ before, saves, peer, peerHistory, completion, deletes, afterFirst, afterFirstHistory,
      boundary: 'nonempty Escape first, then continued blank input without another finish; real peer line and sync precede original successful save ACK' }));
    expect(completion, '较早的非空结束不能把后来输入变成删除').toBe('retained');
    expect(deletes).toEqual([]); expect(afterFirst).toEqual(peer); expect(afterFirstHistory).toEqual(peerHistory);
    await expect(editor).toBeVisible(); expect((await editor.innerText()).trim()).toBe('');
    const explicit = page.waitForResponse(response => response.url().endsWith('/api/mapping/execute') && response.request().postDataJSON()?.type === 'text.delete');
    await editor.press('Escape'); const response = await explicit; expect(response.status()).toBe(200);
    await expect(editor).toHaveCount(0); const after = await workspace.state(), afterHistory = await (await page.request.get(historyUrl)).json();
    expect(deletes).toHaveLength(1);
    expect(deletes[0]!.command).toMatchObject({ expected: { text: saves[0]!.receipt.textVersions!.text, pose: original.item.versionId,
      connectors: Object.fromEntries(peer.connectors!.map(line => [line.id, line.versionId])) } });
    expect(after.texts).toEqual([]); expect(after.connectors).toEqual([]); expect(after.cards).toEqual(peer.cards);
    expect(after.project.revision).toBe(peer.project.revision + 1); expect(afterHistory.undo).toHaveLength(peerHistory.undo.length + 1);
    console.log('issue26-nonempty-close-explicit', JSON.stringify({ deletes, after, afterHistory, explicitNewFinish: true }));
  } finally { releaseSync(); releaseAck(); await page.unrouteAll({ behavior: 'wait' }); }
});
