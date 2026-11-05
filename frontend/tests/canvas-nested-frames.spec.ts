import { test, expect } from './writing-board-fixture';
import { createFrameCommand } from '../src/canvas-frame-commands';

test('嵌套分区正式投影重开后可见，选中子框可调整边界且一次撤销恢复', async ({ page, workspace }) => {
  let state = await workspace.state();
  const outer = createFrameCommand(state, [], { x: 100, y: 140, width: 900, height: 550 });
  await workspace.execute(page, outer);
  state = await workspace.state();
  const inner = createFrameCommand(state, [], { x: 250, y: 270, width: 350, height: 220 });
  await workspace.execute(page, inner);
  await page.reload();
  await expect(page.getByRole('status')).toHaveText('已保存到本机');
  await expect(page.locator('[data-frame-id]')).toHaveCount(2);
  await page.getByRole('button', { name: '分区2', exact: true }).click();
  const handle = page.getByRole('button', { name: '调整分区范围：右下角', exact: true });
  await expect(handle).toBeVisible();
  const box = (await handle.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 90, box.y + box.height / 2 + 70, { steps: 5 });
  await page.mouse.up();
  await expect.poll(async () => (await workspace.state()).frames!.find(v => v.id === inner.payload.id)!.pose.width).toBe(440);
  await expect(page.getByRole('status')).toHaveText('已保存到本机');
  const resized = await workspace.state();
  expect(resized.frames!.find(v => v.id === inner.payload.id)!.pose).toEqual({ x: 250, y: 270, width: 440, height: 290 });
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect.poll(async () => (await workspace.state()).frames!.find(v => v.id === inner.payload.id)!.pose.width).toBe(350);
  await workspace.restart(); await page.reload();
  await expect(page.getByRole('status')).toHaveText('已保存到本机');
  const reopened = await workspace.state();
  expect(reopened.containment!.find(v => v.id === inner.payload.id)?.parent).toEqual({ kind: 'frame', id: outer.payload.id });
});

test('边手柄的斜向指针只改对应轴，四角才同时改变宽高', async ({ page, workspace }) => {
  const command = createFrameCommand(await workspace.state(), [], { x: 200, y: 240, width: 400, height: 300 });
  await workspace.execute(page, command); await page.reload();
  await expect(page.getByRole('status')).toHaveText('已保存到本机');
  await page.getByRole('button', { name: '分区1', exact: true }).click();
  async function drag(corner: string, dx: number, dy: number) {
    const b = (await page.getByRole('button', { name: `调整分区范围：${corner === 'e' ? '右边缘' : '上边缘'}`, exact: true }).boundingBox())!;
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2); await page.mouse.down();
    await page.mouse.move(b.x + b.width / 2 + dx, b.y + b.height / 2 + dy, { steps: 5 }); await page.mouse.up();
    await expect(page.getByRole('status')).toHaveText('已保存到本机');
  }
  await drag('e', 80, 30);
  await expect.poll(async () => (await workspace.state()).frames![0]!.pose).toEqual({ x: 200, y: 240, width: 480, height: 300 });
  await drag('n', 40, -20);
  await expect.poll(async () => (await workspace.state()).frames![0]!.pose).toEqual({ x: 200, y: 220, width: 480, height: 320 });
});

test('分区手柄Tab可达，方向键预览可Esc取消，Enter一次保存且保留焦点', async ({ page, workspace }) => {
  await workspace.execute(page, createFrameCommand(await workspace.state(), [], { x: 200, y: 240, width: 400, height: 300 }));
  await page.reload(); await expect(page.getByRole('status')).toHaveText('已保存到本机');
  await page.getByRole('button', { name: '分区1', exact: true }).click();
  const frame = page.locator('[data-frame-id]'), handle = page.getByRole('button', { name: '调整分区范围：右边缘', exact: true });
  for (let i = 0; i < 12; i++) { if (await handle.evaluate(el => el === document.activeElement)) break; await page.keyboard.press('Tab'); }
  await expect(handle).toBeFocused();
  const before = await workspace.state();
  await handle.press('ArrowRight'); await expect(frame).toHaveCSS('width', '410px');
  await handle.press('Escape'); await expect(frame).toHaveCSS('width', '400px');
  expect((await workspace.state()).project.revision).toBe(before.project.revision);
  await handle.press('ArrowRight'); await handle.press('Enter');
  await expect.poll(async () => (await workspace.state()).frames![0]!.pose.width).toBe(410);
  await expect(handle).toBeFocused();
  expect((await workspace.state()).project.revision).toBe(before.project.revision + 1);
});

test('跨枝重叠区新画分区在松手前显示唯一父候选，提交归属与预览一致', async ({ page, workspace }) => {
  for (const pose of [{ x: 100, y: 100, width: 450, height: 400 }, { x: 350, y: 200, width: 450, height: 400 }])
    await workspace.execute(page, createFrameCommand(await workspace.state(), [], pose));
  await page.reload(); await expect(page.getByRole('status')).toHaveText('已保存到本机');
  const frames = (await workspace.state()).frames!, front = frames[1]!;
  await page.getByRole('button', { name: '分区', exact: true }).click();
  const bounds = (await page.locator('.react-flow__pane').boundingBox())!;
  await page.mouse.move(bounds.x + 425, bounds.y + 275); await page.mouse.down();
  await page.mouse.move(bounds.x + 525, bounds.y + 375, { steps: 5 });
  try { await expect(page.locator('[data-frame-id][data-drop-candidate=true]')).toHaveAttribute('data-frame-id', front.id); }
  finally { await page.mouse.up(); }
  await expect.poll(async () => (await workspace.state()).frames!.length).toBe(3);
  const state = await workspace.state(), created = state.frames![2]!;
  expect(state.containment!.find(v => v.id === created.id)?.parent).toEqual({ kind: 'frame', id: front.id });
  expect(state.frames!.map(v => v.id).slice(0, 2)).toEqual(frames.map(v => v.id));
});

test('形状409重读后可见刷新分区候选，明确确认才以新命令保存且未知请求原样重试', async ({ page, workspace }) => {
  const frame = createFrameCommand(await workspace.state(), [], { x: 300, y: 200, width: 400, height: 400 });
  await workspace.execute(page, frame);
  await workspace.execute(page, { commandId: crypto.randomUUID(), projectId: frame.projectId, type: 'shape.create', expected: null,
    payload: { id: 'candidate-conflict', content: { shapeType: 'rectangle', shortText: '候选竞争形状' }, pose: { x: 100, y: 100, width: 120, height: 60 } } });
  await page.reload(); await expect(page.getByRole('status')).toHaveText('已保存到本机');
  const attempts: { command: any; status: number }[] = [];
  await page.route('**/api/mapping/execute', async route => {
    const command = route.request().postDataJSON();
    if (command.type !== 'shape.move') return route.continue();
    if (!attempts.length) { attempts.push({ command, status: 503 }); return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ code: 'UNAVAILABLE', message: '候选测试未知请求' }) }); }
    const response = await route.fetch(); attempts.push({ command, status: response.status() }); return route.fulfill({ response });
  });
  const shape = page.getByRole('img', { name: '候选竞争形状', exact: true }); await shape.click();
  const box = (await shape.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 240, box.y + box.height / 2 + 160, { steps: 5 }); await page.mouse.up();
  await expect(page.getByRole('alert').filter({ hasText: '候选测试未知请求' })).toBeVisible();
  const { moveFrameCommand } = await import('../src/canvas-frame-commands');
  const current = await workspace.state(); await workspace.execute(page, moveFrameCommand(current, current.frames![0]!, 1000, 0));
  const replacement = createFrameCommand(await workspace.state(), [], { x: 300, y: 200, width: 400, height: 400 });
  await workspace.execute(page, replacement);
  await page.getByRole('button', { name: '重试保存形状位置', exact: true }).click();
  const comparison = page.getByRole('region', { name: '形状位置保存冲突', exact: true });
  await expect(comparison.getByText('本次位置的分区：分区2', { exact: true })).toBeVisible();
  expect(attempts).toHaveLength(2); expect(attempts[1]!.status).toBe(409); expect(attempts[1]!.command).toEqual(attempts[0]!.command);
  await comparison.getByRole('button', { name: '确认保留本次位置', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('已保存到本机');
  expect(attempts[2]!.status).toBe(200); expect(attempts[2]!.command.commandId).not.toBe(attempts[0]!.command.commandId);
  const saved = await workspace.state(), item = saved.shapes![0]!;
  expect(saved.containment!.find(v => v.id === item.item.id)?.parent).toEqual({ kind: 'frame', id: replacement.payload.id });
});

for (const method of ['duplicate', 'paste'] as const) test(`Frame内${method}撤销/重做后完整compact投影与同库重开仍可编辑`, async ({ page, workspace }) => {
  await workspace.execute(page, createFrameCommand(await workspace.state(), [], { x: 100, y: 100, width: 800, height: 550 }));
  let state = await workspace.state(); const projectId = state.project.id;
  await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'shape.create', expected: null,
    payload: { id: 'history-original', content: { shapeType: 'rectangle', shortText: '历史原件' }, pose: { x: 200, y: 200, width: 120, height: 80 } } });
  state = await workspace.state(); const shape = state.shapes![0]!;
  const command = method === 'duplicate' ? { type: 'canvas.duplicate', expected: { cards: {}, texts: {}, shapes: { [shape.id]: { content: shape.versionId, pose: shape.item.versionId } }, images: {}, strokes: {}, connectors: {}, anchors: {} },
    payload: { objects: [{ kind: 'shape', id: shape.id, copyId: 'history-copy' }], connectors: [] } }
    : { type: 'canvas.paste', expected: null, payload: { translation: { x: 24, y: 24 }, connectors: [], objects: [{ kind: 'shape', copyId: 'history-copy', stack: 1, content: shape.content, pose: shape.item.pose }] } };
  await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, ...command });
  const copy = (await workspace.state()).shapes!.find(v => v.id === 'history-copy')!;
  for (const direction of ['history.undo', 'history.redo'] as const) {
    state = await workspace.state();
    await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: direction, expected: state.project.revision, payload: {} });
    await workspace.restart(); await page.reload();
    await expect(page.getByRole('status')).toHaveText('已保存到本机');
    await expect(page.locator('[data-frame-id]')).toHaveCount(1);
    await expect(page.getByRole('img', { name: '历史原件', exact: true })).toHaveCount(direction === 'history.undo' ? 1 : 2);
    state = await workspace.state();
    expect(state.containment!.find(v => v.id === copy.item.id)?.parent ?? null).toEqual(direction === 'history.undo' ? null : { kind: 'frame', id: state.frames![0]!.id });
  }
  await page.getByRole('img', { name: '历史原件', exact: true }).last().click();
  await expect(page.getByRole('button', { name: '删除形状', exact: true })).toBeVisible();
});
