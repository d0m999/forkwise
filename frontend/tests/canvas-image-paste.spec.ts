import { test, expect } from './writing-board-fixture';

test('外部纯文字粘贴画布生成空标题正文卡，换行保留并一次撤销，重开仍可读', async ({ page, workspace }) => {
  const text = '外部研究文字\n\n保留原文与换行 INTC';
  await page.locator('.react-flow__pane').click({ position: { x: 320, y: 200 } });
  await page.locator('.react-flow__pane').evaluate((element, text) => {
    const data = new DataTransfer(); data.setData('text/plain', text);
    element.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  }, text);
  await expect.poll(async () => (await workspace.state()).cards.length).toBe(1);
  await expect(page.getByRole('status')).toHaveText('已保存到本机');
  const created = (await workspace.state()).cards[0]!;
  expect(created.title).toBe('');
  expect(created.body.blocks.map(block => block.text ?? '').join('')).toBe(text);
  await expect(page.getByRole('button', { name: '未命名卡片', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect.poll(async () => (await workspace.state()).cards).toEqual([]);
  await page.getByRole('button', { name: '重做', exact: true }).click();
  await expect.poll(async () => (await workspace.state()).cards[0]?.id).toBe(created.id);
  await workspace.restart(); await page.reload();
  await expect(page.getByRole('button', { name: '未命名卡片', exact: true })).toBeVisible();
  expect((await workspace.state()).cards[0]!.body.blocks).toEqual(created.body.blocks);
});

test('底部图片入口添加小图保持自然大小，创建和资源历史分开且可撤销重做', async ({ page, workspace }) => {
  const source = '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><rect width="40" height="20" fill="green"/></svg>';
  const trigger = page.getByRole('button', { name: '图片', exact: true });
  expect(await trigger.count(), '底部创作栏应提供添加独立图片的入口').toBe(1);
  const chooser = page.waitForEvent('filechooser'); await trigger.click();
  await (await chooser).setFiles({ name: '小图.svg', mimeType: 'image/svg+xml', buffer: Buffer.from(source) });
  await expect.poll(async () => (await workspace.state()).images?.length).toBe(1);
  await expect(page.getByRole('status')).toHaveText('已保存到本机');
  const saved = await workspace.state(), image = saved.images![0]!;
  expect(image.item.pose.width).toBe(40); expect(image.item.pose.height).toBe(20);
  const history = await (await page.request.get(workspace.origin + '/api/mapping/projects/' + saved.project.id + '/history')).json();
  expect(history.undo.map((a: any) => a.label)).toEqual(['image.create']);
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect.poll(async () => (await workspace.state()).images).toEqual([]);
  await page.getByRole('button', { name: '重做', exact: true }).click();
  await expect(page.getByRole('img', { name: '小图.svg', exact: true })).toBeVisible();
  expect((await workspace.state()).images![0]).toMatchObject({ id: image.id, content: image.content, item: { id: image.item.id, pose: image.item.pose } });
});

test('单张外部图片等待资源确认才保存为独立图，60%初始等比且原件与重开布局保持', async ({ page, workspace }) => {
  const source = '<svg xmlns="http://www.w3.org/2000/svg" width="1800" height="1200"><rect width="900" height="1200" fill="green"/><rect x="900" width="900" height="1200" fill="red"/></svg>';
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let reached = false;
  await page.route('**/api/mapping/execute', async route => {
    if (route.request().postDataJSON()?.type !== 'asset.save') return route.continue();
    const response = await route.fetch(); reached = true; await gate;
    await route.fulfill({ response });
  });
  try {
    await page.locator('.react-flow__pane').click({ position: { x: 300, y: 220 } });
    const visible = await page.locator('.react-flow').evaluate(element => ({ width: element.clientWidth, height: element.clientHeight }));
    await page.locator('.react-flow__pane').evaluate((element, source) => {
      const data = new DataTransfer(); data.items.add(new File([source], '研究原图.svg', { type: 'image/svg+xml' }));
      element.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    }, source);
    await expect.poll(() => reached).toBe(true);
    expect((await workspace.state()).images).toEqual([]);
    await expect(page.getByRole('status')).not.toHaveText('已保存到本机');
    release();
    await expect.poll(async () => (await workspace.state()).images?.length).toBe(1);
    await expect(page.getByRole('status')).toHaveText('已保存到本机');
    const saved = await workspace.state(), image = saved.images![0]!, p = image.item.pose;
    expect(saved.cards).toEqual([]);
    expect(p.width / p.height).toBeCloseTo(1.5, 6);
    expect(p.width).toBeLessThanOrEqual(visible.width * 0.6 + 0.001);
    expect(p.height).toBeLessThanOrEqual(visible.height * 0.6 + 0.001);
    expect(Math.max(p.width / visible.width, p.height / visible.height)).toBeCloseTo(0.6, 6);
    await expect(page.getByRole('img', { name: '研究原图.svg', exact: true })).toBeVisible();
    await expect(page.locator('.react-flow__node-thought')).toHaveCount(0);
    const asset = await (await page.request.get(workspace.origin + '/api/mapping/projects/' + saved.project.id + '/assets/' + image.content.assetId)).json();
    expect(Buffer.from(asset.base64, 'base64').toString()).toBe(source);
    await workspace.restart(); await page.reload();
    await expect(page.getByRole('img', { name: '研究原图.svg', exact: true })).toBeVisible();
    expect((await workspace.state()).images).toEqual(saved.images);
  } finally { release(); await page.unrouteAll({ behavior: 'wait' }); }
});
