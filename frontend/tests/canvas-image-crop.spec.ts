import { test, expect, place } from './writing-board-fixture';
import { seedCrop } from './canvas-image-crop-fixture';
import { twoFrameGif } from './image-reading-fixtures';
import { createCanvas, loadImage } from '../../backend/node_modules/@napi-rs/canvas/index.js';

test('画布菜单自由裁剪先预览，明确完成保中央200×150且只保存一次', async ({ page, workspace }) => {
  const projectId = (await workspace.state()).project.id;
  const source = '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300"><rect width="400" height="300" fill="blue"/><rect x="100" y="75" width="200" height="150" fill="green"/></svg>';
  await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'asset.save', expected: null,
    payload: { id: 'crop-original', name: '自由裁剪.svg', mime: 'image/svg+xml', base64: Buffer.from(source).toString('base64') } });
  await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'image.create', expected: null,
    payload: { id: 'crop-image', content: { assetId: 'crop-original', crop: { x: 0, y: 0, width: 1, height: 1 } },
      pose: { x: 100, y: 80, width: 400, height: 300, rotation: 0 } } });
  await page.reload();
  const original = await workspace.state();
  const history = async () => (await page.request.get(`${workspace.origin}/api/mapping/projects/${projectId}/history`)).json();
  const originalHistory = await history();
  const asset = async () => (await page.request.get(`${workspace.origin}/api/mapping/projects/${projectId}/assets/crop-original/content`)).body();
  const originalBytes = await asset();
  expect(originalBytes.toString()).toBe(source);
  const commands: any[] = [];
  page.on('request', request => {
    if (request.url().endsWith('/api/mapping/execute') && request.method() === 'POST') commands.push(request.postDataJSON());
  });
  await page.getByRole('img', { name: '自由裁剪.svg', exact: true }).click();
  await page.getByRole('toolbar', { name: '图片操作', exact: true }).getByRole('button', { name: '裁剪', exact: true }).click();
  const crop = page.getByRole('region', { name: '图片裁剪', exact: true });
  await expect(crop).toBeVisible();
  const originalView = crop.getByRole('img', { name: '裁剪原图', exact: true });
  const frame = crop.getByRole('group', { name: '裁剪范围', exact: true });
  const originalBox = (await originalView.boundingBox())!;
  await expect(originalView.locator('img')).toHaveJSProperty('naturalWidth', 400);
  await expect(originalView.locator('img')).toHaveJSProperty('naturalHeight', 300);
  const northwest = crop.getByRole('button', { name: '调整裁剪范围：左上', exact: true });
  const southeast = crop.getByRole('button', { name: '调整裁剪范围：右下', exact: true });
  for (let i = 0; i < 10; i++) await northwest.press('Shift+ArrowRight');
  const freeBox = (await frame.boundingBox())!;
  expect(freeBox.width / originalBox.width).toBeCloseTo(0.75, 6);
  expect(freeBox.height / originalBox.height).toBeCloseTo(1, 6);
  for (let i = 0; i < 7; i++) await northwest.press('Shift+ArrowDown');
  for (let i = 0; i < 5; i++) await northwest.press('ArrowDown');
  for (let i = 0; i < 10; i++) await southeast.press('Shift+ArrowLeft');
  for (let i = 0; i < 7; i++) await southeast.press('Shift+ArrowUp');
  for (let i = 0; i < 5; i++) await southeast.press('ArrowUp');
  const previewBox = (await frame.boundingBox())!;
  expect((previewBox.x - originalBox.x) / originalBox.width).toBeCloseTo(0.25, 6);
  expect((previewBox.y - originalBox.y) / originalBox.height).toBeCloseTo(0.25, 6);
  expect(previewBox.width / originalBox.width).toBeCloseTo(0.5, 6);
  expect(previewBox.height / originalBox.height).toBeCloseTo(0.5, 6);
  expect(await originalView.boundingBox()).toEqual(originalBox);
  expect(await workspace.state()).toEqual(original);
  expect(await history()).toEqual(originalHistory);
  expect(commands).toEqual([]);
  await crop.getByRole('button', { name: '完成', exact: true }).click();
  await expect(crop).toHaveCount(0);
  await expect(page.getByRole('status')).toHaveText('已保存到本机');
  await expect.poll(async () => (await workspace.state()).images![0]!.item.pose).toEqual({ x: 200, y: 155, width: 200, height: 150, rotation: 0 });
  const saved = (await workspace.state()).images![0]!;
  expect(saved.content).toEqual({ assetId: 'crop-original', crop: { x: 0.25, y: 0.25, width: 0.5, height: 0.5 } });
  expect(saved.id).toBe(original.images![0]!.id);
  expect(saved.item.id).toBe(original.images![0]!.item.id);
  expect((await history()).undo.map((action: any) => action.label)).toEqual([...originalHistory.undo.map((action: any) => action.label), 'image.crop']);
  expect(commands.map(command => command.type)).toEqual(['image.crop']);
  expect(await asset()).toEqual(originalBytes);
});

test('缩放画布拖裁剪边后框内拖动只平移框，原图固定且preview不写', async ({ page, workspace }) => {
  const f = await seedCrop(page, workspace);
  const before = { project: await workspace.state(), history: await f.history() };
  await page.locator('button.react-flow__controls-zoomout').click();
  const crop = await f.enter();
  const zoom = await page.locator('.react-flow__viewport').evaluate(element => new DOMMatrix(getComputedStyle(element).transform).a);
  expect(zoom).toBeLessThan(1);
  const original = crop.getByRole('img', { name: '裁剪原图', exact: true });
  const originalBox = (await original.boundingBox())!;
  const frame = crop.getByRole('group', { name: '裁剪范围', exact: true });
  const east = (await crop.getByRole('button', { name: '调整裁剪范围：右', exact: true }).boundingBox())!;
  await page.mouse.move(east.x + east.width / 2, east.y + east.height / 2); await page.mouse.down();
  await page.mouse.move(east.x + east.width / 2 - 20 * zoom, east.y + east.height / 2, { steps: 4 }); await page.mouse.up();
  const resized = (await frame.boundingBox())!;
  expect(resized.width / zoom).toBeCloseTo(180, 1); expect(resized.height / zoom).toBeCloseTo(150, 1);
  await page.mouse.move(resized.x + resized.width / 2, resized.y + resized.height / 2); await page.mouse.down();
  await page.mouse.move(resized.x + resized.width / 2 + 30 * zoom, resized.y + resized.height / 2 + 20 * zoom, { steps: 4 }); await page.mouse.up();
  const moved = (await frame.boundingBox())!;
  expect((moved.x - resized.x) / zoom).toBeCloseTo(30, 1);
  expect((moved.y - resized.y) / zoom).toBeCloseTo(20, 1);
  expect(moved.width).toBe(resized.width); expect(moved.height).toBe(resized.height);
  expect(await original.boundingBox()).toEqual(originalBox);
  expect({ project: await workspace.state(), history: await f.history() }).toEqual(before);
  await crop.getByRole('button', { name: '完成', exact: true }).click();
  await expect(crop).toHaveCount(0);
  const saved = (await workspace.state()).images![0]!;
  expect(saved.item.pose.x).toBeCloseTo(230, 1); expect(saved.item.pose.y).toBeCloseTo(175, 1);
  expect(saved.item.pose.width).toBeCloseTo(180, 1); expect(saved.item.pose.height).toBeCloseTo(150, 1);
  expect((await f.history()).undo).toHaveLength(before.history.undo.length + 1);
  expect((await f.asset()).toString()).toBe(f.source);
});

test('裁剪普通外点不穿透背景或改变preview，Esc恢复已应用裁剪', async ({ page, workspace }) => {
  const f = await seedCrop(page, workspace);
  await place(page, '裁剪背景卡片', 800, 500);
  const before = { project: await workspace.state(), history: await f.history(), bytes: await f.asset() };
  const crop = await f.enter();
  await crop.getByRole('button', { name: '调整裁剪范围：右', exact: true }).press('Shift+ArrowLeft');
  const frame = crop.getByRole('group', { name: '裁剪范围', exact: true });
  const preview = (await frame.boundingBox())!;
  const selected = () => page.locator('.react-flow__node.selected').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-id')));
  const selectedBefore = await selected();
  await page.locator('.react-flow__pane').click({ position: { x: 1100, y: 720 } });
  expect(await frame.boundingBox()).toEqual(preview); expect(await selected()).toEqual(selectedBefore);
  await page.getByText('裁剪背景卡片', { exact: true }).click();
  expect(await frame.boundingBox()).toEqual(preview); expect(await selected()).toEqual(selectedBefore);
  expect(await page.getByLabel('卡片正文', { exact: true }).count()).toBe(0);
  expect({ project: await workspace.state(), history: await f.history(), bytes: await f.asset() }).toEqual(before);
  await crop.press('Escape');
  await expect(crop).toHaveCount(0);
  expect({ project: await workspace.state(), history: await f.history(), bytes: await f.asset() }).toEqual(before);
  await expect(f.visual).toBeFocused();
});

test('减少动态下GIF裁剪显式播放暂停，取消保播放偏好且不写项目原件', async ({ page, workspace }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const bytes = twoFrameGif(), chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: '图片', exact: true }).click();
  await (await chooser).setFiles({ name: '裁剪动图.gif', mimeType: 'image/gif', buffer: bytes });
  const visual = page.getByRole('img', { name: '裁剪动图.gif', exact: true });
  const play = page.getByRole('button', { name: '播放动图', exact: true });
  await expect(play).toBeEnabled(); await expect(page.getByRole('status')).toHaveText('已保存到本机');
  const samples = async (frame: typeof visual, count: number) => {
    const colors: string[] = [];
    for (let index = 0; index < count; index++) {
      const image = await loadImage(await frame.screenshot()), canvas = createCanvas(image.width, image.height);
      canvas.getContext('2d').drawImage(image, 0, 0);
      colors.push(String(Array.from(canvas.getContext('2d').getImageData(40, 30, 1, 1).data)));
      await page.waitForTimeout(80);
    }
    return colors;
  };
  expect(await samples(visual, 3)).toEqual(['255,0,0,255', '255,0,0,255', '255,0,0,255']);
  const initial = await workspace.state(), projectId = initial.project.id, image = initial.images![0]!;
  const history = async () => (await page.request.get(`${workspace.origin}/api/mapping/projects/${projectId}/history`)).json();
  const asset = async () => (await page.request.get(`${workspace.origin}/api/mapping/projects/${projectId}/assets/${image.content.assetId}/content`)).body();
  const before = { project: initial, history: await history(), bytes: await asset() };
  expect(before.bytes).toEqual(bytes);
  await visual.click(); await page.getByRole('button', { name: '裁剪', exact: true }).click();
  const crop = page.getByRole('region', { name: '图片裁剪', exact: true });
  const frame = crop.getByRole('img', { name: '裁剪原图', exact: true });
  await expect(crop.getByRole('button', { name: '播放动图', exact: true })).toBeEnabled();
  expect(await samples(frame, 3)).toEqual(['255,0,0,255', '255,0,0,255', '255,0,0,255']);
  await crop.getByRole('button', { name: '播放动图', exact: true }).click();
  const playing = await samples(frame, 8);
  expect(playing).toContain('255,0,0,255'); expect(playing).toContain('0,255,0,255');
  await crop.getByRole('button', { name: '暂停动图', exact: true }).click();
  expect(new Set(await samples(frame, 3)).size).toBe(1);
  await crop.getByRole('button', { name: '取消', exact: true }).click();
  await expect(crop).toHaveCount(0); await expect(visual).toBeFocused(); await expect(play).toBeEnabled();
  expect(new Set(await samples(visual, 3)).size).toBe(1);
  expect({ project: await workspace.state(), history: await history(), bytes: await asset() }).toEqual(before);
});

test('已裁图移到画布边缘重入时完成取消均可点击，缩放后仍可达', async ({ page, workspace }) => {
  const f = await seedCrop(page, workspace, { crop: { x: 0.75, y: 0.75, width: 0.25, height: 0.25 },
    pose: { x: 400, y: 300, width: 100, height: 75, rotation: 0 } });
  const image = (await workspace.state()).images![0]!;
  await workspace.execute(page, { commandId: crypto.randomUUID(), projectId: f.projectId, type: 'image.transform',
    expected: { image: image.versionId, pose: image.item.versionId }, payload: { id: image.id, pose: { x: 8, y: 8, width: 100, height: 75 } } });
  await page.reload();
  const before = { project: await workspace.state(), history: await f.history(), bytes: await f.asset() };
  const accessible = async () => {
    const bounds = (await page.locator('main.canvas').boundingBox())!;
    const crop = page.getByRole('region', { name: '图片裁剪', exact: true });
    for (const name of ['完成', '取消']) {
      const button = crop.getByRole('button', { name, exact: true }); await expect(button).toBeVisible();
      const box = (await button.boundingBox())!;
      expect(box.x, name + '左边在可见画布内').toBeGreaterThanOrEqual(bounds.x);
      expect(box.y, name + '上边在可见画布内').toBeGreaterThanOrEqual(bounds.y);
      expect(box.x + box.width, name + '右边在可见画布内').toBeLessThanOrEqual(bounds.x + bounds.width);
      expect(box.y + box.height, name + '下边在可见画布内').toBeLessThanOrEqual(bounds.y + bounds.height);
    }
  };
  let crop = await f.enter(); await accessible();
  expect({ project: await workspace.state(), history: await f.history(), bytes: await f.asset() }).toEqual(before);
  await crop.getByRole('button', { name: '取消', exact: true }).click(); await expect(crop).toHaveCount(0);
  expect({ project: await workspace.state(), history: await f.history(), bytes: await f.asset() }).toEqual(before);
  await page.locator('button.react-flow__controls-zoomout').click();
  expect(await page.locator('.react-flow__viewport').evaluate(element => new DOMMatrix(getComputedStyle(element).transform).a)).toBeLessThan(1);
  crop = await f.enter(); await accessible();
  await crop.getByRole('button', { name: '调整裁剪范围：右', exact: true }).press('Shift+ArrowLeft');
  await accessible();
  expect({ project: await workspace.state(), history: await f.history(), bytes: await f.asset() }).toEqual(before);
  await crop.getByRole('button', { name: '完成', exact: true }).click(); await expect(crop).toHaveCount(0);
  const saved = (await workspace.state()).images![0]!;
  expect(saved.content).toEqual({ assetId: 'crop-original', crop: { x: 0.75, y: 0.75, width: 0.225, height: 0.25 } });
  expect(saved.item.pose.x).toBeCloseTo(8, 8); expect(saved.item.pose.y).toBeCloseTo(8, 8);
  expect(saved.item.pose.width).toBe(90); expect(saved.item.pose.height).toBe(75);
  expect((await f.history()).undo).toHaveLength(before.history.undo.length + 1);
  expect(await f.asset()).toEqual(before.bytes);
});

test('非二进制小数裁剪旋转180后无调整直接完成不改全状态且保可用redo', async ({ page, workspace }) => {
  const f = await seedCrop(page, workspace, { crop: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 },
    pose: { x: 500, y: 300, width: 120, height: 120, rotation: 180 } });
  const image = (await workspace.state()).images![0]!;
  await workspace.execute(page, { commandId: crypto.randomUUID(), projectId: f.projectId, type: 'image.transform',
    expected: { image: image.versionId, pose: image.item.versionId }, payload: { id: image.id, pose: { x: 510, y: 300, width: 120, height: 120 } } });
  await page.reload(); await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect.poll(async () => (await workspace.state()).images![0]!.item.pose.x).toBe(500);
  const redo = page.getByRole('button', { name: '重做', exact: true }); await expect(redo).toBeEnabled();
  const before = { project: await workspace.state(), history: await f.history(), bytes: await f.asset() };
  expect(before.history.redo).toHaveLength(1);
  const crop = await f.enter();
  await crop.getByRole('button', { name: '完成', exact: true }).click(); await expect(crop).toHaveCount(0);
  expect({ project: await workspace.state(), history: await f.history(), bytes: await f.asset() }).toEqual(before);
  await expect(redo).toBeEnabled(); await redo.click();
  await expect.poll(async () => (await workspace.state()).images![0]!.item.pose).toEqual({ x: 510, y: 300, width: 120, height: 120, rotation: 180 });
});

test('旋转拉伸后向原图右边界扩大裁剪成功，preview不写且一次保存可撤销', async ({ page, workspace }) => {
  const f = await seedCrop(page, workspace, { crop: { x: 0.2, y: 0.2, width: 0.25, height: 0.4 },
    pose: { x: 500, y: 300, width: 120, height: 120, rotation: 180 } });
  const before = { project: await workspace.state(), history: await f.history(), bytes: await f.asset() };
  const commands: any[] = [];
  page.on('request', request => {
    if (request.url().endsWith('/api/mapping/execute') && request.method() === 'POST') commands.push(request.postDataJSON());
  });
  const crop = await f.enter();
  const original = crop.getByRole('img', { name: '裁剪原图', exact: true });
  const originalBox = (await original.boundingBox())!;
  const east = (await crop.getByRole('button', { name: '调整裁剪范围：右', exact: true }).boundingBox())!;
  await page.mouse.move(east.x + east.width / 2, east.y + east.height / 2); await page.mouse.down();
  await page.mouse.move(originalBox.x + originalBox.width + 24, east.y + east.height / 2, { steps: 4 }); await page.mouse.up();
  const frame = (await crop.getByRole('group', { name: '裁剪范围', exact: true }).boundingBox())!;
  expect(frame.x + frame.width).toBeCloseTo(originalBox.x + originalBox.width, 1);
  expect(frame.width / originalBox.width).toBeCloseTo(0.45, 6);
  expect(frame.height / originalBox.height).toBeCloseTo(0.4, 6);
  expect(await original.boundingBox()).toEqual(originalBox);
  expect({ project: await workspace.state(), history: await f.history(), bytes: await f.asset() }).toEqual(before);
  expect(commands).toEqual([]);
  const response = page.waitForResponse(response => response.url().endsWith('/api/mapping/execute') && response.request().postDataJSON()?.type === 'image.crop');
  await crop.getByRole('button', { name: '完成', exact: true }).click();
  expect((await response).status()).toBe(200); await expect(crop).toHaveCount(0);
  const saved = (await workspace.state()).images![0]!;
  expect(saved.content.crop.x).toBeCloseTo(0, 12); expect(saved.content.crop.y).toBeCloseTo(0.2, 12);
  expect(saved.content.crop.width).toBeCloseTo(0.45, 12); expect(saved.content.crop.height).toBeCloseTo(0.4, 12);
  expect(saved.item.pose.x).toBeCloseTo(500, 8); expect(saved.item.pose.y).toBeCloseTo(300, 8);
  expect(saved.item.pose.width).toBeCloseTo(216, 8); expect(saved.item.pose.height).toBeCloseTo(120, 8);
  expect(saved.item.pose.rotation).toBe(180);
  expect((await f.history()).undo.map((action: any) => action.label)).toEqual([...before.history.undo.map((action: any) => action.label), 'image.crop']);
  expect(commands.map(command => command.type)).toEqual(['image.crop']); expect(await f.asset()).toEqual(before.bytes);
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect.poll(async () => (await workspace.state()).images![0]!.content).toEqual(before.project.images![0]!.content);
  expect((await workspace.state()).images![0]!.item.pose).toEqual(before.project.images![0]!.item.pose);
  expect(await f.asset()).toEqual(before.bytes);
});
