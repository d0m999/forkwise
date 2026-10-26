import { test, expect } from './writing-board-fixture';
import type { Command } from '../../backend/src/mapping/contracts';
import { seedConnectorCard } from './connector-ui-fixture';

test('图片删除丢ACK后只在当前会话重试原闭包', async ({ page, workspace }) => {
  const card = await seedConnectorCard(page, workspace, 'image-ack-protected', 700, 400), projectId = (await workspace.state()).project.id;
  const source = '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="180"><rect width="300" height="180" fill="blue"/></svg>';
  await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'asset.save', expected: null,
    payload: { id: 'image-ack-asset', name: '会话恢复.svg', mime: 'image/svg+xml', base64: Buffer.from(source).toString('base64') } });
  await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'image.create', expected: null,
    payload: { id: 'ack-image', content: { assetId: 'image-ack-asset', crop: { x: 0, y: 0, width: 1, height: 1 } }, pose: { x: 250, y: 190, width: 300, height: 180, rotation: 0 } } });
  const image = (await workspace.state()).images![0]!;
  await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'connector.create', expected: null,
    payload: { id: 'ack-image-line', path: 'straight', start: { kind: 'bound', itemId: image.item.id, side: 'right' }, end: { kind: 'bound', itemId: card.item.id, side: 'left' } } });
  await page.reload(); await expect(page.getByRole('status')).toHaveText('已保存到本机');
  const before = await workspace.state(), incident = before.connectors![0]!, historyUrl = workspace.origin + '/api/mapping/projects/' + encodeURIComponent(projectId) + '/history', history = await (await page.request.get(historyUrl)).json();
  const attempts: { command: Command; status: number; receipt: unknown }[] = [];
  await page.route('**/api/mapping/execute', async route => {
    const command = route.request().postDataJSON(); if (command?.type !== 'image.delete') { await route.continue(); return; }
    const response = await route.fetch(); attempts.push({ command, status: response.status(), receipt: await response.json() });
    if (attempts.length === 1) await route.abort('connectionreset'); else await route.fulfill({ response });
  });
  try {
    const visual = page.getByRole('img', { name: '会话恢复.svg', exact: true }); await visual.click(); await page.getByRole('button', { name: '删除图片', exact: true }).click();
    const retry = page.getByRole('button', { name: '重试图片调整', exact: true }); await expect(retry).toBeVisible(); expect(attempts).toHaveLength(1); expect(attempts[0]!.status).toBe(200);
    expect(attempts[0]!.command).toMatchObject({ type: 'image.delete', payload: { id: image.id }, expected: { image: image.versionId, pose: image.item.versionId, connectors: { [incident.id]: incident.versionId } } });
    const deleted = await workspace.state(); expect(deleted.images).toEqual([]); expect(deleted.connectors).toEqual([]); expect(deleted.cards).toEqual(before.cards); expect((await (await page.request.get(historyUrl)).json()).undo).toHaveLength(history.undo.length + 1);
    await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'connector.create', expected: null,
      payload: { id: 'peer-after-image-delete', path: 'straight', start: { kind: 'free', point: { x: 800, y: 90 } }, end: { kind: 'free', point: { x: 1000, y: 90 } } } });
    const peer = await workspace.state(), peerHistory = await (await page.request.get(historyUrl)).json();
    const confirmed = page.waitForResponse(response => response.url().endsWith('/api/mapping/execute') && response.request().postDataJSON()?.type === 'image.delete');
    await retry.click(); expect((await confirmed).status()).toBe(200); await expect(retry).toHaveCount(0); await expect(visual).toHaveCount(0);
    expect(attempts).toHaveLength(2); expect(attempts[1]).toEqual(attempts[0]); expect(await workspace.state()).toEqual(peer); expect(await (await page.request.get(historyUrl)).json()).toEqual(peerHistory);
    await expect(page.getByRole('button', { name: '普通连线', exact: true })).toHaveCount(1);
    console.log('issue26-image-delete-ack', JSON.stringify({ attempts, incident, peerHistory, recovery: 'current session request owner only; real200 then transport abort and explicit original-command retry; no cross-refresh journal claim' }));
  } finally { await page.unrouteAll({ behavior: 'wait' }); }
});

test('图片删除确认后回读失败仍保留原请求', async ({ page, workspace }) => {
  const card = await seedConnectorCard(page, workspace, 'image-read-protected', 700, 400), projectId = (await workspace.state()).project.id;
  const source = '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="180"><rect width="300" height="180" fill="green"/></svg>';
  await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'asset.save', expected: null,
    payload: { id: 'image-read-asset', name: '删除回读.svg', mime: 'image/svg+xml', base64: Buffer.from(source).toString('base64') } });
  await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'image.create', expected: null,
    payload: { id: 'read-image', content: { assetId: 'image-read-asset', crop: { x: 0, y: 0, width: 1, height: 1 } }, pose: { x: 250, y: 190, width: 300, height: 180, rotation: 0 } } });
  const image = (await workspace.state()).images![0]!;
  await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'connector.create', expected: null,
    payload: { id: 'read-image-line', path: 'straight', start: { kind: 'bound', itemId: image.item.id, side: 'right' }, end: { kind: 'bound', itemId: card.item.id, side: 'left' } } });
  await page.reload(); await expect(page.getByRole('status')).toHaveText('已保存到本机');
  const before = await workspace.state(), incident = before.connectors![0]!, historyUrl = workspace.origin + '/api/mapping/projects/' + encodeURIComponent(projectId) + '/history', history = await (await page.request.get(historyUrl)).json();
  let applied = false, failRead = true; const failedReads: { status: number; view: string | null }[] = [], attempts: { command: Command; status: number; receipt: unknown }[] = [];
  await page.route('**/api/mapping/execute', async route => {
    const command = route.request().postDataJSON(); if (command?.type !== 'image.delete') { await route.continue(); return; }
    const response = await route.fetch(); attempts.push({ command, status: response.status(), receipt: await response.json() }); applied = response.status() === 200; await route.fulfill({ response });
  });
  await page.route('**/api/mapping/projects/' + projectId + '/map?**', async route => {
    const view = new URL(route.request().url()).searchParams.get('view'); if (!applied || !failRead || view !== 'index') { await route.continue(); return; }
    failRead = false; const response = await route.fetch(); failedReads.push({ status: response.status(), view }); await route.abort('connectionreset');
  });
  try {
    const visual = page.getByRole('img', { name: '删除回读.svg', exact: true }); await visual.click(); await page.getByRole('button', { name: '删除图片', exact: true }).click();
    const retry = page.getByRole('button', { name: '重试图片调整', exact: true }); await expect(retry).toBeVisible(); expect(failedReads).toEqual([{ status: 200, view: 'index' }]);
    expect(attempts).toHaveLength(1); expect(attempts[0]).toMatchObject({ status: 200, command: { type: 'image.delete', payload: { id: image.id }, expected: { image: image.versionId, pose: image.item.versionId, connectors: { [incident.id]: incident.versionId } } } });
    await expect(page.getByRole('button', { name: '放弃本次图片调整，保留已保存状态', exact: true })).toHaveCount(0); await expect(page.getByRole('status')).toHaveText('图片布局尚未确认');
    const committed = await workspace.state(), committedHistory = await (await page.request.get(historyUrl)).json();
    expect(committed.images).toEqual([]); expect(committed.connectors).toEqual([]); expect(committed.cards).toEqual(before.cards); expect(committedHistory.undo).toHaveLength(history.undo.length + 1); expect(committedHistory.undo.at(-1)).toMatchObject({ label: 'image.delete', target: { id: image.id } });
    await retry.click(); await expect(retry).toHaveCount(0); await expect(page.getByRole('status')).toHaveText('已保存到本机'); await expect(visual).toHaveCount(0);
    expect(attempts).toHaveLength(2); expect(attempts[1]).toEqual(attempts[0]); expect(failedReads).toHaveLength(1); expect(await workspace.state()).toEqual(committed); expect(await (await page.request.get(historyUrl)).json()).toEqual(committedHistory);
    console.log('issue26-image-delete-read-failure', JSON.stringify({ attempts, failedReads, incident, committedHistory, boundary: 'real execute200 acknowledged; subsequent real map200 transport aborted; explicit original-command retry, no rejection/abandon classification or duplicate history' }));
  } finally { await page.unrouteAll({ behavior: 'wait' }); }
});

test('图片删除未知结果在切项目后按原请求确认', async ({ page, workspace }) => {
  const card = await seedConnectorCard(page, workspace, 'image-project-protected', 700, 400), projectId = (await workspace.state()).project.id;
  const source = '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="180"><rect width="300" height="180" fill="purple"/></svg>';
  await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'asset.save', expected: null,
    payload: { id: 'image-project-asset', name: '原项目删除.svg', mime: 'image/svg+xml', base64: Buffer.from(source).toString('base64') } });
  await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'image.create', expected: null,
    payload: { id: 'project-image', content: { assetId: 'image-project-asset', crop: { x: 0, y: 0, width: 1, height: 1 } }, pose: { x: 250, y: 190, width: 300, height: 180, rotation: 0 } } });
  const image = (await workspace.state()).images![0]!;
  await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'connector.create', expected: null,
    payload: { id: 'project-image-line', path: 'straight', start: { kind: 'bound', itemId: image.item.id, side: 'right' }, end: { kind: 'bound', itemId: card.item.id, side: 'left' } } });
  await page.reload(); await expect(page.getByRole('status')).toHaveText('已保存到本机');
  const read = async (id: string, suffix = '') => (await page.request.get(workspace.origin + '/api/mapping/projects/' + encodeURIComponent(id) + suffix)).json();
  const before = await read(projectId), incident = before.connectors[0], originalHistory = await read(projectId, '/history');
  await page.getByRole('button', { name: '新建研究', exact: true }).click(); await expect.poll(() => new URL(page.url()).searchParams.get('project')).not.toBe(projectId);
  const currentId = new URL(page.url()).searchParams.get('project')!, current = await read(currentId), currentHistory = await read(currentId, '/history');
  await page.locator('[role="tab"]').filter({ has: page.locator('small', { hasText: projectId.slice(0, 6) }) }).click();
  await expect.poll(() => new URL(page.url()).searchParams.get('project')).toBe(projectId);
  const attempts: { command: Command; status: number; receipt: unknown }[] = [];
  await page.route('**/api/mapping/execute', async route => {
    const command = route.request().postDataJSON(); if (command?.type !== 'image.delete') { await route.continue(); return; }
    const response = await route.fetch(); attempts.push({ command, status: response.status(), receipt: await response.json() });
    if (attempts.length === 1) await route.abort('connectionreset'); else await route.fulfill({ response });
  });
  try {
    await page.getByRole('img', { name: '原项目删除.svg', exact: true }).click(); await page.getByRole('button', { name: '删除图片', exact: true }).click();
    const retry = page.getByRole('button', { name: '重试图片调整', exact: true }); await expect(retry).toBeVisible(); expect(attempts).toHaveLength(1); expect(attempts[0]!.status).toBe(200);
    expect(attempts[0]!.command).toMatchObject({ projectId, type: 'image.delete', payload: { id: image.id }, expected: { image: image.versionId, pose: image.item.versionId, connectors: { [incident.id]: incident.versionId } } });
    const committed = await read(projectId), committedHistory = await read(projectId, '/history'); expect(committed.images).toEqual([]); expect(committed.connectors).toEqual([]); expect(committed.cards).toEqual(before.cards); expect(committedHistory.undo).toHaveLength(originalHistory.undo.length + 1);
    const currentTab = page.locator('[role="tab"]').filter({ has: page.locator('small', { hasText: currentId.slice(0, 6) }) }); await currentTab.click();
    await expect(currentTab).toHaveAttribute('aria-selected', 'true'); expect(new URL(page.url()).searchParams.get('project')).toBe(currentId); await expect(retry).toBeVisible(); await expect(page.getByRole('status')).not.toHaveText('已保存到本机');
    expect(attempts).toHaveLength(1); expect(await read(currentId)).toEqual(current); expect(await read(currentId, '/history')).toEqual(currentHistory);
    await retry.click(); await expect(retry).toHaveCount(0); await expect(page.getByRole('status')).toHaveText('已保存到本机');
    expect(attempts).toHaveLength(2); expect(attempts[1]).toEqual(attempts[0]); await expect(currentTab).toHaveAttribute('aria-selected', 'true'); expect(new URL(page.url()).searchParams.get('project')).toBe(currentId);
    expect(await read(currentId)).toEqual(current); expect(await read(currentId, '/history')).toEqual(currentHistory); expect(await read(projectId)).toEqual(committed); expect(await read(projectId, '/history')).toEqual(committedHistory); await expect(page.getByRole('img', { name: '原项目删除.svg', exact: true })).toHaveCount(0);
    console.log('issue26-image-delete-project', JSON.stringify({ attempts, incident, originalProjectId: projectId, currentId, current, currentHistory, committedHistory, boundary: 'unknown deletion result retained in same session across project switch; explicit original command confirmation does not switch back or mutate current project' }));
  } finally { await page.unrouteAll({ behavior: 'wait' }); }
});
