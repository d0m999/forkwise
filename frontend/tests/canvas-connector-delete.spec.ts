import { test, expect } from './writing-board-fixture';
import type { Command } from '../../backend/src/mapping/contracts';
import { connectorCardPair, connectorSvgEnds, seedConnectorCard, connectorDirtyCardDelete } from './connector-ui-fixture';

test('删除普通连线保留端点对象并可一步撤销重开', async ({ page, workspace }) => {
  const pair = await connectorCardPair(page, workspace), projectId = (await workspace.state()).project.id;
  await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'connector.create', expected: null,
    payload: { id: 'deleted-line', path: 'straight', start: pair.expected.start, end: pair.expected.end } });
  await page.reload(); await expect(page.getByRole('status')).toHaveText('已保存到本机');
  const before = await workspace.state(), original = before.connectors![0]!, line = page.getByRole('button', { name: '普通连线', exact: true });
  const initial = await connectorSvgEnds(line.locator('path')), historyUrl = workspace.origin + '/api/mapping/projects/' + encodeURIComponent(projectId) + '/history';
  const history = await (await page.request.get(historyUrl)).json(), commands: Command[] = [];
  const record = (request: import('@playwright/test').Request) => { if (request.url().endsWith('/api/mapping/execute') && request.postDataJSON()?.type === 'connector.delete') commands.push(request.postDataJSON()); };
  page.on('request', record);
  try {
    await line.click(); const remove = page.getByRole('button', { name: '删除连线', exact: true });
    expect(await remove.count(), '选中普通连线必须提供明确的删除入口').toBe(1);
    const saved = page.waitForResponse(response => response.url().endsWith('/api/mapping/execute') && response.request().postDataJSON()?.type === 'connector.delete');
    await remove.click(); const response = await saved; expect(response.status()).toBe(200); const receipt = await response.json();
    await expect(line).toHaveCount(0); const deleted = await workspace.state();
    expect(commands).toEqual([expect.objectContaining({ type: 'connector.delete', projectId, expected: original.versionId, payload: { id: original.id } })]);
    expect(receipt.deletedIds).toEqual([original.id]); expect(deleted.connectors).toEqual([]);
    for (const key of ['cards', 'tags', 'texts', 'shapes', 'strokes', 'images'] as const) expect(deleted[key]).toEqual(before[key]);
    const deletedHistory = await (await page.request.get(historyUrl)).json(); expect(deletedHistory.undo).toHaveLength(history.undo.length + 1);
    expect(deletedHistory.undo.at(-1)).toMatchObject({ label: 'connector.delete', target: { id: original.id } });
    const undo = page.waitForResponse(value => value.url().endsWith('/api/mapping/execute') && value.request().postDataJSON()?.type === 'history.undo');
    await page.getByRole('button', { name: '撤销', exact: true }).click(); expect((await undo).status()).toBe(200); await expect(line).toBeVisible();
    const restored = await workspace.state(), restoredHistory = await (await page.request.get(historyUrl)).json();
    expect(restored.connectors).toEqual([expect.objectContaining({ id: original.id, kind: original.kind, path: original.path, start: original.start, end: original.end })]);
    expect(restored.cards).toEqual(before.cards); expect(restoredHistory.undo).toHaveLength(history.undo.length); expect(restoredHistory.redo).toHaveLength(1);
    expect(await connectorSvgEnds(line.locator('path'))).toEqual(initial);
    await workspace.restart(); await workspace.open(page); expect(await workspace.state()).toEqual(restored); expect(await (await page.request.get(historyUrl)).json()).toEqual(restoredHistory);
    await expect(line).toBeVisible(); expect(await connectorSvgEnds(line.locator('path'))).toEqual(initial); expect(commands).toHaveLength(1);
    console.log('issue26-line-delete', JSON.stringify({ commands, receipt, original, restored: restored.connectors![0], protectedCards: restored.cards, initial, deletedHistory, restoredHistory, persistence: 'same-database actual server restart and served UI reopen' }));
  } finally { page.off('request', record); }
});

test('删除卡片同时删除相连线并一步恢复原身份', async ({ page, workspace }) => {
  const pair = await connectorCardPair(page, workspace), projectId = (await workspace.state()).project.id;
  await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'connector.create', expected: null,
    payload: { id: 'card-incident-line', path: 'straight', start: pair.expected.start, end: pair.expected.end } });
  await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'connector.create', expected: null,
    payload: { id: 'unrelated-line', path: 'straight', start: { kind: 'free', point: { x: 800, y: 90 } }, end: { kind: 'free', point: { x: 1000, y: 90 } } } });
  await page.reload(); await expect(page.getByRole('status')).toHaveText('已保存到本机');
  const before = await workspace.state(), card = before.cards.find(value => value.id === pair.a.id)!, incident = before.connectors!.find(value => value.id === 'card-incident-line')!, unrelated = before.connectors!.find(value => value.id === 'unrelated-line')!;
  const historyUrl = workspace.origin + '/api/mapping/projects/' + encodeURIComponent(projectId) + '/history', history = await (await page.request.get(historyUrl)).json(), commands: Command[] = [];
  const record = (request: import('@playwright/test').Request) => { if (request.url().endsWith('/api/mapping/execute') && request.postDataJSON()?.type === 'thought.delete') commands.push(request.postDataJSON()); };
  page.on('request', record);
  try {
    await page.locator('.thought-card').first().locator('.title-button').click(); await page.getByRole('toolbar', { name: '卡片操作' }).getByRole('button', { name: '更多', exact: true }).click();
    const saved = page.waitForResponse(response => response.url().endsWith('/api/mapping/execute') && response.request().postDataJSON()?.type === 'thought.delete');
    await page.getByRole('dialog', { name: '更多', exact: true }).getByRole('button', { name: '删除卡片', exact: true }).click();
    const response = await saved; expect(response.status(), '删除卡片必须提交同投影的精确关联线闭包').toBe(200); const receipt = await response.json();
    await expect(page.locator('.thought-card')).toHaveCount(1); const deleted = await workspace.state();
    expect(commands).toEqual([expect.objectContaining({ type: 'thought.delete', payload: { id: card.id }, expected: {
      thought: card.versionId, body: card.body.versionId, pose: card.item.versionId, appearance: card.appearance?.versionId ?? null, cardTags: card.cardTags?.versionId ?? null, connectors: { [incident.id]: incident.versionId } } })]);
    expect(deleted.cards).toEqual(before.cards.filter(value => value.id !== card.id)); expect(deleted.connectors).toEqual([unrelated]);
    expect(receipt.deletedIds).toEqual(expect.arrayContaining([card.id, incident.id])); expect(receipt.deletedIds).not.toContain(unrelated.id);
    for (const key of ['tags', 'texts', 'shapes', 'strokes', 'images'] as const) expect(deleted[key]).toEqual(before[key]);
    const afterHistory = await (await page.request.get(historyUrl)).json(); expect(afterHistory.undo).toHaveLength(history.undo.length + 1); expect(afterHistory.undo.at(-1)).toMatchObject({ label: 'thought.delete', target: { id: card.id } });
    const undo = page.waitForResponse(value => value.url().endsWith('/api/mapping/execute') && value.request().postDataJSON()?.type === 'history.undo');
    await page.getByRole('button', { name: '撤销', exact: true }).click(); expect((await undo).status()).toBe(200); await expect(page.locator('.thought-card')).toHaveCount(2);
    const restored = await workspace.state(); expect(restored.cards.find(value => value.id === card.id)).toMatchObject({ id: card.id, title: card.title, body: { id: card.body.id, blocks: card.body.blocks }, item: { id: card.item.id, pose: card.item.pose } });
    expect(restored.cards.find(value => value.id === pair.b.id)).toEqual(before.cards.find(value => value.id === pair.b.id));
    expect(restored.connectors).toEqual(expect.arrayContaining([unrelated, expect.objectContaining({ id: incident.id, path: incident.path, start: incident.start, end: incident.end })])); expect(restored.connectors).toHaveLength(2);
    expect((await (await page.request.get(historyUrl)).json()).undo).toHaveLength(history.undo.length); await expect(page.getByRole('button', { name: '普通连线', exact: true })).toHaveCount(2);
    console.log('issue26-card-cascade', JSON.stringify({ commands, receipt, cardId: card.id, itemId: card.item.id, incident, unrelated, restored: restored.connectors, history: afterHistory }));
  } finally { page.off('request', record); }
});

test('删除形状同时删除相连线并一步恢复原身份', async ({ page, workspace }) => {
  const card = await seedConnectorCard(page, workspace, 'shape-delete-protected', 700, 400), projectId = (await workspace.state()).project.id;
  await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'shape.create', expected: null,
    payload: { id: 'deleted-shape', content: { shapeType: 'rectangle', shortText: '删除的形状' }, pose: { x: 250, y: 190, width: 240, height: 130 } } });
  const shape = (await workspace.state()).shapes![0]!;
  await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'connector.create', expected: null,
    payload: { id: 'shape-incident-line', path: 'straight', start: { kind: 'bound', itemId: shape.item.id, side: 'right' }, end: { kind: 'bound', itemId: card.item.id, side: 'left' } } });
  await page.reload(); await expect(page.getByRole('status')).toHaveText('已保存到本机');
  const before = await workspace.state(), incident = before.connectors![0]!, line = page.getByRole('button', { name: '普通连线', exact: true }), initial = await connectorSvgEnds(line.locator('path'));
  const historyUrl = workspace.origin + '/api/mapping/projects/' + encodeURIComponent(projectId) + '/history', history = await (await page.request.get(historyUrl)).json(), commands: Command[] = [];
  const record = (request: import('@playwright/test').Request) => { if (request.url().endsWith('/api/mapping/execute') && request.postDataJSON()?.type === 'shape.delete') commands.push(request.postDataJSON()); };
  page.on('request', record);
  try {
    const visual = page.getByRole('img', { name: shape.content.shortText, exact: true }); await visual.click();
    const saved = page.waitForResponse(response => response.url().endsWith('/api/mapping/execute') && response.request().postDataJSON()?.type === 'shape.delete');
    await page.getByRole('button', { name: '删除形状', exact: true }).click(); const response = await saved; expect(response.status(), '删除形状必须携带捕获的精确关联线闭包').toBe(200); const receipt = await response.json();
    await expect(visual).toHaveCount(0); await expect(line).toHaveCount(0); const deleted = await workspace.state();
    expect(commands).toEqual([expect.objectContaining({ type: 'shape.delete', payload: { id: shape.id }, expected: { shape: shape.versionId, pose: shape.item.versionId, connectors: { [incident.id]: incident.versionId } } })]);
    expect(deleted.shapes).toEqual([]); expect(deleted.connectors).toEqual([]); expect(deleted.cards).toEqual(before.cards); expect(receipt.deletedIds).toEqual(expect.arrayContaining([shape.id, shape.item.id, incident.id]));
    const afterHistory = await (await page.request.get(historyUrl)).json(); expect(afterHistory.undo).toHaveLength(history.undo.length + 1); expect(afterHistory.undo.at(-1)).toMatchObject({ label: 'shape.delete', target: { id: shape.id } });
    const undo = page.waitForResponse(value => value.url().endsWith('/api/mapping/execute') && value.request().postDataJSON()?.type === 'history.undo');
    await page.getByRole('button', { name: '撤销', exact: true }).click(); expect((await undo).status()).toBe(200); await expect(visual).toBeVisible(); await expect(line).toBeVisible();
    const restored = await workspace.state(); expect(restored.shapes).toEqual([expect.objectContaining({ id: shape.id, content: shape.content, item: expect.objectContaining({ id: shape.item.id, pose: shape.item.pose }) })]);
    expect(restored.connectors).toEqual([expect.objectContaining({ id: incident.id, path: incident.path, start: incident.start, end: incident.end })]); expect(restored.cards).toEqual(before.cards);
    expect((await (await page.request.get(historyUrl)).json()).undo).toHaveLength(history.undo.length); expect(await connectorSvgEnds(line.locator('path'))).toEqual(initial);
    console.log('issue26-shape-cascade', JSON.stringify({ commands, receipt, shapeId: shape.id, itemId: shape.item.id, incident, initial, restored: restored.connectors, history: afterHistory }));
  } finally { page.off('request', record); }
});

test('独立文字清空结束编辑时同时删除相连线', async ({ page, workspace }) => {
  const card = await seedConnectorCard(page, workspace, 'text-delete-protected', 700, 400), projectId = (await workspace.state()).project.id;
  await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'text.create', expected: null,
    payload: { id: 'deleted-text', content: { runs: [{ text: '将被清空的独立文字' }], fontSize: 18, lineHeight: 1.5, align: 'left', widthMode: 'fixed', width: 260 }, pose: { x: 250, y: 190, width: 260, height: 27 } } });
  const text = (await workspace.state()).texts![0]!;
  await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'connector.create', expected: null,
    payload: { id: 'text-incident-line', path: 'straight', start: { kind: 'bound', itemId: text.item.id, side: 'right' }, end: { kind: 'bound', itemId: card.item.id, side: 'left' } } });
  await page.reload(); await expect(page.getByRole('status')).toHaveText('已保存到本机');
  const before = await workspace.state(), original = before.texts![0]!, incident = before.connectors![0]!, line = page.getByRole('button', { name: '普通连线', exact: true }), initial = await connectorSvgEnds(line.locator('path'));
  const historyUrl = workspace.origin + '/api/mapping/projects/' + encodeURIComponent(projectId) + '/history', history = await (await page.request.get(historyUrl)).json(), commands: Command[] = [];
  const record = (request: import('@playwright/test').Request) => { if (request.url().endsWith('/api/mapping/execute') && request.postDataJSON()?.type === 'text.delete') commands.push(request.postDataJSON()); };
  page.on('request', record);
  try {
    await page.locator('.canvas-text-content').dblclick(); const editor = page.getByRole('textbox', { name: '独立文字', exact: true }); await editor.fill(' \n  ');
    expect(commands).toHaveLength(0); expect((await workspace.state()).connectors).toEqual(before.connectors); expect((await workspace.state()).texts).toEqual(before.texts);
    const saved = page.waitForResponse(response => response.url().endsWith('/api/mapping/execute') && response.request().postDataJSON()?.type === 'text.delete');
    await editor.press('Escape'); const response = await saved; expect(response.status(), '结束空白独立文字必须携带原关联线闭包').toBe(200); const receipt = await response.json();
    await expect(editor).toHaveCount(0); await expect(page.locator('.canvas-text')).toHaveCount(0); await expect(line).toHaveCount(0); const deleted = await workspace.state();
    expect(commands).toEqual([expect.objectContaining({ type: 'text.delete', payload: { id: original.id }, expected: { text: original.versionId, pose: original.item.versionId, connectors: { [incident.id]: incident.versionId } } })]);
    expect(deleted.texts).toEqual([]); expect(deleted.connectors).toEqual([]); expect(deleted.cards).toEqual(before.cards); expect(receipt.deletedIds).toEqual(expect.arrayContaining([original.id, original.item.id, incident.id]));
    const afterHistory = await (await page.request.get(historyUrl)).json(); expect(afterHistory.undo).toHaveLength(history.undo.length + 1); expect(afterHistory.undo.at(-1)).toMatchObject({ label: 'text.delete', target: { id: original.id } });
    const undo = page.waitForResponse(value => value.url().endsWith('/api/mapping/execute') && value.request().postDataJSON()?.type === 'history.undo');
    await page.getByRole('button', { name: '撤销', exact: true }).click(); expect((await undo).status()).toBe(200); await expect(page.locator('.canvas-text-content')).toHaveText('将被清空的独立文字'); await expect(line).toBeVisible();
    const restored = await workspace.state(); expect(restored.texts).toEqual([expect.objectContaining({ id: original.id, content: original.content, item: expect.objectContaining({ id: original.item.id, pose: original.item.pose }) })]);
    expect(restored.connectors).toEqual([expect.objectContaining({ id: incident.id, path: incident.path, start: incident.start, end: incident.end })]); expect(restored.cards).toEqual(before.cards);
    expect((await (await page.request.get(historyUrl)).json()).undo).toHaveLength(history.undo.length); expect(await connectorSvgEnds(line.locator('path'))).toEqual(initial);
    console.log('issue26-text-cascade', JSON.stringify({ commands, receipt, textId: original.id, itemId: original.item.id, incident, initial, restored: restored.connectors, history: afterHistory }));
  } finally { page.off('request', record); }
});

test('删除图片同时删除相连线并一步恢复原身份', async ({ page, workspace }) => {
  const card = await seedConnectorCard(page, workspace, 'image-delete-protected', 700, 400), projectId = (await workspace.state()).project.id;
  const source = '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="180"><rect width="300" height="180" fill="blue"/></svg>';
  await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'asset.save', expected: null,
    payload: { id: 'deleted-image-asset', name: '删除绑定.svg', mime: 'image/svg+xml', base64: Buffer.from(source).toString('base64') } });
  await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'image.create', expected: null,
    payload: { id: 'deleted-image', content: { assetId: 'deleted-image-asset', crop: { x: 0.1, y: 0.2, width: 0.7, height: 0.6 } }, pose: { x: 250, y: 190, width: 300, height: 180, rotation: 0 } } });
  const image = (await workspace.state()).images![0]!;
  await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'connector.create', expected: null,
    payload: { id: 'image-incident-line', path: 'straight', start: { kind: 'bound', itemId: image.item.id, side: 'right' }, end: { kind: 'bound', itemId: card.item.id, side: 'left' } } });
  await page.reload(); await expect(page.getByRole('status')).toHaveText('已保存到本机');
  const before = await workspace.state(), incident = before.connectors![0]!, line = page.getByRole('button', { name: '普通连线', exact: true }), initial = await connectorSvgEnds(line.locator('path'));
  const historyUrl = workspace.origin + '/api/mapping/projects/' + encodeURIComponent(projectId) + '/history', history = await (await page.request.get(historyUrl)).json(), commands: Command[] = [];
  const record = (request: import('@playwright/test').Request) => { if (request.url().endsWith('/api/mapping/execute') && request.postDataJSON()?.type === 'image.delete') commands.push(request.postDataJSON()); };
  page.on('request', record);
  try {
    const visual = page.getByRole('img', { name: '删除绑定.svg', exact: true }); await visual.click();
    const saved = page.waitForResponse(response => response.url().endsWith('/api/mapping/execute') && response.request().postDataJSON()?.type === 'image.delete');
    await page.getByRole('button', { name: '删除图片', exact: true }).click(); const response = await saved; expect(response.status(), '删除图片必须携带同投影的关联线闭包').toBe(200); const receipt = await response.json();
    await expect(visual).toHaveCount(0); await expect(line).toHaveCount(0); const deleted = await workspace.state();
    expect(commands).toEqual([expect.objectContaining({ type: 'image.delete', payload: { id: image.id }, expected: { image: image.versionId, pose: image.item.versionId, connectors: { [incident.id]: incident.versionId } } })]);
    expect(deleted.images).toEqual([]); expect(deleted.connectors).toEqual([]); expect(deleted.cards).toEqual(before.cards); expect(receipt.deletedIds).toEqual(expect.arrayContaining([image.id, image.item.id, incident.id]));
    const afterHistory = await (await page.request.get(historyUrl)).json(); expect(afterHistory.undo).toHaveLength(history.undo.length + 1); expect(afterHistory.undo.at(-1)).toMatchObject({ label: 'image.delete', target: { id: image.id } });
    const undo = page.waitForResponse(value => value.url().endsWith('/api/mapping/execute') && value.request().postDataJSON()?.type === 'history.undo');
    await page.getByRole('button', { name: '撤销', exact: true }).click(); expect((await undo).status()).toBe(200); await expect(visual).toBeVisible(); await expect(line).toBeVisible();
    const restored = await workspace.state(); expect(restored.images).toEqual([expect.objectContaining({ id: image.id, content: image.content, item: expect.objectContaining({ id: image.item.id, pose: image.item.pose }) })]);
    expect(restored.connectors).toEqual([expect.objectContaining({ id: incident.id, path: incident.path, start: incident.start, end: incident.end })]); expect(restored.cards).toEqual(before.cards);
    expect((await (await page.request.get(historyUrl)).json()).undo).toHaveLength(history.undo.length); expect(await connectorSvgEnds(line.locator('path'))).toEqual(initial);
    console.log('issue26-image-cascade', JSON.stringify({ commands, receipt, imageId: image.id, itemId: image.item.id, incident, initial, restored: restored.connectors, history: afterHistory }));
  } finally { page.off('request', record); }
});

test('删卡已提交丢ACK后明确重试原命令与原闭包', async ({ page, workspace }) => {
  const pair = await connectorCardPair(page, workspace), projectId = (await workspace.state()).project.id;
  await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'connector.create', expected: null,
    payload: { id: 'ack-card-line', path: 'straight', start: pair.expected.start, end: pair.expected.end } });
  await page.reload(); await expect(page.getByRole('status')).toHaveText('已保存到本机');
  const before = await workspace.state(), incident = before.connectors![0]!, historyUrl = workspace.origin + '/api/mapping/projects/' + encodeURIComponent(projectId) + '/history', history = await (await page.request.get(historyUrl)).json();
  const attempts: { command: Command; status: number; receipt: unknown }[] = [];
  await page.route('**/api/mapping/execute', async route => {
    const command = route.request().postDataJSON(); if (command?.type !== 'thought.delete') { await route.continue(); return; }
    const response = await route.fetch(); attempts.push({ command, status: response.status(), receipt: await response.json() });
    if (attempts.length === 1) await route.abort('connectionreset'); else await route.fulfill({ response });
  });
  try {
    await page.locator('.thought-card').first().locator('.title-button').click(); await page.getByRole('toolbar', { name: '卡片操作' }).getByRole('button', { name: '更多', exact: true }).click();
    await page.getByRole('dialog', { name: '更多', exact: true }).getByRole('button', { name: '删除卡片', exact: true }).click();
    const retry = page.getByRole('button', { name: '重试保存', exact: true }); await expect(retry).toBeVisible(); expect(attempts).toHaveLength(1); expect(attempts[0]!.status).toBe(200);
    expect(attempts[0]!.command).toMatchObject({ type: 'thought.delete', payload: { id: pair.a.id }, expected: { connectors: { [incident.id]: incident.versionId } } });
    const deleted = await workspace.state(); expect(deleted.cards).toEqual(before.cards.filter(card => card.id !== pair.a.id)); expect(deleted.connectors).toEqual([]);
    expect((await (await page.request.get(historyUrl)).json()).undo).toHaveLength(history.undo.length + 1);
    await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'connector.create', expected: null,
      payload: { id: 'peer-after-card-delete', path: 'straight', start: { kind: 'free', point: { x: 800, y: 90 } }, end: { kind: 'free', point: { x: 1000, y: 90 } } } });
    const peer = await workspace.state(), peerHistory = await (await page.request.get(historyUrl)).json();
    const confirmed = page.waitForResponse(response => response.url().endsWith('/api/mapping/execute') && response.request().postDataJSON()?.type === 'thought.delete');
    await retry.click(); expect((await confirmed).status()).toBe(200); await expect(page.getByRole('status')).toHaveText('已保存到本机');
    expect(attempts).toHaveLength(2); expect(attempts[1]).toEqual(attempts[0]); expect(await workspace.state()).toEqual(peer); expect(await (await page.request.get(historyUrl)).json()).toEqual(peerHistory);
    await expect(page.locator('.thought-card')).toHaveCount(1); await expect(page.getByRole('button', { name: '普通连线', exact: true })).toHaveCount(1);
    console.log('issue26-card-delete-ack', JSON.stringify({ attempts, incident, peerHistory, recovery: 'real execute200 then transport abort; explicit retry of original command after unrelated peer creation' }));
  } finally { await page.unrouteAll({ behavior: 'wait' }); }
});

test('删形状已提交丢ACK后明确重试原命令与原闭包', async ({ page, workspace }) => {
  const card = await seedConnectorCard(page, workspace, 'shape-ack-protected', 700, 400), projectId = (await workspace.state()).project.id;
  await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'shape.create', expected: null,
    payload: { id: 'ack-shape', content: { shapeType: 'rectangle', shortText: '未确认删除形状' }, pose: { x: 250, y: 190, width: 240, height: 130 } } });
  const shape = (await workspace.state()).shapes![0]!;
  await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'connector.create', expected: null,
    payload: { id: 'ack-shape-line', path: 'straight', start: { kind: 'bound', itemId: shape.item.id, side: 'right' }, end: { kind: 'bound', itemId: card.item.id, side: 'left' } } });
  await page.reload(); await expect(page.getByRole('status')).toHaveText('已保存到本机');
  const before = await workspace.state(), incident = before.connectors![0]!, historyUrl = workspace.origin + '/api/mapping/projects/' + encodeURIComponent(projectId) + '/history', history = await (await page.request.get(historyUrl)).json();
  const attempts: { command: Command; status: number; receipt: unknown }[] = [];
  await page.route('**/api/mapping/execute', async route => {
    const command = route.request().postDataJSON(); if (command?.type !== 'shape.delete') { await route.continue(); return; }
    const response = await route.fetch(); attempts.push({ command, status: response.status(), receipt: await response.json() });
    if (attempts.length === 1) await route.abort('connectionreset'); else await route.fulfill({ response });
  });
  try {
    await page.getByRole('img', { name: shape.content.shortText, exact: true }).click(); await page.getByRole('button', { name: '删除形状', exact: true }).click();
    const retry = page.getByRole('button', { name: '重试保存', exact: true }); await expect(retry).toBeVisible(); expect(attempts).toHaveLength(1); expect(attempts[0]!.status).toBe(200);
    expect(attempts[0]!.command).toMatchObject({ type: 'shape.delete', payload: { id: shape.id }, expected: { shape: shape.versionId, pose: shape.item.versionId, connectors: { [incident.id]: incident.versionId } } });
    const deleted = await workspace.state(); expect(deleted.shapes).toEqual([]); expect(deleted.connectors).toEqual([]); expect(deleted.cards).toEqual(before.cards); expect((await (await page.request.get(historyUrl)).json()).undo).toHaveLength(history.undo.length + 1);
    await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'connector.create', expected: null,
      payload: { id: 'peer-after-shape-delete', path: 'straight', start: { kind: 'free', point: { x: 800, y: 90 } }, end: { kind: 'free', point: { x: 1000, y: 90 } } } });
    const peer = await workspace.state(), peerHistory = await (await page.request.get(historyUrl)).json();
    const confirmed = page.waitForResponse(response => response.url().endsWith('/api/mapping/execute') && response.request().postDataJSON()?.type === 'shape.delete');
    await retry.click(); expect((await confirmed).status()).toBe(200); await expect(page.getByRole('status')).toHaveText('已保存到本机');
    expect(attempts).toHaveLength(2); expect(attempts[1]).toEqual(attempts[0]); expect(await workspace.state()).toEqual(peer); expect(await (await page.request.get(historyUrl)).json()).toEqual(peerHistory);
    await expect(page.getByRole('img', { name: shape.content.shortText, exact: true })).toHaveCount(0); await expect(page.getByRole('button', { name: '普通连线', exact: true })).toHaveCount(1);
    console.log('issue26-shape-delete-ack', JSON.stringify({ attempts, incident, peerHistory, recovery: 'real execute200 then transport abort; explicit unchanged-command retry' }));
  } finally { await page.unrouteAll({ behavior: 'wait' }); }
});

test('冻结删除闭包后新增关联线使真实409整体拒绝', async ({ page, workspace }) => {
  const pair = await connectorCardPair(page, workspace), projectId = (await workspace.state()).project.id;
  await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'connector.create', expected: null,
    payload: { id: 'captured-incident', path: 'straight', start: pair.expected.start, end: pair.expected.end } });
  await page.reload(); await expect(page.getByRole('status')).toHaveText('已保存到本机');
  let releaseOwn = () => {}, ownReleased = false;
  const ownGate = new Promise<void>(resolve => { releaseOwn = () => { ownReleased = true; resolve(); }; });
  const ownCommands: Command[] = [], ownAcks: { command: Command; status: number; receipt: unknown }[] = [], attempts: { command: Command; status: number; body: unknown }[] = [];
  await page.route('**/api/mapping/execute', async route => {
    const command = route.request().postDataJSON();
    if (command?.type === 'thought.title' && command.payload.id === pair.b.id) {
      ownCommands.push(command); await ownGate; const response = await route.fetch(); ownAcks.push({ command, status: response.status(), receipt: await response.json() }); await route.fulfill({ response });
    } else if (command?.type === 'thought.delete') {
      const response = await route.fetch(); attempts.push({ command, status: response.status(), body: await response.json() }); await route.fulfill({ response });
    } else await route.continue();
  });
  try {
    await page.locator('.thought-card').nth(1).locator('.title-button').dblclick();
    const editor = page.getByRole('textbox', { name: '卡片标题', exact: true }); await editor.fill('另一张卡片的真实保存'); await editor.press('Enter');
    await expect.poll(() => ownCommands.length).toBe(1); expect(ownReleased).toBe(false);
    await page.locator('.thought-card').first().locator('.title-button').click(); await page.getByRole('toolbar', { name: '卡片操作' }).getByRole('button', { name: '更多', exact: true }).click();
    const intent = await workspace.state(), card = intent.cards.find(value => value.id === pair.a.id)!, incident = intent.connectors![0]!;
    const historyUrl = workspace.origin + '/api/mapping/projects/' + encodeURIComponent(projectId) + '/history', history = await (await page.request.get(historyUrl)).json();
    const deleted = page.waitForResponse(response => response.url().endsWith('/api/mapping/execute') && response.request().postDataJSON()?.type === 'thought.delete');
    await page.getByRole('dialog', { name: '更多', exact: true }).getByRole('button', { name: '删除卡片', exact: true }).click();
    await expect(page.getByRole('dialog', { name: '更多', exact: true })).toHaveCount(0); expect(ownReleased).toBe(false); expect(attempts).toHaveLength(0); expect(ownAcks).toHaveLength(0);
    await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'connector.create', expected: null,
      payload: { id: 'peer-new-incident', path: 'straight', start: { kind: 'bound', itemId: card.item.id, side: 'left' }, end: { kind: 'free', point: { x: 600, y: 650 } } } });
    const peer = await workspace.state(); expect(peer.cards.find(value => value.id === card.id)).toEqual(card); expect(peer.connectors).toHaveLength(2); expect(ownReleased).toBe(false); expect(attempts).toHaveLength(0);
    releaseOwn(); expect((await deleted).status()).toBe(409); expect(ownAcks).toEqual([expect.objectContaining({ command: expect.objectContaining({ type: 'thought.title', payload: { id: pair.b.id, title: '另一张卡片的真实保存' } }), status: 200 })]);
    expect(attempts).toEqual([expect.objectContaining({ status: 409, body: expect.objectContaining({ code: 'VERSION_CONFLICT', message: '相连连线范围或版本已更新，请重新读取' }), command: expect.objectContaining({ type: 'thought.delete', payload: { id: card.id }, expected: {
      thought: card.versionId, body: card.body.versionId, pose: card.item.versionId, appearance: card.appearance?.versionId ?? null, cardTags: card.cardTags?.versionId ?? null, connectors: { [incident.id]: incident.versionId } } }) })]);
    const after = await workspace.state(); expect(after.cards.find(value => value.id === card.id)).toEqual(card); expect(after.cards.find(value => value.id === pair.b.id)?.title).toBe('另一张卡片的真实保存'); expect(after.connectors).toEqual(peer.connectors);
    expect(after.project.revision).toBe(intent.project.revision + 2); const afterHistory = await (await page.request.get(historyUrl)).json(); expect(afterHistory.undo).toHaveLength(history.undo.length + 2); expect(afterHistory.undo.filter((value: { label: string }) => value.label === 'thought.delete')).toHaveLength(0);
    await expect(page.locator('.workspace')).toHaveAttribute('data-revision', String(after.project.revision)); await expect(page.locator('.thought-card')).toHaveCount(2); await expect(page.getByRole('button', { name: '普通连线', exact: true })).toHaveCount(2);
    console.log('issue26-frozen-delete-race', JSON.stringify({ ownCommands, ownAcks, attempts, intentHost: card, finalHost: after.cards.find(value => value.id === card.id), incident, peerLines: peer.connectors, history: afterHistory, ordering: 'A delete click while own B title flush held; peer bound line real create; then release own B save; host A unchanged and exact closure409' }));
  } finally { releaseOwn(); await page.unrouteAll({ behavior: 'wait' }); }
});

test('待保存编辑后删卡只采用自身确认版本并保留闭包', async ({ page, workspace }) => {
  await connectorDirtyCardDelete(page, workspace);
});
