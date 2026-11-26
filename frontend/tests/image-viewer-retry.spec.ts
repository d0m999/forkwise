import { createCanvas } from '../../backend/node_modules/@napi-rs/canvas/index.js';
import { test, expect, place } from './writing-board-fixture';

for (const context of ['画布', '正文']) {
  test(`${context}静态大图在窄窗同源重试，回到原焦点且不写入`, async ({ page, workspace }) => {
    await page.setViewportSize({ width: context === '画布' ? 760 : 380, height: 900 });
    if (context === '正文') await place(page, '正文静态大图');
    const state = await workspace.state();
    const projectId = state.project.id;
    const execute = (type: string, payload: unknown, expected: unknown = null) => workspace.execute(page, {
      commandId: crypto.randomUUID(), projectId, type, expected, payload,
    });
    const photo = createCanvas(200, 120);
    const drawing = photo.getContext('2d');
    drawing.fillStyle = '#e86140'; drawing.fillRect(0, 0, 120, 120);
    drawing.fillStyle = '#17685a'; drawing.fillRect(120, 0, 80, 120);
    const original = photo.toBuffer('image/png');
    await execute('asset.save', { id: 'static', name: '阅读重试.png', mime: 'image/png', base64: original.toString('base64') });
    if (context === '画布') {
      await execute('image.create', { id: 'picture', content: { assetId: 'static', crop: { x: 0.25, y: 0, width: 0.75, height: 1 } },
        pose: { x: 170, y: 155, width: 150, height: 120, rotation: 0 } });
    } else {
      const card = state.cards[0]!;
      await execute('body.edit', { id: card.id, blocks: [{ id: 'picture', type: 'image', assetId: 'static', name: '阅读重试.png',
        mime: 'image/png', naturalWidth: 200, naturalHeight: 120 }] }, card.body.versionId);
      await page.getByRole('button', { name: '编辑正文', exact: true }).click();
    }
    const anchor = context === '画布' ? page.getByRole('img', { name: '阅读重试.png' }) : page.locator('[data-block-id="picture"]');
    const inline = anchor.locator('img');
    await expect(inline).toHaveJSProperty('naturalWidth', 200);
    const endpoint = `/api/mapping/projects/${projectId}/assets/static/content`;
    const reads: string[] = [];
    let failFirstRead!: () => void;
    const firstRead = new Promise<void>(resolve => { failFirstRead = resolve; });
    await page.route('**/assets/static/content', async route => {
      if (route.request().method() !== 'GET') return route.continue();
      reads.push(new URL(route.request().url()).pathname);
      if (reads.length !== 1) return route.continue();
      await firstRead;
      await route.fulfill({ status: 503, body: 'temporary read failure' });
    });
    const history = async () => (await page.request.get(`${workspace.origin}/api/mapping/projects/${projectId}/history`)).json();
    const before = await workspace.state(), beforeHistory = await history();
    const viewer = page.getByRole('dialog', { name: context === '画布' ? '图片大图' : '正文大图' });
    const close = viewer.getByRole('button', { name: '关闭大图' });
    const stage = viewer.locator('.body-image-stage');
    const stageBounds = await (async () => {
      try {
        await inline.dblclick();
        await expect(close).toBeFocused();
        return await stage.boundingBox();
      } finally {
        failFirstRead();
      }
    })();
    await expect(viewer.getByRole('alert')).toContainText('大图加载失败');
    expect(await stage.boundingBox()).toEqual(stageBounds);
    const retry = viewer.getByRole('button', { name: '重新加载图片', exact: true });
    await expect(retry).toBeVisible({ timeout: 3000 });
    await viewer.getByRole('button', { name: '放大图片' }).click();
    if (context === '画布') {
      await viewer.getByRole('button', { name: '查看原图' }).click();
      await expect(viewer.getByRole('button', { name: '查看画布效果' })).toBeVisible();
      await viewer.getByRole('button', { name: '放大图片' }).click();
    }
    const zoom = viewer.getByLabel('图片缩放比例');
    await expect(zoom).toHaveText('125%');
    const area = stageBounds!;
    await page.mouse.move(area.x + area.width / 2, area.y + area.height / 2);
    await page.mouse.down();
    await page.mouse.move(area.x + area.width / 2 + 20, area.y + area.height / 2 + 25);
    await page.mouse.up();
    const image = viewer.locator('img');
    const beforeRetry = await image.boundingBox();
    if (context === '画布') await retry.click();
    else {
      await close.focus();
      await page.keyboard.press('Shift+Tab');
      await expect(retry).toBeFocused();
      await page.keyboard.press('Tab');
      await expect(close).toBeFocused();
      await page.keyboard.press('Shift+Tab');
      await page.keyboard.press('Enter');
    }
    await expect(image).toHaveJSProperty('naturalWidth', 200);
    expect(await image.boundingBox()).toEqual(beforeRetry);
    await expect(viewer.getByRole('alert')).toHaveCount(0);
    expect(await stage.boundingBox()).toEqual(stageBounds);
    await expect(close).toBeFocused();
    await expect(zoom).toHaveText('125%');
    if (context === '画布') await expect(viewer.getByRole('button', { name: '查看画布效果' })).toBeVisible();
    expect(reads).toEqual([endpoint, endpoint]);
    await page.keyboard.press('Escape');
    await expect(viewer).toHaveCount(0);
    await expect(anchor).toBeFocused();
    expect(await workspace.state()).toEqual(before);
    expect(await history()).toEqual(beforeHistory);
    expect(await (await page.request.get(workspace.origin + endpoint)).body()).toEqual(original);
  });
}
