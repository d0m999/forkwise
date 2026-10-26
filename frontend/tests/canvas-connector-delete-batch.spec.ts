import { test, expect } from './writing-board-fixture';
import type { Command, Receipt, ProjectHistory } from '../../backend/src/mapping/contracts';
import { connectorCardPair } from './connector-ui-fixture';

test('批量移动确认后删除非首卡只采用自身布局版本并保留闭包', async ({ page, workspace }) => {
  const pair = await connectorCardPair(page, workspace), projectId = (await workspace.state()).project.id;
  await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'connector.create', expected: null,
    payload: { id: 'batch-pose-incident', path: 'straight', start: pair.expected.start, end: pair.expected.end } });
  await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'connector.create', expected: null,
    payload: { id: 'batch-pose-unrelated', path: 'straight', start: { kind: 'free', point: { x: 800, y: 90 } }, end: { kind: 'free', point: { x: 1000, y: 90 } } } });
  await page.reload(); await expect(page.getByRole('status')).toHaveText('已保存到本机');
  const before = await workspace.state(), card = before.cards.find(value => value.id === pair.b.id)!, first = before.cards.find(value => value.id === pair.a.id)!;
  const incident = before.connectors!.find(value => value.id === 'batch-pose-incident')!;
  expect(before.cards.every(value => value.body.blocks.some(block => typeof block.text === 'string' && block.text.length > 0))).toBe(true);
  const historyUrl = workspace.origin + '/api/mapping/projects/' + encodeURIComponent(projectId) + '/history';
  const history = await (await page.request.get(historyUrl)).json() as ProjectHistory;
  let releaseExecute = () => {}, releaseAck = () => {}, ackReleased = false;
  const executeGate = new Promise<void>(resolve => { releaseExecute = resolve; });
  const ackGate = new Promise<void>(resolve => { releaseAck = () => { ackReleased = true; resolve(); }; });
  type Batch = Extract<Command, { type: 'pose.batch' }>;
  const ownCommands: Batch[] = [], events: string[] = [];
  const ownReplies: { command: Batch; status: number; receipt: Receipt }[] = [];
  const attempts: { command: Command; status: number; body: unknown }[] = [];
  await page.route('**/api/mapping/execute', async route => {
    const command = route.request().postDataJSON() as Command;
    if (command.type === 'pose.batch') {
      ownCommands.push(command); events.push('batch-request-held'); await executeGate;
      const response = await route.fetch(); ownReplies.push({ command, status: response.status(), receipt: await response.json() }); events.push('batch-real-response-held');
      await ackGate; await route.fulfill({ response }); events.push('batch-ACK-delivered');
    } else if (command.type === 'thought.delete') {
      events.push('delete-request'); const response = await route.fetch();
      attempts.push({ command, status: response.status(), body: await response.json() }); await route.fulfill({ response });
    } else await route.continue();
  });
  try {
    const nodes = page.locator('.thought-card'); await nodes.nth(0).locator('.title-button').click();
    await nodes.nth(1).locator('.title-button').click({ modifiers: ['Shift'] });
    await expect(page.locator('.react-flow__node.selected')).toHaveCount(2);
    await nodes.nth(0).getByRole('button', { name: '移动卡片：方向键调整位置', exact: true }).press('ArrowRight');
    await expect.poll(() => ownCommands.length).toBe(1); expect(ownReplies).toHaveLength(0);
    expect(ownCommands[0]).toMatchObject({ projectId, type: 'pose.batch', expected: { [first.id]: first.item.versionId, [card.id]: card.item.versionId } });
    expect(ownCommands[0]!.payload.poses.map(value => value.id)).toEqual([first.id, card.id]);
    for (const origin of [first, card]) expect(ownCommands[0]!.payload.poses.find(value => value.id === origin.id)).toEqual({ id: origin.id, ...origin.item.pose, x: origin.item.pose.x + 10 });
    const toolbars = page.getByRole('toolbar', { name: '卡片操作', exact: true }); await expect(toolbars).toHaveCount(2);
    await toolbars.nth(1).getByRole('button', { name: '更多', exact: true }).click();
    await expect(page.locator('.workspace')).toHaveAttribute('data-revision', String(before.project.revision));
    events.push('nonfirst-card-delete-intent');
    await page.getByRole('dialog', { name: '更多', exact: true }).getByRole('button', { name: '删除卡片', exact: true }).click();
    await expect(page.getByRole('dialog', { name: '更多', exact: true })).toHaveCount(0);
    expect(ackReleased).toBe(false); expect(attempts).toHaveLength(0);
    expect(await workspace.state()).toEqual(before); expect(await (await page.request.get(historyUrl)).json()).toEqual(history);
    releaseExecute(); await expect.poll(() => ownReplies.length).toBe(1);
    const own = ownReplies[0]!; expect(own.status).toBe(200);
    expect(own.receipt.commandId).toBe(ownCommands[0]!.commandId); expect(own.receipt.projectId).toBe(projectId);
    expect([...own.receipt.changedIds].sort()).toEqual([first.item.id, card.item.id].sort());
    const saved = await workspace.state(), moved = saved.cards.find(value => value.id === card.id)!, movedFirst = saved.cards.find(value => value.id === first.id)!;
    for (const origin of [first, card]) {
      const actual = saved.cards.find(value => value.id === origin.id)!;
      expect(actual.item.versionId).not.toBe(origin.item.versionId);
      expect(actual).toEqual({ ...origin, item: { ...origin.item, versionId: actual.item.versionId, pose: { ...origin.item.pose, x: origin.item.pose.x + 10 } } });
    }
    expect(moved.item.versionId).not.toBe(movedFirst.item.versionId);
    expect(saved.connectors).toEqual(before.connectors); expect(attempts).toHaveLength(0); expect(ackReleased).toBe(false);
    for (const key of ['tags', 'texts', 'shapes', 'strokes', 'images'] as const) expect(saved[key]).toEqual(before[key]);
    const savedHistory = await (await page.request.get(historyUrl)).json() as ProjectHistory;
    expect(saved.project.revision).toBe(before.project.revision + 1); expect(savedHistory.undo).toHaveLength(history.undo.length + 1);
    const responsePromise = page.waitForResponse(response => response.url().endsWith('/api/mapping/execute') && response.request().postDataJSON()?.type === 'thought.delete');
    releaseAck(); const response = await responsePromise, receipt = await response.json();
    const after = await workspace.state(), afterHistory = await (await page.request.get(historyUrl)).json() as ProjectHistory;
    console.log('issue26-batch-pose-delete', JSON.stringify({ before, history, events, ownCommands, ownReplies, saved, savedHistory, attempts,
      deleteStatus: response.status(), receipt, after, afterHistory, boundary: 'real Shift multi-selection and first-card move-handle ArrowRight; unchanged original pose.batch payload; nonfirst card menu delete intent before real execute200 ACK; no new receipt-field prerequisite or internal-state mutation' }));
    expect(response.status(), '批量移动自身确认后首次删除非首卡应采用该卡的新布局版本').toBe(200);
    expect(ownCommands).toHaveLength(1); expect(attempts).toHaveLength(1);
    expect(attempts[0]!.command).toMatchObject({ projectId, type: 'thought.delete', payload: { id: card.id }, expected: {
      thought: card.versionId, body: card.body.versionId, pose: moved.item.versionId,
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
