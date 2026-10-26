import { test, expect } from './writing-board-fixture';
import type { Command } from '../../backend/src/mapping/contracts';
import { seedConnectorCard } from './connector-ui-fixture';

test('清空文字删除丢ACK后重开明确恢复原命令', async ({ page, workspace }) => {
  const card = await seedConnectorCard(page, workspace, 'text-ack-protected', 700, 400), projectId = (await workspace.state()).project.id;
  await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'text.create', expected: null,
    payload: { id: 'ack-text', content: { runs: [{ text: '删除恢复文字' }], fontSize: 18, lineHeight: 1.5, align: 'left', widthMode: 'fixed', width: 260 }, pose: { x: 250, y: 190, width: 260, height: 27 } } });
  const text = (await workspace.state()).texts![0]!;
  await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'connector.create', expected: null,
    payload: { id: 'ack-text-line', path: 'straight', start: { kind: 'bound', itemId: text.item.id, side: 'right' }, end: { kind: 'bound', itemId: card.item.id, side: 'left' } } });
  await page.reload(); await expect(page.getByRole('status')).toHaveText('已保存到本机');
  const before = await workspace.state(), original = before.texts![0]!, incident = before.connectors![0]!, historyUrl = workspace.origin + '/api/mapping/projects/' + encodeURIComponent(projectId) + '/history', history = await (await page.request.get(historyUrl)).json();
  const attempts: { command: Command; status: number; receipt: unknown }[] = [];
  await page.route('**/api/mapping/execute', async route => {
    const command = route.request().postDataJSON(); if (command?.type !== 'text.delete') { await route.continue(); return; }
    const response = await route.fetch(); attempts.push({ command, status: response.status(), receipt: await response.json() });
    if (attempts.length === 1) await route.abort('connectionreset'); else await route.fulfill({ response });
  });
  try {
    await page.locator('.canvas-text-content').dblclick(); const editor = page.getByRole('textbox', { name: '独立文字', exact: true }); await editor.fill(' \n  '); await editor.press('Escape');
    await expect(page.getByRole('button', { name: '重试文字保存', exact: true })).toBeVisible(); expect(attempts).toHaveLength(1); expect(attempts[0]!.status).toBe(200);
    expect(attempts[0]!.command).toMatchObject({ type: 'text.delete', expected: { text: original.versionId, pose: original.item.versionId, connectors: { [incident.id]: incident.versionId } }, payload: { id: original.id } });
    const journalCommand = await page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('forkwise:text-recovery:v1:')).map(key => JSON.parse(localStorage.getItem(key)!)).find(value => value.pending?.command.type === 'text.delete')?.pending.command);
    expect(journalCommand).toEqual(attempts[0]!.command);
    const deleted = await workspace.state(), deletedHistory = await (await page.request.get(historyUrl)).json(); expect(deleted.texts).toEqual([]); expect(deleted.connectors).toEqual([]); expect(deleted.cards).toEqual(before.cards); expect(deletedHistory.undo).toHaveLength(history.undo.length + 1);
    await workspace.restart(); page.once('dialog', dialog => dialog.accept()); await page.reload();
    const recover = page.getByRole('button', { name: '恢复独立文字草稿', exact: true }); await expect(recover).toBeVisible(); expect(attempts).toHaveLength(1); expect(await workspace.state()).toEqual(deleted);
    const confirmed = page.waitForResponse(response => response.url().endsWith('/api/mapping/execute') && response.request().postDataJSON()?.type === 'text.delete');
    await recover.click(); expect((await confirmed).status()).toBe(200); await expect(recover).toHaveCount(0); await expect(page.locator('.canvas-text')).toHaveCount(0);
    expect(attempts).toHaveLength(2); expect(attempts[1]).toEqual(attempts[0]); expect(await workspace.state()).toEqual(deleted); expect(await (await page.request.get(historyUrl)).json()).toEqual(deletedHistory);
    await expect(page.getByRole('status')).toHaveText('已保存到本机');
    const journalsLeft = await page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('forkwise:text-recovery:v1:'))); expect(journalsLeft).toEqual([]);
    console.log('issue26-text-delete-reopen', JSON.stringify({ attempts, journalCommand, incident, deletedHistory, recovery: 'same-database actual restart, reload without automatic execute, explicit original pending adoption' }));
  } finally { await page.unrouteAll({ behavior: 'wait' }); }
});

test('文字删除确定冲突后明确采用本地才冻结新闭包', async ({ page, workspace }) => {
  const card = await seedConnectorCard(page, workspace, 'text-conflict-protected', 700, 400), projectId = (await workspace.state()).project.id;
  await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'text.create', expected: null,
    payload: { id: 'conflicted-text', content: { runs: [{ text: '冲突前的完整文字' }], fontSize: 18, lineHeight: 1.5, align: 'left', widthMode: 'fixed', width: 260 }, pose: { x: 250, y: 190, width: 260, height: 27 } } });
  const text = (await workspace.state()).texts![0]!;
  await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'connector.create', expected: null,
    payload: { id: 'old-text-incident', path: 'straight', start: { kind: 'bound', itemId: text.item.id, side: 'right' }, end: { kind: 'bound', itemId: card.item.id, side: 'left' } } });
  await page.reload(); await expect(page.getByRole('status')).toHaveText('已保存到本机');
  const before = await workspace.state(), original = before.texts![0]!, incident = before.connectors![0]!, historyUrl = workspace.origin + '/api/mapping/projects/' + encodeURIComponent(projectId) + '/history';
  let releaseInitial = () => {}; const gate = new Promise<void>(resolve => { releaseInitial = resolve; });
  const commands: Command[] = [], attempts: { command: Command; status: number; body: unknown }[] = [];
  await page.route('**/api/mapping/execute', async route => {
    const command = route.request().postDataJSON(); if (command?.type !== 'text.delete') { await route.continue(); return; }
    commands.push(command); if (commands.length === 1) await gate;
    const response = await route.fetch(); attempts.push({ command, status: response.status(), body: await response.json() }); await route.fulfill({ response });
  });
  try {
    await page.locator('.canvas-text-content').dblclick(); const editor = page.getByRole('textbox', { name: '独立文字', exact: true }); await editor.fill(' \n  ');
    const refused = page.waitForResponse(response => response.url().endsWith('/api/mapping/execute') && response.request().postDataJSON()?.type === 'text.delete');
    await editor.press('Escape'); await expect.poll(() => commands.length).toBe(1);
    await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'connector.create', expected: null,
      payload: { id: 'new-text-incident', path: 'straight', start: { kind: 'bound', itemId: original.item.id, side: 'top' }, end: { kind: 'free', point: { x: 600, y: 90 } } } });
    const peer = await workspace.state(), added = peer.connectors!.find(value => value.id === 'new-text-incident')!, peerHistory = await (await page.request.get(historyUrl)).json();
    releaseInitial(); expect((await refused).status()).toBe(409);
    const panel = page.getByRole('region', { name: '独立文字保存冲突', exact: true }); await expect(panel).toBeVisible(); await expect(panel.getByRole('textbox', { name: '已保存的独立文字', exact: true })).toHaveValue('冲突前的完整文字');
    expect(commands).toHaveLength(1); expect(commands[0]).toMatchObject({ expected: { text: original.versionId, pose: original.item.versionId, connectors: { [incident.id]: incident.versionId } } });
    expect(await workspace.state()).toEqual(peer); expect(await (await page.request.get(historyUrl)).json()).toEqual(peerHistory);
    const replaced = page.waitForResponse(response => response.url().endsWith('/api/mapping/execute') && response.request().postDataJSON()?.type === 'text.delete' && response.request().postDataJSON()?.commandId !== commands[0]!.commandId);
    await panel.getByRole('button', { name: '确认保留我的文字', exact: true }).click(); const response = await replaced; expect(response.status(), '明确采用本地删除必须使用已展示remote同投影的新闭包').toBe(200);
    await expect(panel).toHaveCount(0); const after = await workspace.state();
    expect(commands).toHaveLength(2); expect(commands[1]!.commandId).not.toBe(commands[0]!.commandId); expect(commands[1]).toMatchObject({ type: 'text.delete', payload: { id: original.id }, expected: { text: original.versionId, pose: original.item.versionId, connectors: { [incident.id]: incident.versionId, [added.id]: added.versionId } } });
    expect(after.connectors).toEqual([]); expect(after.texts).toHaveLength(1); expect(after.texts![0]!.id).not.toBe(original.id); expect(after.texts![0]!.content).toEqual(original.content); expect(after.cards).toEqual(before.cards);
    const afterHistory = await (await page.request.get(historyUrl)).json(); expect(afterHistory.undo).toHaveLength(peerHistory.undo.length + 2); expect(afterHistory.undo.at(-1)).toMatchObject({ label: 'text.delete', target: { id: original.id } });
    console.log('issue26-text-delete-conflict', JSON.stringify({ commands, attempts, original, incident, added, backup: after.texts![0], peerHistory, afterHistory, recovery: 'real409 then explicit mine; preserved remote backup and new delete identity with displayed snapshot closure' }));
  } finally { releaseInitial(); await page.unrouteAll({ behavior: 'wait' }); }
});

test('文字删除冲突处理未知ACK时保留原解决命令', async ({ page, workspace }) => {
  const card = await seedConnectorCard(page, workspace, 'resolution-protected', 700, 400), projectId = (await workspace.state()).project.id;
  await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'text.create', expected: null,
    payload: { id: 'resolution-text', content: { runs: [{ text: '冲突确认原请求' }], fontSize: 18, lineHeight: 1.5, align: 'left', widthMode: 'fixed', width: 260 }, pose: { x: 250, y: 190, width: 260, height: 27 } } });
  const original = (await workspace.state()).texts![0]!;
  await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'connector.create', expected: null,
    payload: { id: 'resolution-incident', path: 'straight', start: { kind: 'bound', itemId: original.item.id, side: 'right' }, end: { kind: 'bound', itemId: card.item.id, side: 'left' } } });
  await page.reload(); await expect(page.getByRole('status')).toHaveText('已保存到本机');
  let releaseInitial = () => {}; const gate = new Promise<void>(resolve => { releaseInitial = resolve; });
  const attempts: { command: Command; status: number; receipt: unknown }[] = []; let deletes = 0;
  await page.route('**/api/mapping/execute', async route => {
    const command = route.request().postDataJSON(); if (command?.type !== 'text.delete' && command?.type !== 'text.create') { await route.continue(); return; }
    if (command.type === 'text.delete') { deletes++; if (deletes === 1) await gate; }
    const response = await route.fetch(); attempts.push({ command, status: response.status(), receipt: await response.json() });
    if (command.type === 'text.delete' && deletes === 2) await route.abort('connectionreset'); else await route.fulfill({ response });
  });
  try {
    await page.locator('.canvas-text-content').dblclick(); const editor = page.getByRole('textbox', { name: '独立文字', exact: true }); await editor.fill(' \n '); await editor.press('Escape');
    await expect.poll(() => deletes).toBe(1);
    await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'connector.create', expected: null,
      payload: { id: 'resolution-new-incident', path: 'straight', start: { kind: 'bound', itemId: original.item.id, side: 'top' }, end: { kind: 'free', point: { x: 600, y: 90 } } } });
    const displayed = await workspace.state(), expectedMap = Object.fromEntries(displayed.connectors!.map(line => [line.id, line.versionId])); releaseInitial();
    const panel = page.getByRole('region', { name: '独立文字保存冲突', exact: true }); await expect(panel).toBeVisible();
    await panel.getByRole('button', { name: '确认保留我的文字', exact: true }).click(); await expect(page.getByRole('status')).toHaveText('文字保存未完成');
    const deleteAttempts = attempts.filter(value => value.command.type === 'text.delete'); expect(deleteAttempts.map(value => value.status)).toEqual([409, 200]);
    const pending = await page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('forkwise:text-conflict-recovery:v1:')).map(key => JSON.parse(localStorage.getItem(key)!)).find(value => value.value.resolution)?.value.resolution);
    expect(pending.replace).toEqual(deleteAttempts[1]!.command); expect(pending.replace).toMatchObject({ expected: { connectors: expectedMap } });
    expect(pending.copy).toEqual(attempts.find(value => value.command.type === 'text.create')!.command);
    const committed = await workspace.state(); expect(committed.texts).toHaveLength(1); expect(committed.texts![0]!.id).not.toBe(original.id); expect(committed.connectors).toEqual([]); expect(committed.cards).toEqual(displayed.cards);
    await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'connector.create', expected: null,
      payload: { id: 'resolution-peer-after-ack', path: 'straight', start: { kind: 'free', point: { x: 900, y: 50 } }, end: { kind: 'free', point: { x: 1000, y: 80 } } } });
    const peer = await workspace.state(), historyUrl = workspace.origin + '/api/mapping/projects/' + encodeURIComponent(projectId) + '/history', history = await (await page.request.get(historyUrl)).json();
    await panel.getByRole('button', { name: '确认保留我的文字', exact: true }).click(); await expect(panel).toHaveCount(0); await expect(page.getByRole('status')).toHaveText('已保存到本机');
    const retriedDeletes = attempts.filter(value => value.command.type === 'text.delete'), copies = attempts.filter(value => value.command.type === 'text.create');
    expect(retriedDeletes).toHaveLength(3); expect(retriedDeletes[2]).toEqual(retriedDeletes[1]); expect(copies).toHaveLength(2); expect(copies[1]).toEqual(copies[0]);
    expect(await workspace.state()).toEqual(peer); expect(await (await page.request.get(historyUrl)).json()).toEqual(history);
    expect(await page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('forkwise:text-conflict-recovery:v1:')))).toEqual([]);
    console.log('issue26-text-resolution-ack', JSON.stringify({ attempts, pending, expectedMap, committed, peer, history, retry: 'real successful replacement ACK lost; original copy and replacement receipts retried unchanged after peer write' }));
  } finally { releaseInitial(); await page.unrouteAll({ behavior: 'wait' }); }
});

test('旧文字删除pending缺省connectors时不自动补闭包', async ({ page, workspace }) => {
  const card = await seedConnectorCard(page, workspace, 'legacy-protected', 700, 400), projectId = (await workspace.state()).project.id;
  await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'text.create', expected: null,
    payload: { id: 'legacy-text', content: { runs: [{ text: '旧格式删除原请求' }], fontSize: 18, lineHeight: 1.5, align: 'left', widthMode: 'fixed', width: 260 }, pose: { x: 250, y: 190, width: 260, height: 27 } } });
  const original = (await workspace.state()).texts![0]!, group = crypto.randomUUID();
  const command = { commandId: crypto.randomUUID(), projectId, type: 'text.delete', expected: { text: original.versionId, pose: original.item.versionId }, editGroup: group, payload: { id: original.id } };
  const session = { projectId, value: original, content: { ...original.content, runs: [{ text: '' }] }, group, generation: 1, confirmed: 0 };
  const legacy = { schema: 1, session, pending: { session, command } }, legacyKey = 'forkwise:text-recovery:v1:issue26-legacy';
  await page.evaluate(({ key, value }) => localStorage.setItem(key, JSON.stringify(value)), { key: legacyKey, value: legacy });
  await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'connector.create', expected: null,
    payload: { id: 'legacy-later-incident', path: 'straight', start: { kind: 'bound', itemId: original.item.id, side: 'right' }, end: { kind: 'bound', itemId: card.item.id, side: 'left' } } });
  const before = await workspace.state(), historyUrl = workspace.origin + '/api/mapping/projects/' + encodeURIComponent(projectId) + '/history', history = await (await page.request.get(historyUrl)).json();
  const attempts: { command: Command; status: number; body: unknown }[] = [];
  await page.route('**/api/mapping/execute', async route => {
    const submitted = route.request().postDataJSON(); if (submitted?.type !== 'text.delete') { await route.continue(); return; }
    const response = await route.fetch(); attempts.push({ command: submitted, status: response.status(), body: await response.json() }); await route.fulfill({ response });
  });
  try {
    await page.reload(); const recover = page.getByRole('button', { name: '恢复独立文字草稿', exact: true }); await expect(recover).toHaveCount(1);
    expect(attempts).toEqual([]); expect(await page.evaluate(key => JSON.parse(localStorage.getItem(key)!), legacyKey)).toEqual(legacy); expect(await workspace.state()).toEqual(before);
    await recover.click(); const panel = page.getByRole('region', { name: '独立文字保存冲突', exact: true }); await expect(panel).toBeVisible();
    expect(attempts).toHaveLength(1); expect(attempts[0]!.command).toEqual(command); expect(attempts[0]!.command.expected).not.toHaveProperty('connectors');
    expect(attempts[0]).toMatchObject({ status: 409, body: { code: 'VERSION_CONFLICT', message: '相连连线范围或版本已更新，请重新读取' } });
    expect(await workspace.state()).toEqual(before); expect(await (await page.request.get(historyUrl)).json()).toEqual(history);
    const rejected = await page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('forkwise:text-conflict-recovery:v1:')).map(key => JSON.parse(localStorage.getItem(key)!)).find(value => value.value.rejected.commandId)?.value.rejected);
    expect(rejected).toEqual(command); expect(Object.hasOwn(rejected.expected, 'connectors')).toBe(false);
    console.log('issue26-legacy-text-pending', JSON.stringify({ legacy, attempts, rejected, before, history, boundary: 'explicit legacy pending fixture, original JSON retained through parser/adoption/real409; no silent closure expansion or delete' }));
  } finally { await page.unrouteAll({ behavior: 'wait' }); }
});
