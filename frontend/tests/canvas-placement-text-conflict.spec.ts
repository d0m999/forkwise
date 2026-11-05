import { test, expect } from './writing-board-fixture';
import { createFrameCommand } from '../../backend/tests/nested-frame-fixture';

test('键盘文字移动冲突以实际保留的远端尺寸展示无指针分区候选', async ({ page, workspace }) => {
  const projectId = (await workspace.state()).project.id;
  const frame = createFrameCommand(await workspace.state(), [], { x: 390, y: 80, width: 100, height: 150 });
  await workspace.execute(page, frame);
  await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'text.create', expected: null,
    payload: { id: 'resized-text', content: { runs: [{ text: '文字远端改宽' }], fontSize: 18, lineHeight: 1.5, align: 'left', widthMode: 'fixed', width: 400 }, pose: { x: 100, y: 100, width: 400, height: 27 } } });
  await page.reload(); await expect(page.getByRole('status')).toHaveText('已保存到本机');
  const original = (await workspace.state()).texts![0]!, attempts: { command: any; status: number }[] = [];
  await page.route('**/api/mapping/execute', async route => {
    const command = route.request().postDataJSON();
    if (command.type !== 'text.move') return route.continue();
    if (!attempts.length) await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'text.transform',
      expected: { text: original.versionId, pose: original.item.versionId }, payload: { id: original.id, content: { ...original.content, width: 600 }, pose: { ...original.item.pose, width: 600 } } });
    const response = await route.fetch(); attempts.push({ command, status: response.status() }); return route.fulfill({ response });
  });
  try {
    const target = page.locator('.canvas-text-content'); await target.click(); await target.press('ArrowRight');
    const panel = page.getByRole('region', { name: '独立文字保存冲突', exact: true }); await expect(panel).toBeVisible();
    expect(attempts[0]!.status).toBe(409); expect(attempts[0]!.command.placement).not.toHaveProperty('point');
    await expect(panel.getByText('本次位置的分区：分区1', { exact: true })).toBeVisible({ timeout: 3000 });
    await panel.getByRole('button', { name: '确认保留我的文字', exact: true }).click(); await expect(panel).toHaveCount(0);
    const saved = await workspace.state(), text = saved.texts!.find(value => value.id === original.id)!;
    expect(text.item.pose).toEqual({ x: 110, y: 100, width: 600, height: 27 });
    expect(saved.containment!.find(edge => edge.id === original.item.id)?.parent).toEqual({ kind: 'frame', id: frame.payload.id });
  } finally { await page.unrouteAll({ behavior: 'wait' }); }
});

for (const phase of ['execute', 'prepare', 'format', 'group', 'noop'] as const) test(`独立文字${phase}移动冲突保留指针候选并明确确认归属`, async ({ page, workspace }) => {
  const projectId = (await workspace.state()).project.id;
  const frameCommand = createFrameCommand(await workspace.state(), [], { x: 390, y: 250, width: 80, height: 200 });
  await workspace.execute(page, frameCommand);
  await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'text.create', expected: null,
    payload: { id: 'moving-text', content: { runs: [{ text: '保留指针意图' }], fontSize: 18, lineHeight: 1.5, align: 'left', widthMode: 'fixed', width: 400 }, pose: { x: 100, y: 100, width: 400, height: 27 } } });
  if (phase === 'group') await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'shape.create', expected: null,
    payload: { id: 'peer-shape', content: { shapeType: 'rectangle', shortText: '组合成员' }, pose: { x: 900, y: 100, width: 100, height: 60 } } });
  await page.reload(); await expect(page.getByRole('status')).toHaveText('已保存到本机');
  await page.getByRole('button', { name: '对齐吸附', exact: true }).click();
  const initial = (await workspace.state()).texts![0]!;
  const target = page.locator('.canvas-text-content'); await target.click();
  let release = () => {}, held = false, hold = phase === 'format';
  const gate = new Promise<void>(resolve => { release = resolve; });
  const attempts: { command: any; status: number }[] = [];
  await page.route('**/api/mapping/projects/*/map?**', async route => {
    if (hold && new URL(route.request().url()).searchParams.get('view') === 'index') {
      hold = false; const response = await route.fetch(); held = true; await gate; return route.fulfill({ response });
    }
    return route.continue();
  });
  await page.route('**/api/mapping/execute', async route => {
    const command = route.request().postDataJSON();
    if (command.payload.id !== initial.id || !['text.move', 'text.transform'].includes(command.type)) return route.continue();
    if (phase === 'execute' && !attempts.length) {
      const frame = (await workspace.state()).frames![0]!;
      await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'frame.edit', expected: frame.versionId, payload: { id: frame.id, name: '新候选分区', background: frame.background } });
    }
    if (phase === 'noop' && !attempts.length) await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'text.move', expected: initial.item.versionId, payload: command.payload });
    const response = await route.fetch(); attempts.push({ command, status: response.status() });
    if (phase === 'execute' && attempts.length === 3 && response.ok()) return route.fulfill({ status: 503, json: { code: 'UNAVAILABLE', message: '文字移动已保存但ACK未送达' } });
    return route.fulfill({ response });
  });
  try {
    const box = (await target.boundingBox())!;
    await page.mouse.move(box.x + 20, box.y + 10); await page.mouse.down();
    if (phase === 'prepare' || phase === 'format') await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'text.move', expected: initial.item.versionId, payload: { id: initial.id, x: 850, y: 100 } });
    if (phase === 'group') {
      const state = await workspace.state(), itemIds = [initial.item.id, state.shapes![0]!.item.id];
      await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'group.create',
        expected: { groups: { 'peer-group': null }, containment: Object.fromEntries(itemIds.map(id => [id, null])) }, payload: { id: 'peer-group', itemIds } });
    }
    await page.mouse.move(box.x + 320, box.y + 170, { steps: 5 }); await page.mouse.up();
    if (phase === 'format') {
      await expect.poll(() => held).toBe(true);
      await page.getByRole('spinbutton', { name: '文字字号', exact: true }).fill('24');
      await page.getByRole('button', { name: '文字居中', exact: true }).click();
      release();
    }
    const panel = page.getByRole('region', { name: '独立文字保存冲突', exact: true });
    await expect(panel).toBeVisible();
    await expect(panel.getByText(phase === 'group' ? '本次归属：保留所在组合' : `本次位置的分区：${phase === 'noop' ? '画布顶层' : phase === 'execute' ? '新候选分区' : '分区1'}`, { exact: true })).toBeVisible({ timeout: 3000 });
    if (phase === 'execute' || phase === 'group' || phase === 'noop') expect(attempts[0]!.status).toBe(409);
    else expect(attempts).toEqual([]);
    const peer = await workspace.state(), remote = peer.texts![0]!;
    if (phase === 'execute') {
      const frame = peer.frames![0]!;
      await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'frame.edit', expected: frame.versionId,
        payload: { id: frame.id, name: '再次变化的分区', background: frame.background } });
      await panel.getByRole('button', { name: '确认保留我的文字', exact: true }).click();
      await expect(panel.getByText('本次位置的分区：再次变化的分区', { exact: true })).toBeVisible();
      expect(attempts[1]!.status).toBe(409);
    }
    await panel.getByRole('button', { name: '确认保留我的文字', exact: true }).click();
    if (phase === 'execute') {
      await expect(page.getByRole('alert').filter({ hasText: '文字移动已保存但ACK未送达' }).first()).toBeVisible();
      const committed = await workspace.state();
      await page.getByRole('button', { name: '重试文字保存', exact: true }).click();
      await expect(panel).toHaveCount(0);
      expect(attempts[3]!.command).toEqual(attempts[2]!.command);
      expect(await workspace.state()).toEqual(committed);
    }
    await expect(panel).toHaveCount(0);
    const saved = await workspace.state(), original = saved.texts!.find(text => text.id === initial.id)!;
    const command = attempts.at(-1)!;
    expect(command.status).toBe(200);
    expect(command.command.type).toBe(phase === 'format' ? 'text.transform' : 'text.move');
    expect(command.command.placement.point).toEqual({ x: 420, y: 270 });
    expect(original.item.pose).toMatchObject({ x: 400, y: 260 });
    const parent = phase === 'group' ? { kind: 'group', id: saved.groups![0]!.itemId } : phase === 'noop' ? null : { kind: 'frame', id: frameCommand.payload.id };
    expect(saved.containment!.find(edge => edge.id === original.item.id)?.parent ?? null).toEqual(parent);
    if (phase === 'noop') {
      const history = await (await page.request.get(`${workspace.origin}/api/mapping/projects/${projectId}/history`)).json();
      expect(history.undo.filter((action: any) => action.label === 'text.move')).toHaveLength(1);
    }
    expect(saved.texts!.find(text => text.id !== initial.id)!.content).toEqual(remote.content);
    expect(original.content).toEqual(phase === 'format' ? { ...initial.content, fontSize: 24, align: 'center' } : initial.content);
    await page.getByRole('button', { name: '撤销', exact: true }).click();
    await expect.poll(async () => (await workspace.state()).texts!.find(text => text.id === initial.id)!.item.pose).toEqual(remote.item.pose);
    expect((await workspace.state()).containment!.find(edge => edge.id === original.item.id)?.parent ?? null).toEqual(peer.containment!.find(edge => edge.id === original.item.id)?.parent ?? null);
    await page.getByRole('button', { name: '重做', exact: true }).click();
    await expect.poll(async () => (await workspace.state()).containment!.find(edge => edge.id === original.item.id)?.parent ?? null).toEqual(parent);
  } finally { release(); await page.unrouteAll({ behavior: 'wait' }); }
});
