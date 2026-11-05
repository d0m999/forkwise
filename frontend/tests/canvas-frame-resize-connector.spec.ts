import { writeFileSync } from 'node:fs';
import { test, expect } from './writing-board-fixture';
import { createFrameCommand } from '../src/canvas-frame-commands';

for (const transformed of [false, true]) test(`左侧bound line重合时W中心命中手柄且一次resize/undo保真 transformed=${transformed}`, async ({ page, workspace }, info) => {
  const initial = await workspace.state(), projectId = initial.project.id;
  const frame = createFrameCommand(initial, [], { x: 300, y: 250, width: 400, height: 300 });
  await workspace.execute(page, frame);
  await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'shape.create', expected: null,
    payload: { id: 'w-target', content: { shapeType: 'rectangle', shortText: '独立端点' }, pose: { x: 850, y: 360, width: 100, height: 80 } } });
  let state = await workspace.state(); const target = state.shapes![0]!;
  await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'connector.create', expected: null,
    payload: { id: 'w-line', start: { kind: 'bound', targetKind: 'frame', itemId: frame.payload.id, side: 'left' }, end: { kind: 'bound', itemId: target.item.id, side: 'left' }, path: 'straight' } });
  await page.reload(); await expect(page.getByRole('status')).toHaveText('已保存到本机');
  await page.getByRole('button', { name: '分区1', exact: true }).click();
  if (transformed) {
    await page.getByRole('button', { name: '放大', exact: true }).click();
    await expect.poll(() => page.locator('.react-flow__viewport').evaluate(el => new DOMMatrix(getComputedStyle(el).transform).a)).toBeGreaterThan(1);
    const pane = (await page.locator('.react-flow__pane').boundingBox())!;
    const beforePan = await page.locator('.react-flow__viewport').evaluate(el => new DOMMatrix(getComputedStyle(el).transform).e);
    await page.mouse.move(pane.x + 120, pane.y + pane.height - 60); await page.mouse.down({ button: 'middle' });
    try { await page.mouse.move(pane.x + 180, pane.y + pane.height - 90, { steps: 5 }); } finally { await page.mouse.up({ button: 'middle' }); }
    await expect.poll(() => page.locator('.react-flow__viewport').evaluate(el => new DOMMatrix(getComputedStyle(el).transform).e)).not.toBe(beforePan);
    await page.getByRole('button', { name: '分区1', exact: true }).click();
  }
  const zoom = await page.locator('.react-flow__viewport').evaluate(el => new DOMMatrix(getComputedStyle(el).transform).a);
  const requests: string[] = []; page.on('request', request => {
    if (request.method() === 'POST' && request.url().endsWith('/api/mapping/execute')) requests.push(request.postDataJSON().type);
  });
  async function inspectAndDrag(label: string) {
    const handle = page.getByRole('button', { name: label, exact: true }); await expect(handle).toBeVisible();
    const box = (await handle.boundingBox())!; const center = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    const hit = await page.evaluate(({ x, y }) => {
      const result = []; let element = document.elementFromPoint(x, y);
      for (let i = 0; element && i < 5; i++, element = element.parentElement)
        result.push({ tag: element.tagName, role: element.getAttribute('role'), label: element.getAttribute('aria-label'), class: element.getAttribute('class') });
      return result;
    }, center);
    const before = await workspace.state();
    const scale = await page.locator('.react-flow__viewport').evaluate(el => new DOMMatrix(getComputedStyle(el).transform).a);
    await page.mouse.move(center.x, center.y); await page.mouse.down();
    try { await page.mouse.move(center.x - 40 * scale, center.y, { steps: 5 }); } finally { await page.mouse.up(); }
    let changed = true;
    try { await expect.poll(async () => (await workspace.state()).frames!.find(v => v.id === frame.payload.id)!.pose).toEqual({ x: expect.closeTo(260, 6), y: expect.closeTo(250, 6), width: expect.closeTo(440, 6), height: expect.closeTo(300, 6) }); }
    catch { changed = false; }
    const after = await workspace.state();
    return { label, handleBox: box, center, hit, changed, beforeRevision: before.project.revision, afterRevision: after.project.revision,
      beforePose: before.frames!.find(v => v.id === frame.payload.id)!.pose, afterPose: after.frames!.find(v => v.id === frame.payload.id)!.pose };
  }
  const west = await inspectAndDrag('调整分区范围：左边缘');
  if (west.changed) {
    state = await workspace.state(); await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'history.undo', expected: state.project.revision, payload: {} });
    await expect.poll(async () => (await workspace.state()).frames![0]!.pose).toEqual({ x: 300, y: 250, width: 400, height: 300 });
    await page.reload(); await expect(page.getByRole('status')).toHaveText('已保存到本机');
  }
  await page.getByRole('button', { name: '分区1', exact: true }).click();
  const northwest = await inspectAndDrag('调整分区范围：左上角');
  const report = { scenario: 'Frame left midpoint bound line, actual W/NW button center horizontal pointer drag', west, northwest, requests, transformed, zoom,
    boundary: 'Synthetic browser fixture diagnostic only; no native data, OS clipboard, product/source/build/runner modification.' };
  writeFileSync(info.outputPath('w-handle-observation.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log('issue43-w-handle-diagnostic', JSON.stringify(report));
  expect(west.hit[0]).toMatchObject({ tag: 'BUTTON', label: '调整分区范围：左边缘' });
  expect(west.changed).toBe(true); expect(west.afterRevision).toBe(west.beforeRevision + 1);
  expect(northwest.changed).toBe(true); expect(northwest.afterRevision).toBe(northwest.beforeRevision + 1);
  expect(requests.filter(type => type === 'frame.resize')).toHaveLength(2);
});

for (const [name, pose] of [
  ['左上角', { x: 320, y: 265, width: 380, height: 285 }],
  ['上边缘', { x: 300, y: 265, width: 400, height: 285 }],
  ['右上角', { x: 300, y: 265, width: 420, height: 285 }],
  ['右边缘', { x: 300, y: 250, width: 420, height: 300 }],
  ['右下角', { x: 300, y: 250, width: 420, height: 315 }],
  ['下边缘', { x: 300, y: 250, width: 400, height: 315 }],
  ['左下角', { x: 320, y: 250, width: 380, height: 315 }],
  ['左边缘', { x: 320, y: 250, width: 380, height: 300 }],
] as const) test(`分区${name}控制层保留原边角轴语义`, async ({ page, workspace }) => {
  await workspace.execute(page, createFrameCommand(await workspace.state(), [], { x: 300, y: 250, width: 400, height: 300 }));
  await page.reload(); await expect(page.getByRole('status')).toHaveText('已保存到本机');
  await page.getByRole('button', { name: '分区1', exact: true }).click();
  const button = page.getByRole('button', { name: '调整分区范围：' + name, exact: true }), b = (await button.boundingBox())!;
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2); await page.mouse.down();
  try { await page.mouse.move(b.x + b.width / 2 + 20, b.y + b.height / 2 + 15, { steps: 5 }); } finally { await page.mouse.up(); }
  await expect.poll(async () => (await workspace.state()).frames![0]!.pose).toEqual(pose);
});
