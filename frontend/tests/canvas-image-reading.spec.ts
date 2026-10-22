import { test, expect } from './writing-board-fixture';
import { croppedCanvasImage } from './canvas-image-reading-fixture';
import { createCanvas, loadImage } from '../../backend/node_modules/@napi-rs/canvas/index.js';

test('图片明确409拒绝后可放弃本次调整，保留已保存状态并继续阅读及新调整', async ({ page, workspace }) => {
  const fixture = await croppedCanvasImage(page, workspace), projectId = fixture.projectId;
  const execute = (type: string, payload: unknown, expected: unknown = null) => workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type, expected, payload });
  await execute('asset.save', { id: 'readable-other', name: '继续阅读.svg', mime: 'image/svg+xml', base64: Buffer.from(fixture.source).toString('base64') });
  await execute('image.create', { id: 'other-image', content: { assetId: 'readable-other', crop: { x: 0, y: 0, width: 1, height: 1 } }, pose: { x: 140, y: 80, width: 120, height: 80, rotation: 0 } });
  await page.reload();
  let reached = false, release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), attempts: any[] = [];
  await page.route('**/api/mapping/execute', async route => {
    const command = route.request().postDataJSON();
    if (command.type !== 'image.rotate' || command.payload.id !== fixture.image.id) return route.continue();
    if (!attempts.length) { reached = true; await gate; }
    const response = await route.fetch(), body = await response.json();
    attempts.push({ command, status: response.status(), body }); await route.fulfill({ response });
  });
  const read = async (suffix = '') => (await page.request.get(workspace.origin + '/api/mapping/projects/' + projectId + suffix)).json();
  try {
    await page.getByRole('img', { name: '已裁剪拉伸.svg', exact: true }).click();
    await page.getByRole('button', { name: '向右旋转90°', exact: true }).click();
    await expect.poll(() => reached).toBe(true);
    await execute('image.rotate', { id: fixture.image.id, direction: 'left' }, { image: fixture.image.versionId, pose: fixture.image.item.versionId });
    const peer = await read(), peerHistory = await read('/history'); release();
    await expect.poll(() => attempts.length).toBe(1);
    expect(attempts[0]).toMatchObject({ status: 409, body: { code: 'VERSION_CONFLICT' }, command: { expected: { image: fixture.image.versionId, pose: fixture.image.item.versionId } } });
    const abandon = page.getByRole('button', { name: '放弃本次图片调整，保留已保存状态', exact: true });
    await expect(abandon, '明确拒绝后必须有保留已保存图片、解除待确认的出口').toBeVisible();
    await expect(page.getByRole('button', { name: '重试图片调整', exact: true })).toHaveCount(0);
    await abandon.click(); await expect(abandon).toHaveCount(0);
    await expect(page.getByRole('status')).toHaveText('已保存到本机');
    expect(await read()).toEqual(peer); expect(await read('/history')).toEqual(peerHistory);
    const other = page.getByRole('img', { name: '继续阅读.svg', exact: true }); await other.dblclick();
    await expect(page.getByRole('dialog', { name: '图片大图', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '关闭大图', exact: true }).click();
    await page.getByRole('img', { name: '已裁剪拉伸.svg', exact: true }).click();
    await page.getByRole('button', { name: '向右旋转90°', exact: true }).click();
    await expect(page.getByRole('status')).toHaveText('已保存到本机');
    await expect.poll(() => attempts.length).toBe(2);
    expect(attempts[1].status).toBe(200); expect(attempts[1].command.commandId).not.toBe(attempts[0].command.commandId);
    expect(attempts[1].command.expected).toEqual({ image: peer.images[0].versionId, pose: peer.images[0].item.versionId });
    const saved = await read(); expect(saved.images[0].item.pose.rotation).toBe(0); expect(saved.images[0].content).toEqual(fixture.image.content);
    expect(saved.images[1]).toEqual(peer.images[1]);
    expect((await read('/history')).undo).toHaveLength(peerHistory.undo.length + 1);
  } finally { release(); await page.unrouteAll({ behavior: 'wait' }); }
});

test('已裁剪非同比拉伸图左右旋转保中心，真实像素随crop旋转且删除撤销保非零方向', async ({ page, workspace }) => {
  const original = await croppedCanvasImage(page, workspace);
  const visual = page.getByRole('img', { name: '已裁剪拉伸.svg', exact: true }); await visual.click();
  const right = page.getByRole('button', { name: '向右旋转90°', exact: true });
  expect(await right.count(), '选中图片应提供右转90度操作').toBe(1);
  await right.click();
  await expect.poll(async () => (await workspace.state()).images![0]!.item.pose.rotation).toBe(90);
  await expect(page.getByRole('status')).toHaveText('已保存到本机');
  const rotated = (await workspace.state()).images![0]!;
  expect(rotated.item.pose).toEqual({ x: 450, y: 180, width: 120, height: 320, rotation: 90 });
  expect(rotated.content).toEqual(original.image.content);
  const decoded = await loadImage(await visual.screenshot()), canvas = createCanvas(decoded.width, decoded.height);
  canvas.getContext('2d').drawImage(decoded, 0, 0);
  const pixel = (x: number, y: number) => Array.from(canvas.getContext('2d').getImageData(x, y, 1, 1).data);
  expect(pixel(60, 80)).toEqual([0, 255, 0, 255]); expect(pixel(60, 240)).toEqual([255, 0, 0, 255]);
  await page.getByRole('button', { name: '向左旋转90°', exact: true }).click();
  await expect.poll(async () => (await workspace.state()).images![0]!.item.pose).toEqual(original.image.item.pose);
  await expect(page.getByRole('status')).toHaveText('已保存到本机');
  await right.click(); await expect.poll(async () => (await workspace.state()).images![0]!.item.pose.rotation).toBe(90);
  await expect(page.getByRole('status')).toHaveText('已保存到本机');
  await page.getByRole('button', { name: '删除图片', exact: true }).click();
  await expect.poll(async () => (await workspace.state()).images).toEqual([]);
  await expect(page.getByRole('status')).toHaveText('已保存到本机');
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect(visual).toBeVisible();
  expect((await workspace.state()).images![0]).toMatchObject({ id: original.image.id, content: original.image.content, item: { pose: rotated.item.pose } });
  expect(await page.getByRole('button', { name: /替换图片/ }).count()).toBe(0);
});

test('图片几何丢ACK明确重放原请求，只保留一次旋转和原裁剪', async ({ page, workspace }) => {
  const fixture = await croppedCanvasImage(page, workspace), commands: any[] = [];
  await page.route('**/api/mapping/execute', async route => {
    const command = route.request().postDataJSON(); if (command.type !== 'image.rotate') return route.continue();
    commands.push(command);
    if (commands.length === 1) { const response = await route.fetch(); expect(response.status()).toBe(200); return route.abort('failed'); }
    await route.continue();
  });
  await page.getByRole('img', { name: '已裁剪拉伸.svg', exact: true }).click();
  await page.getByRole('button', { name: '向右旋转90°', exact: true }).click();
  await expect(page.getByRole('button', { name: '重试图片调整', exact: true })).toBeVisible();
  await expect(page.getByRole('status')).not.toHaveText('已保存到本机');
  await page.getByRole('button', { name: '重试图片调整', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('已保存到本机');
  expect(commands).toHaveLength(2); expect(commands[1]).toEqual(commands[0]);
  const saved = await workspace.state(); expect(saved.images![0]!.item.pose.rotation).toBe(90);
  expect(saved.images![0]!.content).toEqual(fixture.image.content);
  const history = await (await page.request.get(workspace.origin + '/api/mapping/projects/' + fixture.projectId + '/history')).json();
  expect(history.undo.map((action: any) => action.label)).toEqual(['image.create', 'image.rotate']);
});

test('图片旋转与切项目同时开始，晚ACK只确认原图且不抢回当前视图', async ({ page, workspace }) => {
  const original = await croppedCanvasImage(page, workspace);
  await page.getByRole('button', { name: '新建研究', exact: true }).click();
  await expect.poll(() => new URL(page.url()).searchParams.get('project')).not.toBe(original.projectId);
  const currentId = new URL(page.url()).searchParams.get('project')!;
  const before = await (await page.request.get(workspace.origin + '/api/mapping/projects/' + currentId)).json();
  await page.locator(`[role="tab"][title="${original.projectId}"]`).click();
  const visual = page.getByRole('img', { name: '已裁剪拉伸.svg', exact: true }); await visual.click();
  await expect(page.getByRole('button', { name: '向右旋转90°', exact: true })).toBeEnabled();
  let reached = false, release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/mapping/execute', async route => {
    if (route.request().postDataJSON().type !== 'image.rotate') return route.continue();
    const response = await route.fetch(); reached = true; await gate; await route.fulfill({ response });
  });
  try {
    // Two public controls start before their asynchronous save boundaries settle.
    await page.evaluate(currentId => {
      Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find(button => button.textContent === '向右旋转90°')!.click();
      document.querySelector<HTMLButtonElement>(`[role="tab"][title="${currentId}"]`)!.click();
    }, currentId);
    await expect.poll(() => reached).toBe(true);
    const selected = page.locator(`[role="tab"][title="${currentId}"]`);
    await expect(selected).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('status'), '原图布局尚未确认时不能声称所有保存已完成').not.toHaveText('已保存到本机');
    release(); await expect(page.getByRole('status')).toHaveText('已保存到本机');
    await expect(selected).toHaveAttribute('aria-selected', 'true');
    expect(new URL(page.url()).searchParams.get('project')).toBe(currentId);
    expect(await (await page.request.get(workspace.origin + '/api/mapping/projects/' + currentId)).json()).toEqual(before);
    expect((await workspace.state()).images![0]!.item.pose.rotation).toBe(90);
  } finally { release(); await page.unrouteAll({ behavior: 'wait' }); }
});

test('小图每次打开或切换保持自然像素且重置平移缩放，键盘焦点留在阅读器', async ({ page, workspace }) => {
  const chooser = page.waitForEvent('filechooser'); await page.getByRole('button', { name: '图片', exact: true }).click();
  await (await chooser).setFiles({ name: '阅读小图.svg', mimeType: 'image/svg+xml', buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><rect width="40" height="20" fill="green"/></svg>') });
  const visual = page.getByRole('img', { name: '阅读小图.svg', exact: true }); await visual.dblclick();
  const viewer = page.getByRole('dialog', { name: '图片大图', exact: true }), plane = viewer.getByRole('img');
  const size = async () => { const box = (await plane.boundingBox())!; expect(box.width).toBe(40); expect(box.height).toBe(20); };
  await size(); await viewer.getByRole('button', { name: '放大图片', exact: true }).click();
  await viewer.getByRole('button', { name: '查看原图', exact: true }).click(); await size();
  await page.getByRole('button', { name: '关闭大图', exact: true }).focus(); await page.keyboard.press('Tab');
  await expect(viewer.getByRole('button', { name: '适应窗口', exact: true })).toBeFocused();
  await page.keyboard.press('Shift+Tab'); await expect(viewer.getByRole('button', { name: '关闭大图', exact: true })).toBeFocused();
  await viewer.press('Escape'); await visual.dblclick(); await size();
  await expect(viewer.getByRole('button', { name: '查看原图', exact: true })).toBeVisible();
  expect((await workspace.state()).images![0]!.item.pose.width).toBe(40);
});

test('大图按原件像素保裁剪拉伸方向，每次打开或切换都fit居中，关闭保原画布视角', async ({ page, workspace }) => {
  const original = await croppedCanvasImage(page, workspace), image = original.image;
  await workspace.execute(page, { commandId: crypto.randomUUID(), projectId: original.projectId, type: 'image.rotate',
    expected: { image: image.versionId, pose: image.item.versionId }, payload: { id: image.id, direction: 'right' } });
  await page.reload();
  const visual = page.getByRole('img', { name: '已裁剪拉伸.svg', exact: true }); await expect(visual).toBeVisible();
  const viewport = await page.locator('.react-flow__viewport').getAttribute('style'), before = await workspace.state();
  await visual.dblclick();
  const viewer = page.getByRole('dialog', { name: '图片大图', exact: true });
  expect(await viewer.count(), '双击独立图片应打开大图阅读器').toBe(1);
  const plane = viewer.getByRole('img'), stage = viewer.locator('.body-image-stage');
  const fit = async (width: number, height: number) => {
    const area = (await stage.boundingBox())!, factor = Math.min(1, area.width / width, area.height / height);
    await expect.poll(async () => (await plane.boundingBox())!.width).toBeCloseTo(width * factor, 2);
    const box = (await plane.boundingBox())!;
    expect(box.height).toBeCloseTo(height * factor, 2);
    expect(box.x + box.width / 2).toBeCloseTo(area.x + area.width / 2, 2);
    expect(box.y + box.height / 2).toBeCloseTo(area.y + area.height / 2, 2);
  };
  // Cropped original pixels are 600×400. The visible unrotated Pose ratio
  // is 320/120, so the effect plane is 600×225, then turned to 225×600.
  await fit(225, 600);
  await viewer.getByRole('button', { name: '放大图片', exact: true }).click();
  const area = (await stage.boundingBox())!;
  await page.mouse.move(area.x + area.width / 2, area.y + area.height / 2); await page.mouse.down();
  await page.mouse.move(area.x + area.width / 2 + 80, area.y + area.height / 2 + 60); await page.mouse.up();
  await viewer.getByRole('button', { name: '查看原图', exact: true }).click();
  await fit(800, 1200);
  await viewer.getByRole('button', { name: '100%', exact: true }).click();
  await expect.poll(async () => (await plane.boundingBox())!.height).toBeCloseTo(1200, 2);
  await viewer.getByRole('button', { name: '查看画布效果', exact: true }).click(); await fit(225, 600);
  await viewer.getByRole('button', { name: '放大图片', exact: true }).click();
  await viewer.press('Escape'); await expect(viewer).toHaveCount(0);
  await expect(visual).toBeFocused();
  expect(await page.locator('.react-flow__viewport').getAttribute('style')).toBe(viewport);
  await page.getByRole('button', { name: '查看大图', exact: true }).click();
  await expect(viewer.getByRole('button', { name: '查看原图', exact: true })).toBeVisible(); await fit(225, 600);
  await viewer.getByRole('button', { name: '关闭大图', exact: true }).click();
  expect(await workspace.state()).toEqual(before);
});
