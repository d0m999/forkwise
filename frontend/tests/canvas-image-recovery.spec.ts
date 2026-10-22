import { test, expect } from './writing-board-fixture';

test('原件保存失败显示文件名与原因，明确重试同一资源请求后只创建一次独立图片', async ({ page, workspace }) => {
  const source = '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="40"><rect width="80" height="40" fill="green"/></svg>';
  let refused = false;
  const requests: any[] = [];
  await page.route('**/api/mapping/execute', async route => {
    const command = route.request().postDataJSON();
    if (command.type !== 'asset.save') return route.continue();
    requests.push(command);
    if (!refused) { refused = true; return route.fulfill({ status: 503, json: { code: 'SAVE_FAILED', message: '原件存储暂时失败' } }); }
    await route.continue();
  });
  const chooser = page.waitForEvent('filechooser'); await page.getByRole('button', { name: '图片', exact: true }).click();
  await (await chooser).setFiles({ name: '需重试.svg', mimeType: 'image/svg+xml', buffer: Buffer.from(source) });
  await expect.poll(() => refused).toBe(true);
  expect((await workspace.state()).images).toEqual([]);
  await expect(page.getByRole('alert').filter({ hasText: '需重试.svg' })).toContainText('原件存储暂时失败');
  expect(await page.getByRole('button', { name: '重试图片保存', exact: true }).count()).toBe(1);
  await page.getByRole('button', { name: '重试图片保存', exact: true }).click();
  await expect.poll(async () => (await workspace.state()).images?.length).toBe(1);
  await expect(page.getByRole('status')).toHaveText('已保存到本机');
  expect(requests[1]).toEqual(requests[0]);
  const saved = await workspace.state();
  expect(saved.images![0]!.content.assetId).toBe(requests[0].payload.id);
  const history = await (await page.request.get(workspace.origin + '/api/mapping/projects/' + saved.project.id + '/history')).json();
  expect(history.undo.map((action: any) => action.label)).toEqual(['image.create']);
});

test('未知附加字段的图片恢复记录原字节保留，不猜测恢复且不阻塞新的合法图片', async ({ page, workspace }) => {
  const projectId = (await workspace.state()).project.id, key = 'forkwise:canvas-image-input:v1:future-input';
  const raw = JSON.stringify({ schema: 1, input: { name: '未知.svg', placement: { projectId, x: 10, y: 20, maxWidth: 500, maxHeight: 400 },
    asset: { commandId: 'future-asset', projectId, type: 'asset.save', expected: null,
      payload: { id: 'future-original', name: '未知.svg', mime: 'image/svg+xml', base64: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"/>').toString('base64') } },
    futureTransform: { preserve: '未识别输入不能规范化丢弃' } } });
  await page.evaluate(({ key, raw }) => localStorage.setItem(key, raw), { key, raw }); await page.reload();
  await expect(page.getByRole('tab', { selected: true })).toBeVisible();
  expect(await page.getByRole('button', { name: '恢复未确认图片', exact: true }).count(), '未知字段不应被当成已知请求供猜测恢复').toBe(0);
  await expect(page.getByRole('alert').filter({ hasText: '部分未确认图片记录无法识别' })).toBeVisible();
  const trigger = page.getByRole('button', { name: '图片', exact: true }); await expect(trigger).toBeEnabled();
  const chooser = page.waitForEvent('filechooser'); await trigger.click();
  await (await chooser).setFiles({ name: '合法新图.svg', mimeType: 'image/svg+xml', buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><rect width="40" height="20" fill="green"/></svg>') });
  await expect(page.getByRole('img', { name: '合法新图.svg', exact: true })).toBeVisible();
  expect((await workspace.state()).images).toHaveLength(1);
  expect(await page.evaluate(key => localStorage.getItem(key), key)).toBe(raw);
});

test('已落盘图片丢创建ACK后跨服务重启和刷新，明确恢复重放原请求且不重复创建', async ({ page, workspace }) => {
  const source = '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="40"><rect width="80" height="40" fill="green"/></svg>';
  let lost = false;
  const requests: any[] = [];
  await page.route('**/api/mapping/execute', async route => {
    const command = route.request().postDataJSON();
    if (command.type !== 'image.create') return route.continue();
    requests.push(command);
    if (!lost) { const response = await route.fetch(); expect(response.status()).toBe(200); lost = true; return route.abort('failed'); }
    await route.continue();
  });
  const chooser = page.waitForEvent('filechooser'); await page.getByRole('button', { name: '图片', exact: true }).click();
  await (await chooser).setFiles({ name: '确认丢失.svg', mimeType: 'image/svg+xml', buffer: Buffer.from(source) });
  await expect.poll(() => lost).toBe(true);
  await expect(page.getByRole('alert').filter({ hasText: '确认丢失.svg' })).toBeVisible();
  const committed = await workspace.state();
  expect(committed.images).toHaveLength(1);
  page.on('dialog', dialog => dialog.accept());
  await workspace.restart(); await page.reload();
  await expect(page.getByRole('img', { name: '确认丢失.svg', exact: true })).toBeVisible();
  expect(await page.getByRole('button', { name: '恢复未确认图片', exact: true }).count(), '刷新后仍应保留原图片任务的恢复入口').toBe(1);
  await expect(page.getByRole('status')).not.toHaveText('已保存到本机');
  await page.getByRole('button', { name: '恢复未确认图片', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('已保存到本机');
  expect(requests.at(-1)).toEqual(requests[0]);
  expect((await workspace.state()).images).toEqual(committed.images);
  const history = await (await page.request.get(workspace.origin + '/api/mapping/projects/' + committed.project.id + '/history')).json();
  expect(history.undo.map((action: any) => action.label)).toEqual(['image.create']);
});
