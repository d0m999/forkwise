import { test, expect } from './writing-board-fixture';
import { croppedCanvasImage } from './canvas-image-reading-fixture';

test('图片真实404后放弃只读取原项目，读取失败保留意图且晚读不抢当前项目输入', async ({ page, workspace }) => {
  const fixture = await croppedCanvasImage(page, workspace), projectId = fixture.projectId;
  const execute = (target: string, type: string, payload: unknown, expected: unknown = null) => workspace.execute(page, { commandId: crypto.randomUUID(), projectId: target, type, expected, payload });
  const read = async (target: string, suffix = '') => (await page.request.get(workspace.origin + '/api/mapping/projects/' + target + suffix)).json();
  await page.getByRole('button', { name: '新建研究', exact: true }).click();
  await expect.poll(() => new URL(page.url()).searchParams.get('project')).not.toBe(projectId);
  const currentId = new URL(page.url()).searchParams.get('project')!;
  await execute(currentId, 'asset.save', { id: 'current-asset', name: '当前项目.svg', mime: 'image/svg+xml', base64: Buffer.from(fixture.source).toString('base64') });
  await execute(currentId, 'image.create', { id: 'current-image', content: { assetId: 'current-asset', crop: { x: 0, y: 0, width: 1, height: 1 } }, pose: { x: 140, y: 80, width: 120, height: 80, rotation: 0 } });
  await page.locator(`[role="tab"][title="${projectId}"]`).click();
  let reached = false, release!: () => void, failRead = false, failedReads = 0;
  const gate = new Promise<void>(resolve => { release = resolve; }), attempts: any[] = [];
  await page.route('**/api/mapping/execute', async route => {
    const command = route.request().postDataJSON();
    if (command.type !== 'image.transform' || command.projectId !== projectId) return route.continue();
    reached = true; await gate;
    const response = await route.fetch(), body = await response.json(); attempts.push({ command, status: response.status(), body });
    await route.fulfill({ response });
  });
  await page.route('**/api/mapping/projects/' + projectId + '/map?**', async route => {
    if (!failRead || new URL(route.request().url()).searchParams.get('view') !== 'index') return route.continue();
    failRead = false; const response = await route.fetch(); expect(response.status()).toBe(200); failedReads++;
    await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ code: 'UNAVAILABLE', message: '原项目读取暂不可用' }) });
  });
  const abandon = page.getByRole('button', { name: '放弃本次图片调整，保留已保存状态', exact: true });
  const activateWithoutMovingFocus = () => abandon.evaluate(button => (button as HTMLButtonElement).click());
  try {
    await page.getByRole('img', { name: '已裁剪拉伸.svg', exact: true }).click();
    await page.getByRole('button', { name: '调整图片尺寸：右下', exact: true }).press('ArrowRight');
    await expect.poll(() => reached).toBe(true);
    await execute(projectId, 'image.delete', { id: fixture.image.id }, { image: fixture.image.versionId, pose: fixture.image.item.versionId });
    const deleted = await read(projectId), deletedHistory = await read(projectId, '/history'); release();
    await expect.poll(() => attempts.length).toBe(1);
    expect(attempts[0]).toMatchObject({ status: 404, body: { code: 'NOT_FOUND' } }); await expect(abandon).toBeVisible();
    await page.locator(`[role="tab"][title="${currentId}"]`).click();
    await page.getByRole('button', { name: '重命名当前项目', exact: true }).click();
    const input = page.getByRole('textbox', { name: '项目名称', exact: true }); await input.fill('当前组合输入'); await input.dispatchEvent('compositionstart');
    const before = await read(currentId), beforeHistory = await read(currentId, '/history');
    failRead = true; await activateWithoutMovingFocus();
    await expect(page.getByRole('alert')).toContainText('无法读取图片已保存状态');
    await expect(abandon).toBeVisible(); expect(failedReads).toBe(1);
    await expect(page.getByRole('status')).toHaveText('图片调整未保存');
    await expect(input).toBeFocused(); await expect(input).toHaveValue('当前组合输入');
    await activateWithoutMovingFocus(); await expect(abandon).toHaveCount(0);
    await expect(input).toBeFocused(); await expect(input).toHaveValue('当前组合输入');
    expect(new URL(page.url()).searchParams.get('project')).toBe(currentId);
    expect(await read(currentId)).toEqual(before); expect(await read(currentId, '/history')).toEqual(beforeHistory);
    expect(await read(projectId)).toEqual(deleted); expect(await read(projectId, '/history')).toEqual(deletedHistory);
    expect(attempts).toHaveLength(1);
    await input.dispatchEvent('compositionend'); await input.press('Escape');
    await page.getByRole('img', { name: '当前项目.svg', exact: true }).dblclick();
    await expect(page.getByRole('dialog', { name: '图片大图', exact: true })).toBeVisible();
  } finally { release(); await page.unrouteAll({ behavior: 'wait' }); }
});

test('图片写入200后读取404仍未确认，必须原请求重试且不显示放弃拒绝出口', async ({ page, workspace }) => {
  const fixture = await croppedCanvasImage(page, workspace), projectId = fixture.projectId;
  let applied = false, failRead = true, failedReads = 0;
  const attempts: any[] = [];
  await page.route('**/api/mapping/execute', async route => {
    const command = route.request().postDataJSON(); if (command.type !== 'image.rotate') return route.continue();
    const response = await route.fetch(); expect(response.status()).toBe(200); applied = true; attempts.push(command);
    await route.fulfill({ response });
  });
  await page.route('**/api/mapping/projects/' + projectId + '/map?**', async route => {
    if (!applied || !failRead || new URL(route.request().url()).searchParams.get('view') !== 'index') return route.continue();
    failRead = false; const response = await route.fetch(); expect(response.status()).toBe(200); failedReads++;
    await route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ code: 'NOT_FOUND', message: '读取阶段404，不能推断写入被拒绝' }) });
  });
  await page.getByRole('img', { name: '已裁剪拉伸.svg', exact: true }).click(); await page.getByRole('button', { name: '向右旋转90°', exact: true }).click();
  const retry = page.getByRole('button', { name: '重试图片调整', exact: true }); await expect(retry).toBeVisible();
  expect(failedReads).toBe(1); await expect(page.getByRole('button', { name: '放弃本次图片调整，保留已保存状态', exact: true })).toHaveCount(0);
  await expect(page.getByRole('status')).toHaveText('图片布局尚未确认');
  const committed = await workspace.state(), history = await (await page.request.get(workspace.origin + '/api/mapping/projects/' + projectId + '/history')).json();
  await retry.click(); await expect(page.getByRole('status')).toHaveText('已保存到本机');
  expect(attempts).toHaveLength(2); expect(attempts[1]).toEqual(attempts[0]);
  expect(await workspace.state()).toEqual(committed);
  expect(await (await page.request.get(workspace.origin + '/api/mapping/projects/' + projectId + '/history')).json()).toEqual(history);
});
