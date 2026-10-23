import { test, expect } from './writing-board-fixture';
import { seedCrop } from './canvas-image-crop-fixture';

test('已应用裁剪的预览用取消按钮Enter放弃draft并回到原图焦点', async ({ page, workspace }) => {
  const projectId = (await workspace.state()).project.id;
  const source = '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300"><rect width="400" height="300" fill="blue"/><rect x="100" y="75" width="200" height="150" fill="green"/></svg>';
  await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'asset.save', expected: null,
    payload: { id: 'cancel-original', name: '取消裁剪.svg', mime: 'image/svg+xml', base64: Buffer.from(source).toString('base64') } });
  await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'image.create', expected: null,
    payload: { id: 'cancel-image', content: { assetId: 'cancel-original', crop: { x: 0.25, y: 0.25, width: 0.5, height: 0.5 } },
      pose: { x: 200, y: 155, width: 200, height: 150, rotation: 0 } } });
  await page.reload();
  const history = async () => (await page.request.get(`${workspace.origin}/api/mapping/projects/${projectId}/history`)).json();
  const asset = async () => (await page.request.get(`${workspace.origin}/api/mapping/projects/${projectId}/assets/cancel-original/content`)).body();
  const before = { project: await workspace.state(), history: await history(), bytes: await asset() };
  expect(before.bytes.toString()).toBe(source);
  const visual = page.getByRole('img', { name: '取消裁剪.svg', exact: true });
  await visual.click();
  await page.getByRole('toolbar', { name: '图片操作', exact: true }).getByRole('button', { name: '裁剪', exact: true }).click();
  const crop = page.getByRole('region', { name: '图片裁剪', exact: true });
  const frame = crop.getByRole('group', { name: '裁剪范围', exact: true });
  const originalBox = (await frame.boundingBox())!;
  await crop.getByRole('button', { name: '调整裁剪范围：右下', exact: true }).press('Shift+ArrowLeft');
  expect((await frame.boundingBox())!.width / originalBox.width).toBeCloseTo(0.95, 6);
  expect(await workspace.state()).toEqual(before.project);
  const cancel = crop.getByRole('button', { name: '取消', exact: true });
  await cancel.focus(); await expect(cancel).toBeFocused();
  await cancel.press('Enter');
  await expect(crop).toHaveCount(0);
  expect({ project: await workspace.state(), history: await history(), bytes: await asset() }).toEqual(before);
  await expect(visual).toBeFocused();
});

test('当前移动拉伸右转后菜单直接恢复完整图片按当前比例展开且可撤销', async ({ page, workspace }) => {
  const f = await seedCrop(page, workspace, { crop: { x: 0.25, y: 0, width: 0.75, height: 1 },
    pose: { x: 680, y: 430, width: 280, height: 120, rotation: 0 } });
  await f.visual.click();
  for (const x of [690, 700]) {
    await f.visual.press('ArrowRight');
    await expect.poll(async () => (await workspace.state()).images![0]!.item.pose.x).toBe(x);
    await expect(f.visual).toHaveAttribute('aria-disabled', 'false');
  }
  const east = page.getByRole('button', { name: '调整图片尺寸：右', exact: true });
  for (const width of [290, 300]) {
    await east.press('Shift+ArrowRight');
    await expect.poll(async () => (await workspace.state()).images![0]!.item.pose.width).toBe(width);
    await expect(east).toHaveAttribute('aria-disabled', 'false');
  }
  await page.getByRole('button', { name: '向右旋转90°', exact: true }).click();
  await expect.poll(async () => (await workspace.state()).images![0]!.item.pose).toEqual({ x: 790, y: 340, width: 120, height: 300, rotation: 90 });
  const before = (await workspace.state()).images![0]!, beforeHistory = await f.history();
  const restore = page.getByRole('toolbar', { name: '图片操作', exact: true }).getByRole('button', { name: '恢复完整图片', exact: true });
  await expect(restore).toBeVisible(); await restore.click();
  await expect.poll(async () => (await workspace.state()).images![0]!.item.pose).toEqual({ x: 790, y: 240, width: 120, height: 400, rotation: 90 });
  const saved = (await workspace.state()).images![0]!;
  expect(saved.content).toEqual({ assetId: 'crop-original', crop: { x: 0, y: 0, width: 1, height: 1 } });
  await expect(page.getByRole('region', { name: '图片裁剪', exact: true })).toHaveCount(0);
  expect((await f.history()).undo).toHaveLength(beforeHistory.undo.length + 1);
  expect((await f.asset()).toString()).toBe(f.source);
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect.poll(async () => (await workspace.state()).images![0]!.item.pose).toEqual(before.item.pose);
  expect((await workspace.state()).images![0]!.content).toEqual(before.content);
});

test('裁剪移动拉伸旋转恢复的连续撤销重做经reload和同SQLite重开几何原件不漂移', async ({ page, workspace }) => {
  const crop = { x: 0.25, y: 0, width: 0.75, height: 1 };
  const poses = [
    { x: 680, y: 430, width: 280, height: 120, rotation: 0 },
    { x: 700, y: 430, width: 280, height: 120, rotation: 0 },
    { x: 700, y: 430, width: 300, height: 120, rotation: 0 },
    { x: 790, y: 340, width: 120, height: 300, rotation: 90 },
    { x: 790, y: 240, width: 120, height: 400, rotation: 90 },
  ] as const;
  const f = await seedCrop(page, workspace, { crop, pose: poses[0] });
  const identity = (await workspace.state()).images![0]!;
  for (const pose of poses.slice(1, 3)) {
    const image = (await workspace.state()).images![0]!;
    const { rotation: _rotation, ...layout } = pose;
    await workspace.execute(page, { commandId: crypto.randomUUID(), projectId: f.projectId, type: 'image.transform',
      expected: { image: image.versionId, pose: image.item.versionId }, payload: { id: image.id, pose: layout } });
  }
  let image = (await workspace.state()).images![0]!;
  await workspace.execute(page, { commandId: crypto.randomUUID(), projectId: f.projectId, type: 'image.rotate',
    expected: { image: image.versionId, pose: image.item.versionId }, payload: { id: image.id, direction: 'right' } });
  image = (await workspace.state()).images![0]!;
  await workspace.execute(page, { commandId: crypto.randomUUID(), projectId: f.projectId, type: 'image.crop',
    expected: { image: image.versionId, pose: image.item.versionId }, payload: { id: image.id, crop: { x: 0, y: 0, width: 1, height: 1 } } });
  await page.reload();
  const check = async (index: number) => {
    await expect.poll(async () => (await workspace.state()).images![0]!.item.pose).toEqual(poses[index]);
    const saved = (await workspace.state()).images![0]!;
    expect({ id: saved.id, itemId: saved.item.id, content: saved.content }).toEqual({ id: identity.id, itemId: identity.item.id,
      content: { assetId: 'crop-original', crop: index === 4 ? { x: 0, y: 0, width: 1, height: 1 } : crop } });
    expect((await f.asset()).toString()).toBe(f.source);
  };
  await check(4);
  for (const index of [3, 2, 1, 0]) {
    await page.getByRole('button', { name: '撤销', exact: true }).click(); await check(index);
    if (index === 2) { await page.reload(); await check(index); }
  }
  await workspace.restart(); await page.reload(); await check(0);
  for (const index of [1, 2, 3, 4]) {
    await page.getByRole('button', { name: '重做', exact: true }).click(); await check(index);
  }
  await workspace.restart(); await page.reload(); await check(4);
});

test('裁剪未知ACK经同步仍保draft，重试完全原请求且只一次历史', async ({ page, workspace }) => {
  const f = await seedCrop(page, workspace), initial = await workspace.state();
  const beforeHistory = await f.history(), crop = await f.enter();
  await crop.getByRole('button', { name: '调整裁剪范围：左上', exact: true }).press('Shift+ArrowRight');
  const frame = crop.getByRole('group', { name: '裁剪范围', exact: true });
  const draft = (await frame.boundingBox())!, attempts: any[] = [];
  await page.route('**/api/mapping/execute', async route => {
    const command = route.request().postDataJSON();
    if (command.type !== 'image.crop') return route.continue();
    attempts.push(command); const response = await route.fetch();
    if (attempts.length === 1) await route.abort('failed');
    else await route.fulfill({ response });
  });
  try {
    const synced = page.waitForResponse(async response => response.url().endsWith(`/projects/${f.projectId}/history`)
      && (await response.json()).revision === initial.project.revision + 1);
    await crop.getByRole('button', { name: '完成', exact: true }).click();
    await expect(page.getByRole('button', { name: '重试图片调整', exact: true })).toBeVisible();
    await synced; await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await expect(crop).toBeVisible(); expect(await frame.boundingBox()).toEqual(draft);
    await expect(crop.getByRole('button', { name: '取消', exact: true })).toBeDisabled();
    expect((await f.history()).undo).toHaveLength(beforeHistory.undo.length + 1);
    await page.getByRole('button', { name: '重试图片调整', exact: true }).click();
    await expect(crop).toHaveCount(0);
    expect(attempts).toHaveLength(2); expect(attempts[1]).toEqual(attempts[0]);
    expect(attempts[0].expected).toEqual({ image: initial.images![0]!.versionId, pose: initial.images![0]!.item.versionId });
    expect((await workspace.state()).images![0]!.item.pose).toEqual({ x: 210, y: 155, width: 190, height: 150, rotation: 0 });
    expect((await f.history()).undo).toHaveLength(beforeHistory.undo.length + 1);
    expect((await f.asset()).toString()).toBe(f.source);
  } finally { await page.unrouteAll({ behavior: 'wait' }); }
});

test('A裁剪在途切B仍可画布输入和独立历史，晚ACK只A且不抢B焦点', async ({ page, workspace }) => {
  const f = await seedCrop(page, workspace);
  const read = async (id: string, suffix = '') => (await page.request.get(`${workspace.origin}/api/mapping/projects/${id}${suffix}`)).json();
  const aHistory = await f.history();
  await page.getByRole('button', { name: '新建研究', exact: true }).click();
  await expect.poll(() => new URL(page.url()).searchParams.get('project')).not.toBe(f.projectId);
  const bId = new URL(page.url()).searchParams.get('project')!;
  await page.locator(`[role="tab"][title="${f.projectId}"]`).click();
  let reached = false, release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/mapping/execute', async route => {
    const command = route.request().postDataJSON();
    if (command.type !== 'image.crop' || command.projectId !== f.projectId) return route.continue();
    const response = await route.fetch(); reached = true; await gate; await route.fulfill({ response });
  });
  try {
    const crop = await f.enter();
    await crop.getByRole('button', { name: '调整裁剪范围：右', exact: true }).press('Shift+ArrowLeft');
    await crop.getByRole('button', { name: '完成', exact: true }).click();
    await expect.poll(() => reached).toBe(true);
    await page.locator(`[role="tab"][title="${bId}"]`).click();
    await page.getByRole('button', { name: '卡片', exact: true }).click();
    await page.locator('.react-flow__pane').click({ position: { x: 350, y: 250 } });
    const title = page.getByLabel('卡片标题', { exact: true });
    await expect(title).toBeVisible(); await title.fill('B独立卡片'); await title.press('Enter');
    await expect.poll(async () => (await read(bId)).cards[0]?.title).toBe('B独立卡片');
    expect((await read(bId, '/history')).undo.map((action: any) => action.label)).toEqual(['thought.create']);
    await page.getByRole('button', { name: '撤销', exact: true }).click();
    await expect.poll(async () => (await read(bId)).cards.length).toBe(0);
    await page.getByRole('button', { name: '重做', exact: true }).click();
    await expect.poll(async () => (await read(bId)).cards.length).toBe(1);
    await page.getByRole('button', { name: '重命名当前项目', exact: true }).click();
    const input = page.getByRole('textbox', { name: '项目名称', exact: true });
    await input.fill('B输入保持'); const beforeACK = { state: await read(bId), history: await read(bId, '/history') };
    release(); await expect(page.getByRole('status')).toHaveText('已保存到本机');
    expect(new URL(page.url()).searchParams.get('project')).toBe(bId);
    await expect(input).toBeFocused(); await expect(input).toHaveValue('B输入保持');
    expect({ state: await read(bId), history: await read(bId, '/history') }).toEqual(beforeACK);
    expect((await read(f.projectId)).images[0].content.crop).toEqual({ x: 0.25, y: 0.25, width: 0.475, height: 0.5 });
    expect((await f.history()).undo).toHaveLength(aHistory.undo.length + 1);
    expect((await f.asset()).toString()).toBe(f.source);
  } finally { release(); await page.unrouteAll({ behavior: 'wait' }); }
});

test('真实peer更新使crop确定409，明确放弃只保peer状态且不当未知ACK重试', async ({ page, workspace }) => {
  const f = await seedCrop(page, workspace), initial = (await workspace.state()).images![0]!;
  let reached = false, release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), replies: { status: number; code: string }[] = [];
  await page.route('**/api/mapping/execute', async route => {
    if (route.request().postDataJSON().type !== 'image.crop') return route.continue();
    reached = true; await gate; const response = await route.fetch();
    replies.push({ status: response.status(), code: (await response.json()).code }); await route.fulfill({ response });
  });
  try {
    const crop = await f.enter();
    await crop.getByRole('button', { name: '调整裁剪范围：右', exact: true }).press('Shift+ArrowLeft');
    await crop.getByRole('button', { name: '完成', exact: true }).click();
    await expect.poll(() => reached).toBe(true);
    await workspace.execute(page, { commandId: crypto.randomUUID(), projectId: f.projectId, type: 'image.transform',
      expected: { image: initial.versionId, pose: initial.item.versionId }, payload: { id: initial.id, pose: { x: 700, y: 300, width: 240, height: 180 } } });
    const peer = { project: await workspace.state(), history: await f.history(), bytes: await f.asset() };
    release();
    const abandon = page.getByRole('button', { name: '放弃本次图片调整，保留已保存状态', exact: true });
    await expect(abandon).toBeVisible(); expect(replies).toEqual([{ status: 409, code: 'VERSION_CONFLICT' }]);
    await expect(page.getByRole('button', { name: '重试图片调整', exact: true })).toHaveCount(0);
    expect({ project: await workspace.state(), history: await f.history(), bytes: await f.asset() }).toEqual(peer);
    await abandon.click(); await expect(crop).toHaveCount(0); await expect(abandon).toHaveCount(0);
    expect({ project: await workspace.state(), history: await f.history(), bytes: await f.asset() }).toEqual(peer);
    expect(replies).toHaveLength(1); await expect(f.visual).toBeFocused();
  } finally { release(); await page.unrouteAll({ behavior: 'wait' }); }
});
