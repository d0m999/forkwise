import { test, expect } from './writing-board-fixture';
import { createFrameCommand } from '../../backend/tests/nested-frame-fixture';

test('多卡键盘移动冲突逐卡展示分区和保留组合，确认保存各自归属', async ({ page, workspace }) => {
  const projectId = (await workspace.state()).project.id;
  const frame = createFrameCommand(await workspace.state(), [], { x: 245, y: 90, width: 80, height: 160 });
  await workspace.execute(page, frame);
  for (const [id, title, x] of [['first', '第一张', 100], ['second', '第二张', 700]] as const)
    await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'thought.create', expected: null, payload: { id, title, text: '', x, y: 100 } });
  await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'shape.create', expected: null,
    payload: { id: 'peer-shape', content: { shapeType: 'rectangle', shortText: '组合成员' }, pose: { x: 1050, y: 100, width: 100, height: 60 } } });
  await page.reload(); await expect(page.getByRole('status')).toHaveText('已保存到本机');
  const original = await workspace.state(), attempts: { command: any; status: number }[] = [];
  await page.route('**/api/mapping/execute', async route => {
    const command = route.request().postDataJSON();
    if (command.type !== 'pose.batch') return route.continue();
    if (!attempts.length) {
      const itemIds = [original.cards[1]!.item.id, original.shapes![0]!.item.id];
      await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'group.create',
        expected: { groups: { 'peer-group': null }, containment: Object.fromEntries(itemIds.map(id => [id, null])) }, payload: { id: 'peer-group', itemIds } });
    }
    const response = await route.fetch(); attempts.push({ command, status: response.status() }); return route.fulfill({ response });
  });
  try {
    await page.getByRole('button', { name: '第一张', exact: true }).click();
    await page.getByRole('button', { name: '第二张', exact: true }).click({ modifiers: ['Shift'] });
    await expect(page.locator('.react-flow__node.selected')).toHaveCount(2);
    await page.getByRole('button', { name: '移动卡片：方向键调整位置', exact: true }).first().press('ArrowRight');
    const panel = page.getByRole('region', { name: '布局冲突', exact: true }); await expect(panel).toBeVisible();
    expect(attempts[0]!.status).toBe(409); expect(attempts[0]!.command.payload.poses).toHaveLength(2);
    await expect(panel.getByText('第一张：本次位置的分区：分区1', { exact: true })).toBeVisible({ timeout: 3000 });
    await expect(panel.getByText('第二张：本次归属：保留所在组合', { exact: true })).toBeVisible();
    await panel.getByRole('button', { name: '确认保留本次位置', exact: true }).click(); await expect(panel).toHaveCount(0);
    const saved = await workspace.state();
    expect(saved.cards.map(card => card.item.pose.x)).toEqual([110, 710]);
    expect(saved.containment!.find(edge => edge.id === original.cards[0]!.item.id)?.parent).toEqual({ kind: 'frame', id: frame.payload.id });
    expect(saved.containment!.find(edge => edge.id === original.cards[1]!.item.id)?.parent).toEqual({ kind: 'group', id: saved.groups![0]!.itemId });
  } finally { await page.unrouteAll({ behavior: 'wait' }); }
});

test('键盘卡片移动冲突用对方最新尺寸计算无指针落点的分区候选', async ({ page, workspace }) => {
  const projectId = (await workspace.state()).project.id;
  const frame = createFrameCommand(await workspace.state(), [], { x: 390, y: 210, width: 100, height: 100 });
  await workspace.execute(page, frame);
  await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'thought.create', expected: null,
    payload: { id: 'resized-card', title: '远端改尺寸', text: '', x: 100, y: 100 } });
  await page.reload(); await expect(page.getByRole('status')).toHaveText('已保存到本机');
  const original = (await workspace.state()).cards[0]!, attempts: { command: any; status: number }[] = [];
  await page.route('**/api/mapping/execute', async route => {
    const command = route.request().postDataJSON();
    if (command.type !== 'pose.move') return route.continue();
    if (!attempts.length) await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'pose.batch',
      expected: { [original.id]: original.item.versionId }, payload: { poses: [{ id: original.id, x: 100, y: 100, width: 600, height: 300 }] } });
    const response = await route.fetch(); attempts.push({ command, status: response.status() }); return route.fulfill({ response });
  });
  try {
    await page.getByRole('button', { name: '移动卡片：方向键调整位置', exact: true }).press('ArrowRight');
    const panel = page.getByRole('region', { name: '布局冲突', exact: true });
    await expect(panel).toBeVisible();
    expect(attempts[0]!.status).toBe(409); expect(attempts[0]!.command.placement).not.toHaveProperty('point');
    await expect(panel.getByText('本次位置的分区：分区1', { exact: true })).toBeVisible({ timeout: 3000 });
    await panel.getByRole('button', { name: '确认保留本次位置', exact: true }).click();
    await expect(panel).toHaveCount(0);
    const saved = await workspace.state();
    expect(saved.cards[0]!.item.pose).toEqual({ x: 110, y: 100, width: 600, height: 300 });
    expect(saved.containment!.find(edge => edge.id === original.item.id)?.parent).toEqual({ kind: 'frame', id: frame.payload.id });
  } finally { await page.unrouteAll({ behavior: 'wait' }); }
});

for (const peer of ['spatial', 'pose', 'group', 'noop'] as const) test(`卡片移动${peer}冲突重新展示候选，保留指针落点且再次变化继续冲突`, async ({ page, workspace }) => {
  const projectId = (await workspace.state()).project.id;
  await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'thought.create', expected: null,
    payload: { id: 'moving-card', title: '移动卡片', text: '原正文', x: 100, y: 100 } });
  if (peer === 'group') await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'shape.create', expected: null,
    payload: { id: 'peer-shape', content: { shapeType: 'rectangle', shortText: '组合成员' }, pose: { x: 900, y: 100, width: 100, height: 60 } } });
  await page.reload(); await expect(page.getByRole('status')).toHaveText('已保存到本机');
  const original = (await workspace.state()).cards[0]!;
  const commands: { command: any; status: number }[] = [];
  await page.route('**/api/mapping/execute', async route => {
    const command = route.request().postDataJSON();
    if (command.type !== 'pose.move') return route.continue();
    if (!commands.length) {
      const point = command.placement.point;
      await workspace.execute(page, createFrameCommand(await workspace.state(), [], { x: point.x - 15, y: point.y - 20, width: 80, height: 160 }));
      if (peer === 'pose') await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'pose.move', expected: original.item.versionId, payload: { id: original.id, x: 40, y: 80 } });
      if (peer === 'noop') await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'pose.move', expected: original.item.versionId, payload: command.payload });
      if (peer === 'group') {
        const state = await workspace.state(), itemIds = [original.item.id, state.shapes![0]!.item.id];
        await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'group.create',
          expected: { groups: { 'peer-group': null }, containment: Object.fromEntries(itemIds.map(id => [id, null])) }, payload: { id: 'peer-group', itemIds } });
      }
    }
    const response = await route.fetch(); commands.push({ command, status: response.status() });
    if (commands.length === 3 && response.ok()) return route.fulfill({ status: 503, json: { code: 'UNAVAILABLE', message: '已保存移动但ACK未送达' } });
    return route.fulfill({ response });
  });
  try {
    await page.getByRole('button', { name: '对齐吸附', exact: true }).click();
    await page.getByRole('button', { name: '选择', exact: true }).click();
    const title = page.getByRole('button', { name: '移动卡片', exact: true }); await title.click();
    await expect(page.locator(`.react-flow__node[data-id="${original.item.id}"]`)).toHaveClass(/selected/);
    const box = (await title.boundingBox())!;
    await page.mouse.move(box.x + 20, box.y + box.height / 2); await page.mouse.down();
    await page.mouse.move(box.x + 320, box.y + box.height / 2 + 200, { steps: 8 }); await page.mouse.up();
    await expect.poll(() => commands.length).toBe(1);
    const comparison = page.getByRole('region', { name: '布局冲突', exact: true });
    await expect(comparison).toBeVisible();
    await expect(comparison.getByText(peer === 'group' ? '本次归属：保留所在组合' : peer === 'noop' ? '本次位置的分区：画布顶层' : '本次位置的分区：分区1', { exact: true })).toBeVisible({ timeout: 3000 });
    expect(commands[0]!.status).toBe(409);
    const frame = (await workspace.state()).frames![0]!;
    expect(commands[0]!.command.placement.point.x).toBeLessThan(commands[0]!.command.payload.x + original.item.pose.width / 2);
    await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'frame.edit', expected: frame.versionId, payload: { id: frame.id, name: '再次变化的分区', background: frame.background } });
    await comparison.getByRole('button', { name: '确认保留本次位置', exact: true }).click();
    await expect.poll(() => commands.length).toBe(2);
    await expect(comparison.getByText(peer === 'group' ? '本次归属：保留所在组合' : peer === 'noop' ? '本次位置的分区：画布顶层' : '本次位置的分区：再次变化的分区', { exact: true })).toBeVisible();
    expect(commands[1]!.status).toBe(409);
    expect(commands[1]!.command.commandId).not.toBe(commands[0]!.command.commandId);
    await comparison.getByRole('button', { name: '确认保留本次位置', exact: true }).click();
    await expect(page.getByRole('alert').filter({ hasText: '已保存移动但ACK未送达' })).toBeVisible();
    const saved = await workspace.state(), card = saved.cards[0]!;
    expect(card.item.pose).toMatchObject({ x: commands[0]!.command.payload.x, y: commands[0]!.command.payload.y });
    expect(card.body).toEqual(original.body);
    expect(saved.containment!.find(edge => edge.id === card.item.id)?.parent ?? null).toEqual(peer === 'group' ? { kind: 'group', id: saved.groups![0]!.itemId } : peer === 'noop' ? null : { kind: 'frame', id: frame.id });
    for (const attempt of commands) expect(attempt.command.placement.point).toEqual(commands[0]!.command.placement.point);
    await page.getByRole('button', { name: '重试保存', exact: true }).click();
    await expect(page.getByRole('status')).toHaveText('已保存到本机');
    expect(commands[3]!.command).toEqual(commands[2]!.command);
    expect(await workspace.state()).toEqual(saved);
    if (peer === 'noop') {
      const history = await (await page.request.get(`${workspace.origin}/api/mapping/projects/${projectId}/history`)).json();
      expect(history.undo.filter((action: any) => action.label === 'pose.move')).toHaveLength(1);
    }
  } finally { await page.unrouteAll({ behavior: 'wait' }); }
});
