import { test, expect } from './writing-board-fixture';
import { twoFrameGif } from './image-reading-fixtures';
import { createCanvas, loadImage } from '../../backend/node_modules/@napi-rs/canvas/index.js';
import type { Locator } from '@playwright/test';

async function frameColors(frame: Locator) {
  const colors: string[] = [];
  for (let at = 0; at < 8; at++) {
    const image = await loadImage(await frame.screenshot()), canvas = createCanvas(image.width, image.height);
    canvas.getContext('2d').drawImage(image, 0, 0); colors.push(String(Array.from(canvas.getContext('2d').getImageData(40, 30, 1, 1).data)));
    await frame.page().waitForTimeout(80);
  }
  return colors;
}

test('未成组GIF保存拖动后内联播放控件仍响应下一次真实点击', async ({ page, workspace }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const projectId = (await workspace.state()).project.id, bytes = twoFrameGif();
  await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'asset.save', expected: null,
    payload: { id: 'gif-drag-asset', name: '拖后动图.gif', mime: 'image/gif', base64: bytes.toString('base64') } });
  await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'image.create', expected: null,
    payload: { id: 'gif-drag-image', content: { assetId: 'gif-drag-asset', crop: { x: 0, y: 0, width: 1, height: 1 } },
      pose: { x: 300, y: 180, width: 160, height: 120, rotation: 0 } } });
  await page.reload(); await expect(page.getByRole('status')).toHaveText('已保存到本机');
  const visual = page.getByRole('img', { name: '拖后动图.gif', exact: true }); await visual.click();
  const before = await workspace.state();
  expect(before.images).toHaveLength(1); expect(before.groups).toEqual([]); expect(before.containment).toEqual([]);
  expect(before.images![0]).toMatchObject({ id: 'gif-drag-image', content: { assetId: 'gif-drag-asset', crop: { x: 0, y: 0, width: 1, height: 1 } },
    item: { pose: { x: 300, y: 180, width: 160, height: 120, rotation: 0 } } });
  const asset = await (await page.request.get(workspace.origin + '/api/mapping/projects/' + projectId + '/assets/gif-drag-asset')).json();
  expect(asset).toMatchObject({ name: '拖后动图.gif', mime: 'image/gif' }); expect(Buffer.from(asset.base64, 'base64')).toEqual(bytes);
  const node = page.locator('.react-flow__node[data-id="' + before.images![0]!.item.id + '"]');
  await expect(node).toHaveClass(/selected/);
  const play = node.getByRole('button', { name: '播放动图', exact: true }), pause = node.getByRole('button', { name: '暂停动图', exact: true });
  await play.click(); await expect(pause).toBeVisible();
  expect(new Set(await frameColors(visual))).toEqual(new Set(['255,0,0,255', '0,255,0,255']));
  await pause.click(); await expect(play).toBeVisible(); expect(new Set(await frameColors(visual)).size).toBe(1);
  const writes: any[] = [];
  page.on('request', request => { if (request.url().endsWith('/api/mapping/execute') && request.method() === 'POST') writes.push(request.postDataJSON()); });
  const box = (await visual.boundingBox())!, x = box.x + box.width / 2, y = box.y + box.height / 2;
  await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.move(x + 80, y + 50, { steps: 5 }); await page.mouse.up();
  await expect.poll(async () => (await workspace.state()).images![0]!.item.pose).toEqual({ x: 380, y: 230, width: 160, height: 120, rotation: 0 });
  await expect(page.getByRole('status')).toHaveText('已保存到本机'); await expect(node).toHaveClass(/selected/);
  expect(writes).toHaveLength(1); expect(writes[0]).toMatchObject({ type: 'canvas.move', payload: { targets: [{ kind: 'image', id: 'gif-drag-image', x: 380, y: 230 }] } });
  const saved = await workspace.state();
  // No ordinary node pointerdown intervenes between the completed drag and this control click.
  await play.click(); await expect(pause).toBeVisible();
  expect(new Set(await frameColors(visual))).toEqual(new Set(['255,0,0,255', '0,255,0,255']));
  expect(await workspace.state()).toEqual(saved); expect(writes).toHaveLength(1);
});

test('独立GIF与大图复用播放暂停和减少动态，真实帧变化且原件保持', async ({ page, workspace }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const bytes = twoFrameGif(), chooser = page.waitForEvent('filechooser'); await page.getByRole('button', { name: '图片', exact: true }).click();
  await (await chooser).setFiles({ name: '独立动图.gif', mimeType: 'image/gif', buffer: bytes });
  const visual = page.getByRole('img', { name: '独立动图.gif', exact: true }); await expect(visual).toBeVisible();
  const play = page.getByRole('button', { name: '播放动图', exact: true });
  await expect(play, '减少动态偏好下独立GIF应暂停并提供明确播放入口').toHaveCount(1);
  await expect(play).toBeEnabled();
  const samples = async (frame: typeof visual, count: number) => {
    const result: string[] = [];
    for (let index = 0; index < count; index++) {
      const image = await loadImage(await frame.screenshot()), canvas = createCanvas(image.width, image.height);
      canvas.getContext('2d').drawImage(image, 0, 0);
      result.push(String(Array.from(canvas.getContext('2d').getImageData(40, 30, 1, 1).data)));
      await page.waitForTimeout(80);
    }
    return result;
  };
  expect(await samples(visual, 3)).toEqual(['255,0,0,255', '255,0,0,255', '255,0,0,255']);
  await play.click(); const playing = await samples(visual, 8);
  expect(playing).toContain('255,0,0,255'); expect(playing).toContain('0,255,0,255');
  await page.getByRole('button', { name: '暂停动图', exact: true }).click();
  expect(new Set(await samples(visual, 3)).size).toBe(1);
  await visual.dblclick(); const viewer = page.getByRole('dialog', { name: '图片大图', exact: true });
  const frame = viewer.getByRole('img'); await expect(viewer.getByRole('button', { name: '播放动图', exact: true })).toBeEnabled();
  expect(new Set(await samples(frame, 3)).size).toBe(1);
  await viewer.getByRole('button', { name: '播放动图', exact: true }).click();
  expect(new Set(await samples(frame, 8)).size).toBe(2);
  await viewer.getByRole('button', { name: '暂停动图', exact: true }).click();
  await viewer.getByRole('button', { name: '关闭大图', exact: true }).click();
  await expect(visual).toBeFocused(); await expect(play).toBeVisible();
  expect(new Set(await samples(visual, 3)).size).toBe(1);
  const saved = await workspace.state(), asset = await (await page.request.get(workspace.origin + '/api/mapping/projects/' + saved.project.id + '/assets/' + saved.images![0]!.content.assetId)).json();
  expect(Buffer.from(asset.base64, 'base64')).toEqual(bytes);
});

test('普通动态偏好下可见独立GIF自动播放，真实帧包含两种颜色', async ({ page, workspace }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  const chooser = page.waitForEvent('filechooser'); await page.getByRole('button', { name: '图片', exact: true }).click();
  await (await chooser).setFiles({ name: '自动动图.gif', mimeType: 'image/gif', buffer: twoFrameGif() });
  await expect(page.getByRole('button', { name: '暂停动图', exact: true })).toBeEnabled();
  const colors = await frameColors(page.getByRole('img', { name: '自动动图.gif', exact: true }));
  expect(colors).toContain('255,0,0,255'); expect(colors).toContain('0,255,0,255');
});

test('独立GIF首帧降级保持原图可读，大图Tab跳过禁用播放控件', async ({ page, workspace }) => {
  await page.evaluate(() => Object.defineProperty(window, 'ImageDecoder', { value: undefined, configurable: true }));
  const chooser = page.waitForEvent('filechooser'); await page.getByRole('button', { name: '图片', exact: true }).click();
  await (await chooser).setFiles({ name: '降级动图.gif', mimeType: 'image/gif', buffer: twoFrameGif() });
  const visual = page.getByRole('img', { name: '降级动图.gif', exact: true });
  await expect(page.getByRole('button', { name: '当前浏览器仅显示动图首帧', exact: true })).toBeDisabled();
  expect(new Set(await frameColors(visual))).toEqual(new Set(['255,0,0,255']));
  await visual.dblclick(); const viewer = page.getByRole('dialog', { name: '图片大图', exact: true });
  await expect(viewer.getByRole('button', { name: '当前浏览器仅显示动图首帧', exact: true })).toBeDisabled();
  await viewer.getByRole('button', { name: '关闭大图', exact: true }).focus(); await page.keyboard.press('Shift+Tab');
  await expect(viewer.getByRole('button', { name: '查看原图', exact: true })).toBeFocused();
  await page.keyboard.press('Escape'); await expect(visual).toBeFocused();
});
