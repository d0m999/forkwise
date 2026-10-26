import { test, expect } from './writing-board-fixture';
import type { Command, Receipt, ProjectHistory } from '../../backend/src/mapping/contracts';
import { connectorCardPair } from './connector-ui-fixture';

test('待保存正文派生布局确认后首次删卡保留原关联线闭包', async ({ page, workspace }) => {
  const pair = await connectorCardPair(page, workspace), projectId = (await workspace.state()).project.id;
  await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'connector.create', expected: null,
    payload: { id: 'body-layout-incident', path: 'straight', start: pair.expected.start, end: pair.expected.end } });
  await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'connector.create', expected: null,
    payload: { id: 'body-layout-unrelated', path: 'straight', start: { kind: 'free', point: { x: 800, y: 90 } }, end: { kind: 'free', point: { x: 1000, y: 90 } } } });
  await page.reload(); await expect(page.getByRole('status')).toHaveText('已保存到本机');
  const before = await workspace.state(), card = before.cards.find(value => value.id === pair.a.id)!, incident = before.connectors!.find(value => value.id === 'body-layout-incident')!;
  expect(card.body.blocks.some(block => typeof block.text === 'string' && block.text.length > 0)).toBe(true);
  expect(card.item.heightPolicy?.manualHeight).toBeNull();
  expect(card.item.heightPolicy!.previewFloor!).toBeGreaterThan(card.item.heightPolicy!.necessaryHeight);
  expect(card.item.pose.height).toBeGreaterThan(card.item.heightPolicy!.necessaryHeight);
  const historyUrl = workspace.origin + '/api/mapping/projects/' + encodeURIComponent(projectId) + '/history';
  const history = await (await page.request.get(historyUrl)).json() as ProjectHistory;
  let releaseBodyExecute = () => {}, releaseBodyAck = () => {}, releaseLayoutAck = () => {};
  let bodyAckReleased = false, layoutAckReleased = false;
  const bodyExecuteGate = new Promise<void>(resolve => { releaseBodyExecute = resolve; });
  const bodyAckGate = new Promise<void>(resolve => { releaseBodyAck = () => { bodyAckReleased = true; resolve(); }; });
  const layoutAckGate = new Promise<void>(resolve => { releaseLayoutAck = () => { layoutAckReleased = true; resolve(); }; });
  let layoutStarted = () => {}, deleteStarted = () => {};
  const layoutReached = new Promise<'layout'>(resolve => { layoutStarted = () => resolve('layout'); });
  const deleteReached = new Promise<'delete'>(resolve => { deleteStarted = () => resolve('delete'); });
  const bodyCommands: Command[] = [], layoutCommands: Command[] = [], events: string[] = [];
  const bodyReplies: { command: Command; status: number; receipt: Receipt }[] = [], layoutReplies: { command: Command; status: number; receipt: Receipt }[] = [];
  const deletes: { command: Command; status: number; body: unknown }[] = [];
  await page.route('**/api/mapping/execute', async route => {
    const command = route.request().postDataJSON() as Command;
    if (command.type === 'body.edit' && command.payload.id === card.id) {
      bodyCommands.push(command); events.push('body-request-held'); await bodyExecuteGate;
      const response = await route.fetch(); bodyReplies.push({ command, status: response.status(), receipt: await response.json() }); events.push('body-real-response-held');
      await bodyAckGate; await route.fulfill({ response }); events.push('body-ACK-delivered');
    } else if (command.type === 'card.layout' && command.payload.id === card.id && bodyReplies.length > 0) {
      layoutCommands.push(command); events.push('derived-layout-request'); layoutStarted();
      const response = await route.fetch(); layoutReplies.push({ command, status: response.status(), receipt: await response.json() }); events.push('layout-real-response-held');
      await layoutAckGate; await route.fulfill({ response }); events.push('layout-ACK-delivered');
    } else if (command.type === 'thought.delete' && command.payload.id === card.id) {
      events.push('delete-request'); deleteStarted(); const response = await route.fetch();
      deletes.push({ command, status: response.status(), body: await response.json() }); await route.fulfill({ response });
    } else await route.continue();
  });
  try {
    const node = page.locator('.thought-card').first(); await node.locator('.title-button').click();
    await node.getByRole('button', { name: '编辑正文', exact: true }).click();
    const editor = page.getByRole('textbox', { name: '卡片正文', exact: true }); await editor.fill('');
    await expect.poll(() => bodyCommands.length).toBe(1); expect(bodyReplies).toHaveLength(0);
    expect(bodyCommands[0]).toMatchObject({ type: 'body.edit', projectId, expected: card.body.versionId, payload: { id: card.id } });
    await page.getByRole('toolbar', { name: '卡片操作' }).getByRole('button', { name: '更多', exact: true }).click();
    await expect(page.locator('.workspace')).toHaveAttribute('data-revision', String(before.project.revision));
    events.push('delete-intent');
    await page.getByRole('dialog', { name: '更多', exact: true }).getByRole('button', { name: '删除卡片', exact: true }).click();
    await expect(page.getByRole('dialog', { name: '更多', exact: true })).toHaveCount(0);
    expect(bodyAckReleased).toBe(false); expect(layoutAckReleased).toBe(false); expect(deletes).toHaveLength(0);
    expect(await workspace.state()).toEqual(before); expect(await (await page.request.get(historyUrl)).json()).toEqual(history);
    releaseBodyExecute(); await expect.poll(() => bodyReplies.length).toBe(1);
    const body = bodyReplies[0]!; expect(body.status).toBe(200); expect(body.receipt.versions!.body).not.toBe(card.body.versionId);
    const bodySaved = await workspace.state(), bodyCard = bodySaved.cards.find(value => value.id === card.id)!;
    expect(bodyCard.body.versionId).toBe(body.receipt.versions!.body);
    expect(bodyCard.body.blocks.every(block => typeof block.text !== 'string' || block.text.length === 0)).toBe(true);
    expect(bodyCard.item).toEqual(card.item); expect(bodySaved.connectors).toEqual(before.connectors);
    expect(layoutCommands).toHaveLength(0); expect(deletes).toHaveLength(0); expect(bodyAckReleased).toBe(false);
    releaseBodyAck();
    const first = await Promise.race([layoutReached, deleteReached]);
    console.log('issue26-body-layout-order', JSON.stringify({ first, events, bodyCommands, bodyReplies, layoutCommands, deletes }));
    expect(first, '正文确认后的真实派生布局必须先完成，再发送删除').toBe('layout');
    await expect.poll(() => layoutReplies.length).toBe(1);
    const layout = layoutReplies[0]!; expect(layout.status).toBe(200);
    expect(layout.receipt.versions!.pose).not.toBe(card.item.versionId);
    const layoutSaved = await workspace.state(), layoutCard = layoutSaved.cards.find(value => value.id === card.id)!;
    expect(layoutCard.item.versionId).toBe(layout.receipt.versions!.pose);
    expect(layoutCard.item.pose.height).toBeLessThan(card.item.pose.height);
    expect(layoutCard.body).toEqual(bodyCard.body); expect(layoutCard.versionId).toBe(card.versionId);
    expect(layoutSaved.cards.find(value => value.id === pair.b.id)).toEqual(before.cards.find(value => value.id === pair.b.id));
    expect(layoutSaved.connectors).toEqual(before.connectors); expect(deletes).toHaveLength(0); expect(layoutAckReleased).toBe(false);
    const savedHistory = await (await page.request.get(historyUrl)).json() as ProjectHistory;
    expect(savedHistory.undo).toHaveLength(history.undo.length + 1);
    const responsePromise = page.waitForResponse(response => response.url().endsWith('/api/mapping/execute') && response.request().postDataJSON()?.type === 'thought.delete');
    releaseLayoutAck(); const response = await responsePromise, receipt = await response.json();
    const after = await workspace.state(), afterHistory = await (await page.request.get(historyUrl)).json() as ProjectHistory;
    console.log('issue26-body-layout-delete', JSON.stringify({ before, history, events, bodyCommands, bodyReplies, bodySaved, layoutCommands, layoutReplies, layoutSaved, savedHistory, deletes, deleteStatus: response.status(), receipt, after, afterHistory,
      boundary: 'actual nonempty-to-empty body200 then independent derived layout shrink200; intent precedes both ACKs; original closure, no internal state or successful response mock' }));
    expect(response.status(), '正文与派生布局自身确认后首次删卡应使用两域自身版本').toBe(200);
    expect(bodyCommands).toHaveLength(1); expect(layoutCommands).toHaveLength(1); expect(deletes).toHaveLength(1);
    expect(deletes[0]!.command).toMatchObject({ projectId, type: 'thought.delete', payload: { id: card.id }, expected: {
      thought: card.versionId, body: body.receipt.versions!.body, pose: layout.receipt.versions!.pose,
      appearance: card.appearance?.versionId ?? null, cardTags: card.cardTags?.versionId ?? null, connectors: { [incident.id]: incident.versionId } } });
    expect(after.cards).toEqual(before.cards.filter(value => value.id !== card.id));
    expect(after.connectors).toEqual(before.connectors!.filter(value => value.id !== incident.id));
    for (const key of ['tags', 'texts', 'shapes', 'strokes', 'images'] as const) expect(after[key]).toEqual(before[key]);
    expect(receipt.deletedIds).toEqual(expect.arrayContaining([card.id, card.body.id, card.item.id, incident.id]));
    expect(after.project.revision).toBe(before.project.revision + 3); expect(afterHistory.undo).toHaveLength(history.undo.length + 2);
    expect(afterHistory.undo.at(-1)).toMatchObject({ label: 'thought.delete', target: { id: card.id } });
    await expect(page.locator('.workspace')).toHaveAttribute('data-revision', String(after.project.revision));
    await expect(page.locator('.thought-card')).toHaveCount(1); await expect(page.getByRole('button', { name: '普通连线', exact: true })).toHaveCount(1);
  } finally { releaseBodyExecute(); releaseBodyAck(); releaseLayoutAck(); await page.unrouteAll({ behavior: 'wait' }); }
});


test('待保存单卡移动确认后首次删卡只采用自身布局版本并保留闭包', async ({ page, workspace }) => {
  const pair = await connectorCardPair(page, workspace), projectId = (await workspace.state()).project.id;
  await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'connector.create', expected: null,
    payload: { id: 'single-pose-incident', path: 'straight', start: pair.expected.start, end: pair.expected.end } });
  await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'connector.create', expected: null,
    payload: { id: 'single-pose-unrelated', path: 'straight', start: { kind: 'free', point: { x: 800, y: 90 } }, end: { kind: 'free', point: { x: 1000, y: 90 } } } });
  await page.reload(); await expect(page.getByRole('status')).toHaveText('已保存到本机');
  const before = await workspace.state(), card = before.cards.find(value => value.id === pair.a.id)!, incident = before.connectors!.find(value => value.id === 'single-pose-incident')!;
  expect(before.cards.every(value => value.body.blocks.some(block => typeof block.text === 'string' && block.text.length > 0))).toBe(true);
  const historyUrl = workspace.origin + '/api/mapping/projects/' + encodeURIComponent(projectId) + '/history';
  const history = await (await page.request.get(historyUrl)).json() as ProjectHistory;
  let releaseExecute = () => {}, releaseAck = () => {}, ackReleased = false;
  const executeGate = new Promise<void>(resolve => { releaseExecute = resolve; });
  const ackGate = new Promise<void>(resolve => { releaseAck = () => { ackReleased = true; resolve(); }; });
  const ownCommands: Command[] = [], events: string[] = [];
  const ownReplies: { command: Command; status: number; receipt: Receipt }[] = [];
  const attempts: { command: Command; status: number; body: unknown }[] = [];
  await page.route('**/api/mapping/execute', async route => {
    const command = route.request().postDataJSON() as Command;
    if (command.type === 'pose.move' && command.payload.id === card.id) {
      ownCommands.push(command); events.push('pose-request-held'); await executeGate;
      const response = await route.fetch(); ownReplies.push({ command, status: response.status(), receipt: await response.json() }); events.push('pose-real-response-held');
      await ackGate; await route.fulfill({ response }); events.push('pose-ACK-delivered');
    } else if (command.type === 'thought.delete' && command.payload.id === card.id) {
      events.push('delete-request'); const response = await route.fetch();
      attempts.push({ command, status: response.status(), body: await response.json() }); await route.fulfill({ response });
    } else await route.continue();
  });
  try {
    const node = page.locator('.thought-card').first(); await node.locator('.title-button').click();
    await node.getByRole('button', { name: '移动卡片：方向键调整位置', exact: true }).press('ArrowRight');
    await expect.poll(() => ownCommands.length).toBe(1); expect(ownReplies).toHaveLength(0);
    expect(ownCommands[0]).toMatchObject({ projectId, type: 'pose.move', expected: card.item.versionId, payload: { id: card.id } });
    await page.getByRole('toolbar', { name: '卡片操作' }).getByRole('button', { name: '更多', exact: true }).click();
    await expect(page.locator('.workspace')).toHaveAttribute('data-revision', String(before.project.revision));
    events.push('delete-intent');
    await page.getByRole('dialog', { name: '更多', exact: true }).getByRole('button', { name: '删除卡片', exact: true }).click();
    await expect(page.getByRole('dialog', { name: '更多', exact: true })).toHaveCount(0);
    expect(ackReleased).toBe(false); expect(attempts).toHaveLength(0);
    expect(await workspace.state()).toEqual(before); expect(await (await page.request.get(historyUrl)).json()).toEqual(history);
    releaseExecute(); await expect.poll(() => ownReplies.length).toBe(1);
    const own = ownReplies[0]!; expect(own.status).toBe(200); expect(own.receipt.changedIds).toEqual([card.item.id]);
    expect(own.receipt.commandId).toBe(ownCommands[0]!.commandId); expect(own.receipt.projectId).toBe(projectId);
    const saved = await workspace.state(), moved = saved.cards.find(value => value.id === card.id)!;
    expect(moved.item.versionId).toBe(own.receipt.versions!.pose); expect(moved.item.versionId).not.toBe(card.item.versionId);
    expect(moved.item.pose).not.toEqual(card.item.pose); expect(moved.item.id).toBe(card.item.id);
    expect(moved.body).toEqual(card.body); expect(moved.versionId).toBe(card.versionId); expect(moved.appearance).toEqual(card.appearance);
    expect(saved.cards.find(value => value.id === pair.b.id)).toEqual(before.cards.find(value => value.id === pair.b.id));
    expect(saved.connectors).toEqual(before.connectors); expect(attempts).toHaveLength(0); expect(ackReleased).toBe(false);
    const savedHistory = await (await page.request.get(historyUrl)).json() as ProjectHistory;
    expect(saved.project.revision).toBe(before.project.revision + 1); expect(savedHistory.undo).toHaveLength(history.undo.length + 1);
    const responsePromise = page.waitForResponse(response => response.url().endsWith('/api/mapping/execute') && response.request().postDataJSON()?.type === 'thought.delete');
    releaseAck(); const response = await responsePromise, receipt = await response.json();
    const after = await workspace.state(), afterHistory = await (await page.request.get(historyUrl)).json() as ProjectHistory;
    console.log('issue26-single-pose-delete', JSON.stringify({ before, history, events, ownCommands, ownReplies, saved, savedHistory, attempts,
      deleteStatus: response.status(), receipt, after, afterHistory, boundary: 'actual move-handle ArrowRight pose.move; real execute200 and ACK separately held; menu intent before ACK; only ownpose advancement and original incident map' }));
    expect(response.status(), '单卡移动自身确认后首次删卡应使用其自身Pose版本').toBe(200);
    expect(ownCommands).toHaveLength(1); expect(attempts).toHaveLength(1);
    expect(attempts[0]!.command).toMatchObject({ projectId, type: 'thought.delete', payload: { id: card.id }, expected: {
      thought: card.versionId, body: card.body.versionId, pose: own.receipt.versions!.pose,
      appearance: card.appearance?.versionId ?? null, cardTags: card.cardTags?.versionId ?? null, connectors: { [incident.id]: incident.versionId } } });
    expect(after.cards).toEqual(saved.cards.filter(value => value.id !== card.id));
    expect(after.connectors).toEqual(before.connectors!.filter(value => value.id !== incident.id));
    for (const key of ['tags', 'texts', 'shapes', 'strokes', 'images'] as const) expect(after[key]).toEqual(before[key]);
    expect(receipt.deletedIds).toEqual(expect.arrayContaining([card.id, card.body.id, card.item.id, incident.id]));
    expect(after.project.revision).toBe(before.project.revision + 2); expect(afterHistory.undo).toHaveLength(history.undo.length + 2);
    expect(afterHistory.undo.at(-1)).toMatchObject({ label: 'thought.delete', target: { id: card.id } });
    await expect(page.locator('.workspace')).toHaveAttribute('data-revision', String(after.project.revision));
    await expect(page.locator('.thought-card')).toHaveCount(1); await expect(page.getByRole('button', { name: '普通连线', exact: true })).toHaveCount(1);
  } finally { releaseExecute(); releaseAck(); await page.unrouteAll({ behavior: 'wait' }); }
});


test('待保存卡片外观确认后首次删卡只采用自身外观版本并保留闭包', async ({ page, workspace }) => {
  const pair = await connectorCardPair(page, workspace), projectId = (await workspace.state()).project.id;
  await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'connector.create', expected: null,
    payload: { id: 'appearance-incident', path: 'straight', start: pair.expected.start, end: pair.expected.end } });
  await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'connector.create', expected: null,
    payload: { id: 'appearance-unrelated', path: 'straight', start: { kind: 'free', point: { x: 800, y: 90 } }, end: { kind: 'free', point: { x: 1000, y: 90 } } } });
  await page.reload(); await expect(page.getByRole('status')).toHaveText('已保存到本机');
  const before = await workspace.state(), card = before.cards.find(value => value.id === pair.a.id)!, incident = before.connectors!.find(value => value.id === 'appearance-incident')!;
  expect(before.cards.every(value => value.body.blocks.some(block => typeof block.text === 'string' && block.text.length > 0))).toBe(true);
  expect(card.appearance?.titleColor).not.toBe('#f7e9bd');
  const historyUrl = workspace.origin + '/api/mapping/projects/' + encodeURIComponent(projectId) + '/history';
  const history = await (await page.request.get(historyUrl)).json() as ProjectHistory;
  let releaseExecute = () => {}, releaseAck = () => {}, ackReleased = false;
  const executeGate = new Promise<void>(resolve => { releaseExecute = resolve; });
  const ackGate = new Promise<void>(resolve => { releaseAck = () => { ackReleased = true; resolve(); }; });
  const ownCommands: Command[] = [], events: string[] = [];
  const ownReplies: { command: Command; status: number; receipt: Receipt }[] = [];
  const attempts: { command: Command; status: number; body: unknown }[] = [];
  await page.route('**/api/mapping/execute', async route => {
    const command = route.request().postDataJSON() as Command;
    if (command.type === 'card.appearance' && command.payload.id === card.id) {
      ownCommands.push(command); events.push('appearance-request-held'); await executeGate;
      const response = await route.fetch(); ownReplies.push({ command, status: response.status(), receipt: await response.json() }); events.push('appearance-real-response-held');
      await ackGate; await route.fulfill({ response }); events.push('appearance-ACK-delivered');
    } else if (command.type === 'thought.delete' && command.payload.id === card.id) {
      events.push('delete-request'); const response = await route.fetch();
      attempts.push({ command, status: response.status(), body: await response.json() }); await route.fulfill({ response });
    } else await route.continue();
  });
  try {
    await page.locator('.thought-card').first().locator('.title-button').click();
    const toolbar = page.getByRole('toolbar', { name: '卡片操作' });
    await toolbar.getByRole('button', { name: '外观', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '卡片外观', exact: true }), originalPreview = await dialog.getByRole('checkbox').isChecked();
    await dialog.getByRole('button', { name: '杏色', exact: true }).click();
    await expect.poll(() => ownCommands.length).toBe(1); expect(ownReplies).toHaveLength(0);
    expect(ownCommands[0]).toMatchObject({ projectId, type: 'card.appearance', expected: card.appearance?.versionId ?? null,
      payload: { id: card.id, titleColor: '#f7e9bd', showPreview: originalPreview } });
    await toolbar.getByRole('button', { name: '更多', exact: true }).click();
    await expect(page.locator('.workspace')).toHaveAttribute('data-revision', String(before.project.revision));
    events.push('delete-intent');
    await page.getByRole('dialog', { name: '更多', exact: true }).getByRole('button', { name: '删除卡片', exact: true }).click();
    await expect(page.getByRole('dialog', { name: '更多', exact: true })).toHaveCount(0);
    expect(ackReleased).toBe(false); expect(attempts).toHaveLength(0);
    expect(await workspace.state()).toEqual(before); expect(await (await page.request.get(historyUrl)).json()).toEqual(history);
    releaseExecute(); await expect.poll(() => ownReplies.length).toBe(1);
    const own = ownReplies[0]!; expect(own.status).toBe(200);
    expect(own.receipt.commandId).toBe(ownCommands[0]!.commandId); expect(own.receipt.projectId).toBe(projectId);
    const saved = await workspace.state(), styled = saved.cards.find(value => value.id === card.id)!;
    expect(own.receipt.changedIds).toEqual([styled.appearance!.id]);
    expect(styled.appearance!.versionId).toBe(own.receipt.versions!.appearance); expect(styled.appearance!.versionId).not.toBe(card.appearance?.versionId);
    expect(styled.appearance).toMatchObject({ titleColor: '#f7e9bd', showPreview: originalPreview });
    const { appearance: changedAppearance, ...unchangedHost } = styled, { appearance: oldAppearance, ...originalHost } = card;
    expect(unchangedHost).toEqual(originalHost);
    expect(saved.cards.find(value => value.id === pair.b.id)).toEqual(before.cards.find(value => value.id === pair.b.id));
    expect(saved.connectors).toEqual(before.connectors); expect(attempts).toHaveLength(0); expect(ackReleased).toBe(false);
    const savedHistory = await (await page.request.get(historyUrl)).json() as ProjectHistory;
    expect(saved.project.revision).toBe(before.project.revision + 1); expect(savedHistory.undo).toHaveLength(history.undo.length + 1);
    const responsePromise = page.waitForResponse(response => response.url().endsWith('/api/mapping/execute') && response.request().postDataJSON()?.type === 'thought.delete');
    releaseAck(); const response = await responsePromise, receipt = await response.json();
    const after = await workspace.state(), afterHistory = await (await page.request.get(historyUrl)).json() as ProjectHistory;
    console.log('issue26-appearance-delete', JSON.stringify({ before, history, events, originalPreview, oldAppearance, changedAppearance, ownCommands, ownReplies, saved, savedHistory,
      attempts, deleteStatus: response.status(), receipt, after, afterHistory, boundary: 'actual toolbar appearance almond color only; original execute and true200 ACK gates; menu deletion intent before ACK; no showPreview or pose/body mutation' }));
    expect(response.status(), '卡片外观自身确认后首次删卡应使用其自身外观版本').toBe(200);
    expect(ownCommands).toHaveLength(1); expect(attempts).toHaveLength(1);
    expect(attempts[0]!.command).toMatchObject({ projectId, type: 'thought.delete', payload: { id: card.id }, expected: {
      thought: card.versionId, body: card.body.versionId, pose: card.item.versionId,
      appearance: own.receipt.versions!.appearance, cardTags: card.cardTags?.versionId ?? null, connectors: { [incident.id]: incident.versionId } } });
    expect(after.cards).toEqual(saved.cards.filter(value => value.id !== card.id));
    expect(after.connectors).toEqual(before.connectors!.filter(value => value.id !== incident.id));
    for (const key of ['tags', 'texts', 'shapes', 'strokes', 'images'] as const) expect(after[key]).toEqual(before[key]);
    expect(receipt.deletedIds).toEqual(expect.arrayContaining([card.id, card.body.id, card.item.id, incident.id]));
    expect(after.project.revision).toBe(before.project.revision + 2); expect(afterHistory.undo).toHaveLength(history.undo.length + 2);
    expect(afterHistory.undo.at(-1)).toMatchObject({ label: 'thought.delete', target: { id: card.id } });
    await expect(page.locator('.workspace')).toHaveAttribute('data-revision', String(after.project.revision));
    await expect(page.locator('.thought-card')).toHaveCount(1); await expect(page.getByRole('button', { name: '普通连线', exact: true })).toHaveCount(1);
  } finally { releaseExecute(); releaseAck(); await page.unrouteAll({ behavior: 'wait' }); }
});
