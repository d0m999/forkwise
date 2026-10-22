import { test, expect } from './writing-board-fixture';

test('资源等待时可取消图片导入，晚ACK不建图，之后可正常添加另一张图片', async ({ page, workspace }) => {
  const source = '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="40"><rect width="80" height="40" fill="green"/></svg>';
  let reached = false, release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/mapping/execute', async route => {
    const command = route.request().postDataJSON();
    if (command.type !== 'asset.save' || command.payload.name !== '取消这张.svg') return route.continue();
    const response = await route.fetch(); reached = true; await gate; await route.fulfill({ response });
  });
  try {
    const chooser = page.waitForEvent('filechooser'); await page.getByRole('button', { name: '图片', exact: true }).click();
    await (await chooser).setFiles({ name: '取消这张.svg', mimeType: 'image/svg+xml', buffer: Buffer.from(source) });
    await expect.poll(() => reached).toBe(true);
    const cancel = page.getByRole('button', { name: '取消图片导入', exact: true });
    expect(await cancel.count(), '资源仍在等待确认时应允许取消本次图片导入').toBe(1);
    await cancel.click(); release();
    await expect(page.getByRole('status')).toHaveText('已保存到本机');
    await expect(page.getByRole('button', { name: '图片', exact: true })).toBeEnabled();
    const next = page.waitForEvent('filechooser'); await page.getByRole('button', { name: '图片', exact: true }).click();
    await (await next).setFiles({ name: '新图片.svg', mimeType: 'image/svg+xml', buffer: Buffer.from(source) });
    await expect(page.getByRole('img', { name: '新图片.svg', exact: true })).toBeVisible();
    await expect(page.getByRole('status')).toHaveText('已保存到本机');
    const saved = await workspace.state();
    expect(saved.images).toHaveLength(1);
    const asset = await (await page.request.get(workspace.origin + '/api/mapping/projects/' + saved.project.id + '/assets/' + saved.images![0]!.content.assetId)).json();
    expect(asset.name).toBe('新图片.svg');
    const history = await (await page.request.get(workspace.origin + '/api/mapping/projects/' + saved.project.id + '/history')).json();
    expect(history.undo.map((action: any) => action.label)).toEqual(['image.create']);
    await page.reload();
    await expect(page.getByRole('img', { name: '新图片.svg', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '恢复未确认图片', exact: true })).toHaveCount(0);
  } finally { release(); await page.unrouteAll({ behavior: 'wait' }); }
});

test('跨项目创建请求已发出后禁止取消，未知ACK在当前项目明确重试仍只确认原图', async ({ page, workspace }) => {
  const originalId = (await workspace.state()).project.id;
  let assetReached = false, imageReached = false, releaseAsset!: () => void, releaseImage!: () => void;
  const assetGate = new Promise<void>(resolve => { releaseAsset = resolve; }), imageGate = new Promise<void>(resolve => { releaseImage = resolve; });
  const images: any[] = [];
  await page.route('**/api/mapping/execute', async route => {
    const command = route.request().postDataJSON();
    if (command.type === 'asset.save' && command.payload.name === '跨项目未知.svg') {
      const response = await route.fetch(); assetReached = true; await assetGate; return route.fulfill({ response });
    }
    if (command.type === 'image.create') {
      images.push(command);
      if (images.length === 1) { const response = await route.fetch(); expect(response.status()).toBe(200); imageReached = true; await imageGate; return route.abort('failed'); }
    }
    await route.continue();
  });
  try {
    const chooser = page.waitForEvent('filechooser'); await page.getByRole('button', { name: '图片', exact: true }).click();
    await (await chooser).setFiles({ name: '跨项目未知.svg', mimeType: 'image/svg+xml', buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="80" height="40"><rect width="80" height="40" fill="green"/></svg>') });
    await expect.poll(() => assetReached).toBe(true);
    await page.getByRole('button', { name: '新建研究', exact: true }).click();
    await expect.poll(() => new URL(page.url()).searchParams.get('project')).not.toBe(originalId);
    const currentId = new URL(page.url()).searchParams.get('project')!;
    const current = await (await page.request.get(workspace.origin + '/api/mapping/projects/' + currentId)).json();
    releaseAsset(); await expect.poll(() => imageReached).toBe(true);
    await expect(page.getByRole('button', { name: '取消图片导入', exact: true }), '创建已发出且结果未确认时不能伪装可取消').toBeDisabled();
    releaseImage(); await expect(page.getByRole('alert').filter({ hasText: '跨项目未知.svg' })).toBeVisible();
    await page.getByRole('button', { name: '重试图片保存', exact: true }).click();
    await expect(page.getByRole('status')).toHaveText('已保存到本机');
    expect(images).toHaveLength(2); expect(images[1]).toEqual(images[0]);
    expect((await workspace.state()).images).toHaveLength(1);
    expect(await (await page.request.get(workspace.origin + '/api/mapping/projects/' + currentId)).json()).toEqual(current);
    expect(new URL(page.url()).searchParams.get('project')).toBe(currentId);
  } finally { releaseAsset(); releaseImage(); await page.unrouteAll({ behavior: 'wait' }); }
});

test('图片ACK晚到时在原项目完成，当前另一项目的内容历史与合成输入保持', async ({ page, workspace }) => {
  const original = await workspace.state();
  const placement = await page.locator('.react-flow').evaluate(element => {
    const rect = element.getBoundingClientRect();
    const matrix = new DOMMatrix(getComputedStyle(element.querySelector('.react-flow__viewport')!).transform);
    return { x: (rect.width / 2 - matrix.e) / matrix.a - 40, y: (rect.height / 2 - matrix.f) / matrix.a - 20 };
  });
  const source = '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="40"><rect width="80" height="40" fill="green"/></svg>';
  let reached = false, release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/mapping/execute', async route => {
    const command = route.request().postDataJSON();
    if (command.type !== 'asset.save' || command.payload.name !== '原项目.svg') return route.continue();
    const response = await route.fetch(); reached = true; await gate; await route.fulfill({ response });
  });
  try {
    const chooser = page.waitForEvent('filechooser'); await page.getByRole('button', { name: '图片', exact: true }).click();
    await (await chooser).setFiles({ name: '原项目.svg', mimeType: 'image/svg+xml', buffer: Buffer.from(source) });
    await expect.poll(() => reached).toBe(true);
    await page.getByRole('button', { name: '新建研究', exact: true }).click();
    await expect.poll(async () => new URL(page.url()).searchParams.get('project')).not.toBe(original.project.id);
    const nextId = new URL(page.url()).searchParams.get('project')!;
    const readNext = async () => (await page.request.get(workspace.origin + '/api/mapping/projects/' + nextId)).json();
    const readHistory = async () => (await page.request.get(workspace.origin + '/api/mapping/projects/' + nextId + '/history')).json();
    await page.locator('.react-flow__pane').evaluate(element => {
      const data = new DataTransfer(); data.setData('text/plain', '当前项目正文');
      element.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    });
    await expect.poll(async () => (await readNext()).cards.length).toBe(1);
    await page.getByRole('button', { name: '未命名卡片', exact: true }).dblclick();
    const editor = page.getByRole('textbox', { name: '卡片标题', exact: true });
    await editor.dispatchEvent('compositionstart'); await editor.fill('当前组合输入');
    const before = await readNext(), beforeHistory = await readHistory();
    release();
    await expect.poll(async () => (await workspace.state()).images?.length, { message: '晚ACK应在捕获的原项目完成图片创建' }).toBe(1);
    const saved = await workspace.state(), image = saved.images![0]!;
    expect(image.item.pose).toMatchObject({ ...placement, width: 80, height: 40, rotation: 0 });
    expect((await readNext()).cards).toEqual(before.cards);
    expect((await readNext()).images).toEqual([]);
    expect(await readHistory()).toEqual(beforeHistory);
    expect(new URL(page.url()).searchParams.get('project')).toBe(nextId);
    await expect(editor).toHaveValue('当前组合输入'); await expect(editor).toBeFocused();
    const history = await (await page.request.get(workspace.origin + '/api/mapping/projects/' + original.project.id + '/history')).json();
    expect(history.undo.map((action: any) => action.label)).toEqual(['image.create']);
    await editor.dispatchEvent('compositionend'); await editor.press('Enter');
    await expect.poll(async () => (await readNext()).cards[0].title).toBe('当前组合输入');
  } finally { release(); await page.unrouteAll({ behavior: 'wait' }); }
});

test('图片资源待确认只阻原项目历史，另一项目独立撤销且完成后按建图顺序撤销重做', async ({ page, workspace }) => {
  const projectId = (await workspace.state()).project.id;
  const read = async (id: string, suffix = '') => (await page.request.get(workspace.origin + '/api/mapping/projects/' + id + suffix)).json();
  await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'thought.create', expected: null,
    payload: { id: 'earlier-import-card', title: 'A先前卡', text: '', x: 100, y: 100 } });
  await page.getByRole('button', { name: '新建研究', exact: true }).click();
  await expect.poll(() => new URL(page.url()).searchParams.get('project')).not.toBe(projectId);
  const otherId = new URL(page.url()).searchParams.get('project')!;
  await workspace.execute(page, { commandId: crypto.randomUUID(), projectId: otherId, type: 'thought.create', expected: null,
    payload: { id: 'independent-import-card', title: 'B独立卡', text: '', x: 100, y: 100 } });
  await page.reload(); await expect(page.getByRole('button', { name: 'B独立卡', exact: true })).toBeVisible();
  await page.locator(`[role="tab"][title="${projectId}"]`).click();
  await expect(page.getByRole('button', { name: 'A先前卡', exact: true })).toBeVisible();
  const before = await read(projectId), beforeHistory = await read(projectId, '/history');
  const placement = await page.locator('.react-flow').evaluate(element => {
    const rect = element.getBoundingClientRect();
    const matrix = new DOMMatrix(getComputedStyle(element.querySelector('.react-flow__viewport')!).transform);
    return { x: (rect.width / 2 - matrix.e) / matrix.a - 40, y: (rect.height / 2 - matrix.f) / matrix.a - 20 };
  });
  let reached = false, release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/mapping/execute', async route => {
    const command = route.request().postDataJSON();
    if (command.type !== 'asset.save' || command.payload.name !== '历史等待.svg') return route.continue();
    const response = await route.fetch(); expect(response.status()).toBe(200);
    reached = true; await gate; await route.fulfill({ response });
  });
  const undo = page.getByRole('button', { name: '撤销', exact: true });
  const redo = page.getByRole('button', { name: '重做', exact: true });
  try {
    const chooser = page.waitForEvent('filechooser'); await page.getByRole('button', { name: '图片', exact: true }).click();
    await (await chooser).setFiles({ name: '历史等待.svg', mimeType: 'image/svg+xml', buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="80" height="40"><rect width="80" height="40" fill="green"/></svg>') });
    await expect.poll(() => reached).toBe(true);
    expect(await read(projectId)).toEqual(before); expect(await read(projectId, '/history')).toEqual(beforeHistory);
    await expect(undo, '图片资源已保存但创建仍在等待时，原项目撤销必须等待导入确认').toBeDisabled();
    await expect(redo).toBeDisabled(); await page.keyboard.press('ControlOrMeta+z');
    await page.locator(`[role="tab"][title="${otherId}"]`).click();
    await expect(undo, 'A的导入意图不能锁住B的独立历史').toBeEnabled(); await undo.click();
    await expect(page.getByRole('button', { name: 'B独立卡', exact: true })).toHaveCount(0);
    await expect.poll(async () => (await read(otherId)).cards.length).toBe(0);
    const otherState = await read(otherId), otherHistory = await read(otherId, '/history');
    expect(await read(projectId)).toEqual(before); expect(await read(projectId, '/history')).toEqual(beforeHistory);
    const navigation = page.getByRole('button', { name: '项目导航', exact: true }); await navigation.focus();
    const viewport = await page.locator('.react-flow__viewport').getAttribute('style');
    release(); await expect.poll(async () => (await read(projectId)).images.length).toBe(1);
    await expect(page.getByRole('status')).toHaveText('已保存到本机');
    await expect(page.locator(`[role="tab"][title="${otherId}"]`)).toHaveAttribute('aria-selected', 'true');
    await expect(navigation).toBeFocused(); expect(await page.locator('.react-flow__viewport').getAttribute('style')).toBe(viewport);
    expect(await read(otherId)).toEqual(otherState); expect(await read(otherId, '/history')).toEqual(otherHistory);
    const created = (await read(projectId)).images[0];
    expect(created.item.pose).toMatchObject({ ...placement, width: 80, height: 40, rotation: 0 });
    await page.locator(`[role="tab"][title="${projectId}"]`).click();
    await expect(page.getByRole('img', { name: '历史等待.svg', exact: true })).toBeVisible();
    await expect(undo).toBeEnabled(); await undo.click();
    await expect.poll(async () => (await read(projectId)).images).toEqual([]);
    expect((await read(projectId)).cards).toEqual(before.cards);
    expect((await read(projectId, '/history')).undo.map((item: any) => item.label)).toEqual(['thought.create']);
    expect((await read(projectId, '/history')).redo.map((item: any) => item.label)).toEqual(['image.create']);
    await redo.click(); await expect.poll(async () => (await read(projectId)).images[0]?.id).toBe(created.id);
    const restored = (await read(projectId)).images[0]; expect(restored.content).toEqual(created.content); expect(restored.item.pose).toEqual(created.item.pose);
    expect((await read(projectId, '/history')).undo.map((item: any) => item.label)).toEqual(['thought.create', 'image.create']);
  } finally { release(); await page.unrouteAll({ behavior: 'wait' }); }
});
