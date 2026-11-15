import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { loadImage, createCanvas } from '../../backend/node_modules/@napi-rs/canvas/index.js';
import type { Page } from '@playwright/test';
import { test, expect, place, type Workspace } from './writing-board-fixture';
import { seedCanvasExportSample } from './canvas-export-fixture';
import { EXPORT_CAPTURE_EVENT, EXPORT_CONTENT_SELECTOR, EXPORT_IGNORE_SELECTOR, EXPORT_PADDING } from '../src/canvas-export-markers';

// 内容范围用 querySelectorAll 命中后代，这里用 matches 命中按钮自身。连线文字因此两边都有。
const exportContentButtons = [
  '.title-button',
  '.canvas-frame-name',
  '.connector-label',
  '.card-attachments button[aria-label^="打开 "]',
].join(',');

test('同一导出入口在摘要生成失败时不显示下载成功，重试后真实下载且项目未改', async ({ page, workspace }) => {
  await place(page, '导出卡');
  const before = await workspace.state();
  const card = before.cards[0]!;
  await workspace.execute(page, {
    commandId: crypto.randomUUID(), projectId: before.project.id, type: 'body.edit', expected: card.body.versionId,
    payload: { id: card.id, text: '这是已保存的长正文第一段。\n这是第二段，用于真实 Markdown 下载。' },
  });
  await page.reload();
  await expect(page.getByRole('status')).toHaveText('已保存到本机');
  const saved = await workspace.state();
  let fail = true;
  const downloads: string[] = [];
  page.on('download', download => downloads.push(download.suggestedFilename()));
  await page.route('**/api/mapping/projects/*/export.md?*', async route => {
    if (fail) {
      fail = false;
      await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ code: 'EXPORT_FAILED', message: '摘要生成失败，请重试；项目未修改' }) });
    } else await route.continue();
  });

  const trigger = page.getByRole('button', { name: '导出', exact: true });
  await trigger.focus();
  await page.keyboard.press('Enter');
  const action = page.getByRole('menuitem', { name: '下载可读摘要（Markdown）', exact: true });
  const imageAction = page.getByRole('menuitem', { name: '下载画布图像（PNG）', exact: true });
  await expect(action).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(imageAction).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(action).toBeFocused();
  await expect(page.getByText('只导出当前已保存状态；未保存草稿不包含在内。')).toBeVisible();
  await action.click();
  await expect(page.getByRole('status')).toHaveText('摘要生成失败，请重试；项目未修改');
  expect(downloads).toEqual([]);

  await expect(action).toBeFocused();
  const downloadPromise = page.waitForEvent('download');
  await page.keyboard.press('Enter');
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe(`${saved.project.name}-r${saved.project.revision}.md`);
  const path = await download.path();
  expect(path).not.toBeNull();
  const markdown = await readFile(path!, 'utf8');
  expect(markdown).toContain('导出卡');
  expect(markdown).toContain('这是已保存的长正文第一段。\n这是第二段，用于真实 Markdown 下载。');
  expect(markdown).toContain('这是可读摘要，不是完整恢复，也不是备份');
  await expect(page.getByRole('status')).toHaveText('可读摘要下载已开始');
  expect((await workspace.state()).project.revision).toBe(saved.project.revision);

  await page.keyboard.press('Escape');
  await expect(trigger).toBeFocused();
  await expect(action).toHaveCount(0);
  await page.getByRole('button', { name: '编辑正文', exact: true }).click();
  await page.getByRole('textbox', { name: '卡片正文', exact: true }).fill('导出后的新正文');
  await expect(page.getByRole('status')).toHaveText('已保存到本机');
  expect((await workspace.state()).project.revision).toBe(saved.project.revision + 1);
});

async function decodedPng(path: string) {
  const image = await loadImage(path);
  const canvas = createCanvas(image.width, image.height);
  const context = canvas.getContext('2d');
  context.drawImage(image, 0, 0);
  const data = context.getImageData(0, 0, image.width, image.height).data;
  let greenPixels = 0;
  for (let index = 0; index < data.length; index += 4)
    if (data[index]! < 100 && data[index + 1]! > 150 && data[index + 2]! < 150) greenPixels++;
  return { width: image.width, height: image.height, data: Buffer.from(data), greenPixels };
}

type Box = { x: number; y: number; width: number; height: number };
type Rgb = { r: number; g: number; b: number };

function toExportBox(origin: { left: number; top: number }, box: Box): Box {
  return { x: box.x - origin.left + EXPORT_PADDING, y: box.y - origin.top + EXPORT_PADDING, width: box.width, height: box.height };
}

function intersection(a: Box, b: Box): Box | null {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  if (right - x < 4 || bottom - y < 4) return null;
  return { x, y, width: right - x, height: bottom - y };
}

function containsBox(outer: Box, inner: Box) {
  return inner.x >= outer.x - 2 && inner.y >= outer.y - 2
    && inner.x + inner.width <= outer.x + outer.width + 2
    && inner.y + inner.height <= outer.y + outer.height + 2;
}

function rgbAt(png: { data: Buffer; width: number; height: number }, x: number, y: number): Rgb | null {
  const px = Math.round(x);
  const py = Math.round(y);
  if (px < 0 || py < 0 || px >= png.width || py >= png.height) return null;
  const index = (py * png.width + px) * 4;
  return { r: png.data[index]!, g: png.data[index + 1]!, b: png.data[index + 2]! };
}

function nearColor(color: Rgb, hex: string, tolerance: number) {
  const r = Number.parseInt(hex.slice(1, 3), 16);
  const g = Number.parseInt(hex.slice(3, 5), 16);
  const b = Number.parseInt(hex.slice(5, 7), 16);
  return Math.abs(color.r - r) <= tolerance && Math.abs(color.g - g) <= tolerance && Math.abs(color.b - b) <= tolerance;
}

function colorShare(png: { data: Buffer; width: number; height: number }, box: Box, hex: string, tolerance = 28) {
  let total = 0;
  let hits = 0;
  for (let y = box.y; y < box.y + box.height; y += 2)
    for (let x = box.x; x < box.x + box.width; x += 2) {
      const color = rgbAt(png, x, y);
      if (!color) continue;
      total += 1;
      if (nearColor(color, hex, tolerance)) hits += 1;
    }
  return total === 0 ? 0 : hits / total;
}

function borderHits(png: { data: Buffer; width: number; height: number }, box: Box) {
  let hits = 0;
  const x0 = Math.round(box.x);
  const y0 = Math.round(box.y);
  const x1 = Math.round(box.x + box.width);
  const y1 = Math.round(box.y + box.height);
  for (let x = x0; x <= x1; x += 1)
    for (const y of [y0 - 1, y0, y0 + 1, y1 - 1, y1, y1 + 1]) {
      const color = rgbAt(png, x, y);
      if (color && nearColor(color, '#94a3b8', 36)) hits += 1;
    }
  for (let y = y0; y <= y1; y += 1)
    for (const x of [x0 - 1, x0, x0 + 1, x1 - 1, x1, x1 + 1]) {
      const color = rgbAt(png, x, y);
      if (color && nearColor(color, '#94a3b8', 36)) hits += 1;
    }
  return hits;
}

function inkPixels(png: { data: Buffer; width: number; height: number }, box: Box) {
  let ink = 0;
  for (let y = box.y; y < box.y + box.height; y += 1)
    for (let x = box.x; x < box.x + box.width; x += 1) {
      const color = rgbAt(png, x, y);
      if (color && color.r + color.g + color.b < 280) ink += 1;
    }
  return ink;
}

async function readExportLayout(page: Page) {
  return page.evaluate(({ contentSelector, ignoreSelector }) => {
    const root = document.querySelector<HTMLElement>('.canvas .react-flow');
    const viewport = root?.querySelector<HTMLElement>('.react-flow__viewport');
    if (!root || !viewport) throw new Error('画布尚未完成绘制');
    const raw = getComputedStyle(viewport).transform;
    const transform = new DOMMatrixReadOnly(raw === 'none' ? undefined : raw);
    const rootRect = root.getBoundingClientRect();
    const boxOf = (element: Element) => {
      const rect = element.getBoundingClientRect();
      return {
        x: (rect.left - rootRect.left - transform.e) / transform.a,
        y: (rect.top - rootRect.top - transform.f) / transform.d,
        width: rect.width / transform.a,
        height: rect.height / transform.d,
      };
    };
    const boxes = [...root.querySelectorAll<HTMLElement>(contentSelector)]
      .filter(element => !element.closest(ignoreSelector) && getComputedStyle(element).display !== 'none')
      .map(boxOf)
      .filter(rect => Number.isFinite(rect.x + rect.y + rect.width + rect.height) && rect.width > 0 && rect.height > 0);
    if (!boxes.length) throw new Error('画布没有可导出内容');
    const cardBox = (title: string) => {
      const node = [...root.querySelectorAll<HTMLElement>('.react-flow__node')].find(element => element.querySelector('.title-button')?.textContent === title);
      const titleButton = node?.querySelector('.title-button');
      if (!node || !titleButton) throw new Error(`缺少卡片 ${title}`);
      return { card: boxOf(node), title: boxOf(titleButton) };
    };
    const annotation = [...root.querySelectorAll<HTMLElement>('.react-flow__node')].find(element => element.textContent?.includes('附着批注'));
    const button = (label: string) => [...root.querySelectorAll('button')].find(element => element.getAttribute('aria-label') === label);
    const detach = button('解除 财报原件.pdf');
    const add = button('添加附件');
    const filename = button('打开 财报原件.pdf');
    if (!annotation || !detach || !add || !filename) throw new Error('缺少批注或附件按钮');
    if (!detach.closest(ignoreSelector) || !add.closest(ignoreSelector)) throw new Error('附件操作按钮未被导出忽略');
    if (filename.closest(ignoreSelector)) throw new Error('附件文件名被导出忽略');
    return {
      left: Math.min(...boxes.map(rect => rect.x)),
      top: Math.min(...boxes.map(rect => rect.y)),
      frames: [...root.querySelectorAll('.canvas-frame')].map(boxOf),
      bottom: cardBox('底层研究卡'),
      topCard: cardBox('上层研究卡'),
      annotation: boxOf(annotation),
      detach: boxOf(detach),
      add: boxOf(add),
      filename: boxOf(filename),
    };
  }, { contentSelector: EXPORT_CONTENT_SELECTOR, ignoreSelector: EXPORT_IGNORE_SELECTOR });
}

test('混合样本分别下载摘要与真实画布 PNG，遮挡和重启后的像素一致', async ({ page, workspace }, info) => {
  const sample = await seedCanvasExportSample(page, workspace);
  const revision = sample.state.project.revision;
  const bottomNode = page.locator(`.react-flow__node[data-id="${sample.bottom.item.id}"]`);
  const topNode = page.locator(`.react-flow__node[data-id="${sample.top.item.id}"]`);
  await bottomNode.click({ position: { x: 18, y: 18 } });
  const selectedBottomZ = Number(await bottomNode.evaluate(element => getComputedStyle(element).zIndex));
  const selectedTopZ = Number(await topNode.evaluate(element => getComputedStyle(element).zIndex));
  expect(selectedBottomZ).toBeGreaterThan(selectedTopZ);
  await page.screenshot({ path: resolve('../backend/artifacts/issue37-20261115/downloads/selected-overlap.png') });
  const layout = await readExportLayout(page);
  const overflow = bottomNode.locator('.tag-overflow');
  await expect(overflow).toBeVisible();
  const missedChrome = await page.evaluate(({ ignoreSelector, contentButtonSelector }) => {
    const root = document.querySelector('.canvas .react-flow');
    if (!root) throw new Error('画布尚未完成绘制');
    const overflowButton = root.querySelector('.tag-overflow');
    if (!(overflowButton instanceof HTMLButtonElement) || !overflowButton.closest(ignoreSelector))
      throw new Error('标签溢出按钮未渲染或未被导出忽略');
    return [...root.querySelectorAll('button')].flatMap(button => {
      if (button.closest(ignoreSelector) || button.matches(contentButtonSelector)) return [];
      return [(button.getAttribute('aria-label') || button.textContent?.trim() || button.className).slice(0, 80)];
    });
  }, { ignoreSelector: EXPORT_IGNORE_SELECTOR, contentButtonSelector: exportContentButtons });
  expect(missedChrome, '画布按钮必须要么是导出内容，要么被忽略选择器盖住').toEqual([]);
  const origin = { left: layout.left, top: layout.top };
  const frames = [...layout.frames].sort((a, b) => a.width * a.height - b.width * b.height);
  expect(frames.length).toBeGreaterThanOrEqual(2);
  const innerFrame = frames[0]!;
  const outerFrame = frames[frames.length - 1]!;
  expect(containsBox(outerFrame, innerFrame)).toBe(true);
  const coveredTitle = intersection(layout.topCard.title, layout.bottom.card);
  expect(coveredTitle, '上层标题应落在底层卡片范围内').not.toBeNull();

  await page.getByRole('button', { name: '导出', exact: true }).click();
  const markdownDownload = page.waitForEvent('download');
  await page.getByRole('menuitem', { name: '下载可读摘要（Markdown）', exact: true }).click();
  const markdown = await markdownDownload;
  const markdownPath = resolve(`../backend/artifacts/issue37-20261115/downloads/mixed-r${revision}.md`);
  await markdown.saveAs(markdownPath);
  const summary = await readFile(markdownPath, 'utf8');
  for (const expected of ['底层研究卡', '已保存的长正文', '绿色媒体图注', '财报原件.pdf', '核心观察', '分区1', '分区2', '后续观察', '附着批注', '不能表达的结构与已知缺口'])
    expect(summary).toContain(expected);
  expect(summary).not.toContain('未支持块 text');
  expect((await workspace.state()).project.revision).toBe(revision);

  const pngDownload = page.waitForEvent('download');
  await page.getByRole('menuitem', { name: '下载画布图像（PNG）', exact: true }).click();
  const png = await pngDownload;
  expect(png.suggestedFilename()).toBe(`${sample.state.project.name}-r${revision}.png`);
  const firstPath = resolve(`../backend/artifacts/issue37-20261115/downloads/canvas-r${revision}-first.png`);
  await png.saveAs(firstPath);
  const first = await decodedPng(firstPath);
  expect(first.width).toBeGreaterThanOrEqual(764);
  expect(first.height).toBeGreaterThanOrEqual(584);
  expect(first.greenPixels).toBeGreaterThan(100);
  const overlap = toExportBox(origin, coveredTitle!);
  // #dceee2 与 #f3dfe5 最大通道差 23，二者与画布底 #f6f7f9 的差为 24 和 26。容差必须小于这些差值，否则底色会同时命中两种标题色。
  const titleTolerance = 12;
  expect(colorShare(first, overlap, '#dceee2', titleTolerance)).toBeGreaterThan(0.45);
  expect(colorShare(first, overlap, '#f3dfe5', titleTolerance)).toBeLessThan(0.15);
  expect(colorShare(first, toExportBox(origin, layout.bottom.title), '#f3dfe5', titleTolerance)).toBeGreaterThan(0.45);
  expect(borderHits(first, toExportBox(origin, outerFrame))).toBeGreaterThan(40);
  expect(borderHits(first, toExportBox(origin, innerFrame))).toBeGreaterThan(8);
  expect(inkPixels(first, toExportBox(origin, layout.annotation))).toBeGreaterThan(30);
  expect(colorShare(first, toExportBox(origin, layout.detach), '#f4f1ea', 12)).toBeLessThan(0.08);
  expect(colorShare(first, toExportBox(origin, layout.add), '#f4f1ea', 12)).toBeLessThan(0.08);
  // 文件名按钮底是 #f4f1ea（通道和 719），字形 #243049 才落到 280 以下。整组被滤掉时这块没有墨迹。
  expect(inkPixels(first, toExportBox(origin, layout.filename)), '附件文件名应留在图像里').toBeGreaterThan(30);
  expect((await workspace.state()).project.revision).toBe(revision);
  await info.attach('mixed-canvas-first', { path: firstPath, contentType: 'image/png' });

  await workspace.restart();
  await workspace.open(page);
  await page.getByRole('button', { name: '导出', exact: true }).click();
  const secondDownload = page.waitForEvent('download');
  await page.getByRole('menuitem', { name: '下载画布图像（PNG）', exact: true }).click();
  const secondPath = resolve(`../backend/artifacts/issue37-20261115/downloads/canvas-r${revision}-restarted.png`);
  await (await secondDownload).saveAs(secondPath);
  const second = await decodedPng(secondPath);
  expect(second.width).toBe(first.width);
  expect(second.height).toBe(first.height);
  expect(second.data.equals(first.data)).toBe(true);
  expect((await workspace.state()).project.revision).toBe(revision);

  const restartedMarkdownDownload = page.waitForEvent('download');
  await page.getByRole('menuitem', { name: '下载可读摘要（Markdown）', exact: true }).click();
  const restartedPath = resolve(`../backend/artifacts/issue37-20261115/downloads/mixed-r${revision}-restarted.md`);
  await (await restartedMarkdownDownload).saveAs(restartedPath);
  const restartedSummary = await readFile(restartedPath, 'utf8');
  expect(restartedSummary.replace(/^导出时间：.*$/m, '导出时间：<normalized>')).toBe(summary.replace(/^导出时间：.*$/m, '导出时间：<normalized>'));
  expect((await workspace.state()).project.revision).toBe(revision);
});

test('画布光栅化失败不显示成功，同一已保存状态可重试下载', async ({ page, workspace }) => {
  const sample = await seedCanvasExportSample(page, workspace);
  const revision = sample.state.project.revision;
  const downloads: string[] = [];
  page.on('download', download => downloads.push(download.suggestedFilename()));
  await page.evaluate(() => {
    const original = HTMLCanvasElement.prototype.toBlob;
    let fail = true;
    HTMLCanvasElement.prototype.toBlob = function (callback: BlobCallback, type?: string, quality?: number) {
      if (fail) {
        fail = false;
        throw new Error('受控光栅化失败');
      }
      return original.call(this, callback, type, quality);
    };
  });
  await page.getByRole('button', { name: '导出', exact: true }).click();
  const action = page.getByRole('menuitem', { name: '下载画布图像（PNG）', exact: true });
  await action.click();
  await expect(page.getByRole('status')).toHaveText(/画布图像生成失败：受控光栅化失败/);
  await expect(page.getByRole('status')).not.toHaveText(/下载已开始/);
  expect(downloads).toEqual([]);
  expect((await workspace.state()).project.revision).toBe(revision);

  const retry = page.waitForEvent('download');
  await action.click();
  const download = await retry;
  const path = resolve(`../backend/artifacts/issue37-20261115/downloads/canvas-r${revision}-retry.png`);
  await download.saveAs(path);
  await expect(page.getByRole('status')).toHaveText('画布图像下载已开始');
  expect((await workspace.state()).project.revision).toBe(revision);
  expect((await decodedPng(path)).greenPixels).toBeGreaterThan(100);
});

async function holdCanvasExport(page: Page) {
  await page.evaluate((eventName) => {
    const root = document.querySelector('.canvas .react-flow');
    if (!root) throw new Error('画布尚未完成绘制');
    let release = () => undefined;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const listener = (event: Event) => {
      (event as CustomEvent<{ hold: (paused: Promise<void>) => void }>).detail.hold(gate);
    };
    root.addEventListener(eventName, listener);
    (window as unknown as { __releaseExportHold?: () => void }).__releaseExportHold = () => {
      release();
      root.removeEventListener(eventName, listener);
    };
  }, EXPORT_CAPTURE_EVENT);
}

async function releaseCanvasExport(page: Page) {
  await page.evaluate(() => {
    (window as unknown as { __releaseExportHold?: () => void }).__releaseExportHold?.();
    delete (window as unknown as { __releaseExportHold?: unknown }).__releaseExportHold;
  });
}

test('导出进行中开始拖动时不下载未保存预览，取消后同一 revision 可重新导出', async ({ page, workspace }) => {
  await place(page, '在途拖动卡');
  const saved = await workspace.state();
  const revision = saved.project.revision;
  const node = page.locator('.react-flow__node').first();
  const rest = await node.boundingBox();
  if (!rest) throw new Error('卡片尚未出现');
  const downloads: string[] = [];
  page.on('download', download => downloads.push(download.suggestedFilename()));
  await page.getByRole('button', { name: '导出', exact: true }).click();
  await holdCanvasExport(page);
  await page.getByRole('menuitem', { name: '下载画布图像（PNG）', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('正在生成画布图像…');
  const box = await node.boundingBox();
  if (!box) throw new Error('卡片尚未出现');

  const origin = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await page.mouse.move(origin.x, origin.y);
  await page.mouse.down();
  await page.mouse.move(origin.x + 160, origin.y + 90, { steps: 8 });
  const moved = await node.boundingBox();
  expect(moved!.x).toBeGreaterThan(box.x + 40);

  await releaseCanvasExport(page);
  await expect(page.getByRole('status')).toHaveText(/尚未保存的编辑/);
  expect(downloads).toEqual([]);
  expect(await page.locator('.workspace').getAttribute('data-revision')).toBe(String(revision));
  expect((await workspace.state()).project.revision).toBe(revision);

  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await expect.poll(async () => {
    const back = await node.boundingBox();
    return !!back && Math.abs(back.x - rest.x) < 3 && Math.abs(back.y - rest.y) < 3;
  }).toBe(true);
  expect((await workspace.state()).project.revision).toBe(revision);

  await page.getByRole('button', { name: '导出', exact: true }).click();
  const retry = page.waitForEvent('download');
  await page.getByRole('menuitem', { name: '下载画布图像（PNG）', exact: true }).click();
  const download = await retry;
  expect(download.suggestedFilename()).toBe(`${saved.project.name}-r${revision}.png`);
  expect(await download.path()).not.toBeNull();
  await expect(page.getByRole('status')).toHaveText('画布图像下载已开始');
  expect((await workspace.state()).project.revision).toBe(revision);
  expect(downloads).toEqual([`${saved.project.name}-r${revision}.png`]);
});

test('导出进行中输入尚未保存的正文时，不把草稿下载为旧 revision 图像', async ({ page, workspace }) => {
  await place(page, '在途输入卡');
  const saved = await workspace.state();
  const revision = saved.project.revision;
  const downloads: string[] = [];
  page.on('download', download => downloads.push(download.suggestedFilename()));
  await page.getByRole('button', { name: '导出', exact: true }).click();
  await holdCanvasExport(page);
  await page.getByRole('menuitem', { name: '下载画布图像（PNG）', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('正在生成画布图像…');
  await page.getByRole('button', { name: '编辑正文', exact: true }).click();
  const body = page.getByRole('textbox', { name: '卡片正文', exact: true });
  await body.fill('这是尚未保存的预览正文');
  await expect(page.locator('.react-flow__node').first()).toContainText('这是尚未保存的预览正文');
  await releaseCanvasExport(page);
  expect(await page.locator('.workspace').getAttribute('data-revision')).toBe(String(revision));
  await expect(page.getByRole('status')).toHaveText(/尚未保存的编辑/);
  expect(downloads).toEqual([]);
});

async function drawFrame(page: Page, workspace: Workspace) {
  await page.getByRole('button', { name: '分区', exact: true }).click();
  const bounds = (await page.locator('.react-flow__pane').boundingBox())!;
  await page.mouse.move(bounds.x + 620, bounds.y + 180);
  await page.mouse.down();
  await page.mouse.move(bounds.x + 960, bounds.y + 430, { steps: 6 });
  await page.mouse.up();
  await expect.poll(async () => (await workspace.state()).frames?.length ?? 0).toBe(1);
  await expect(page.getByRole('status')).toHaveText('已保存到本机');
  await page.getByRole('button', { name: '分区1', exact: true }).dblclick();
  await expect(page.getByRole('textbox', { name: '分区名称', exact: true })).toHaveValue('分区1');
}

test('分区名称未按 Enter 保存时，导出动作不可用且不下载', async ({ page, workspace }) => {
  await drawFrame(page, workspace);
  const saved = await workspace.state();
  const revision = saved.project.revision;
  const downloads: string[] = [];
  page.on('download', download => downloads.push(download.suggestedFilename()));
  await page.getByRole('textbox', { name: '分区名称', exact: true }).fill('未保存的分区名');
  await expect(page.locator('.canvas-frame')).toContainText('未保存的分区名');
  await page.getByRole('button', { name: '导出', exact: true }).click();
  await expect(page.getByRole('menuitem', { name: '下载可读摘要（Markdown）', exact: true })).toBeDisabled();
  await expect(page.getByRole('menuitem', { name: '下载画布图像（PNG）', exact: true })).toBeDisabled();
  await expect(page.getByRole('note')).toHaveText('当前有未保存内容，请先完成保存；导出只读取已保存状态。');
  expect(downloads).toEqual([]);
  expect((await workspace.state()).project.revision).toBe(revision);
  expect((await workspace.state()).frames![0]!.name).toBe('分区1');
});

test('导出进行中修改分区名称时，不下载未保存标题', async ({ page, workspace }) => {
  await drawFrame(page, workspace);
  const revision = (await workspace.state()).project.revision;
  const downloads: string[] = [];
  page.on('download', download => downloads.push(download.suggestedFilename()));
  await page.getByRole('button', { name: '导出', exact: true }).click();
  await holdCanvasExport(page);
  await page.getByRole('menuitem', { name: '下载画布图像（PNG）', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('正在生成画布图像…');
  const name = page.getByRole('textbox', { name: '分区名称', exact: true });
  await name.fill('生成途中的分区名');
  await expect(page.locator('.canvas-frame')).toContainText('生成途中的分区名');
  await releaseCanvasExport(page);
  expect(await page.locator('.workspace').getAttribute('data-revision')).toBe(String(revision));
  await expect(page.getByRole('status')).toHaveText(/尚未保存的编辑/);
  expect(downloads).toEqual([]);
  expect((await workspace.state()).project.revision).toBe(revision);
  expect((await workspace.state()).frames![0]!.name).toBe('分区1');
});

test('导出进行中修改连线文字时，不把草稿下载为旧 revision 图像', async ({ page, workspace }) => {
  const projectId = (await workspace.state()).project.id;
  const created = await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'connector.create', expected: null,
    payload: { id: 'export-inflight-line', start: { kind: 'free', point: { x: 180, y: 220 } }, end: { kind: 'free', point: { x: 640, y: 220 } } } });
  await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'connector.label', expected: created.connectorVersions['export-inflight-line'],
    payload: { id: 'export-inflight-line', label: { text: '已保存连线', position: 0.5, fontSize: 16, color: '#252933', bold: false } } });
  await page.reload();
  await expect(page.getByRole('status')).toHaveText('已保存到本机');
  const revision = (await workspace.state()).project.revision;
  let releaseSave = () => undefined;
  await page.route('**/api/mapping/execute', async route => {
    const command = route.request().postDataJSON() as { type?: string };
    if (command.type === 'connector.label') await new Promise<void>(resolve => { releaseSave = resolve; });
    await route.continue();
  });
  const downloads: string[] = [];
  page.on('download', download => downloads.push(download.suggestedFilename()));
  try {
    await page.getByRole('button', { name: '导出', exact: true }).click();
    await holdCanvasExport(page);
    await page.getByRole('menuitem', { name: '下载画布图像（PNG）', exact: true }).click();
    await expect(page.getByRole('status')).toHaveText('正在生成画布图像…');
    await page.getByRole('button', { name: '连线文字', exact: true }).dblclick();
    const input = page.getByRole('textbox', { name: '连线文字', exact: true });
    await expect(input).toHaveValue('已保存连线');
    await input.fill('尚未保存的连线文字');
    await expect(page.locator('.connector-label')).toContainText('尚未保存的连线文字');
    await releaseCanvasExport(page);
    expect(await page.locator('.workspace').getAttribute('data-revision')).toBe(String(revision));
    expect(downloads).toEqual([]);
    await expect(page.getByRole('status')).toHaveText(/尚未保存的编辑/);
  } finally {
    releaseSave();
    await page.unrouteAll({ behavior: 'wait' });
  }
});

test('导出进行中拖动连线文字位置时，不下载未保存的位置预览', async ({ page, workspace }) => {
  const projectId = (await workspace.state()).project.id;
  const created = await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'connector.create', expected: null,
    payload: { id: 'export-label-move', path: 'curve', start: { kind: 'free', point: { x: 220, y: 220 } }, end: { kind: 'free', point: { x: 700, y: 540 } } } });
  await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'connector.label', expected: created.connectorVersions['export-label-move'],
    payload: { id: 'export-label-move', label: { text: '沿曲线移动', position: 0.25, fontSize: 16, color: '#252933', bold: false } } });
  await page.reload();
  await expect(page.getByRole('status')).toHaveText('已保存到本机');
  const revision = (await workspace.state()).project.revision;
  const downloads: string[] = [];
  page.on('download', download => downloads.push(download.suggestedFilename()));
  await page.getByRole('button', { name: '导出', exact: true }).click();
  await holdCanvasExport(page);
  await page.getByRole('menuitem', { name: '下载画布图像（PNG）', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('正在生成画布图像…');
  const curve = page.getByRole('button', { name: '普通连线', exact: true }).locator('path');
  const target = await curve.evaluate(element => {
    const path = element as SVGPathElement;
    const point = path.getPointAtLength(path.getTotalLength() * 0.82);
    const screen = new DOMPoint(point.x, point.y).matrixTransform(path.getScreenCTM()!);
    return { x: screen.x, y: screen.y };
  });
  const label = page.getByRole('button', { name: '连线文字', exact: true });
  await label.hover();
  await page.mouse.down();
  await page.mouse.move(target.x, target.y, { steps: 8 });
  await expect.poll(async () => {
    const box = await label.boundingBox();
    return !!box && Math.hypot(box.x + box.width / 2 - target.x, box.y + box.height / 2 - target.y) < 2;
  }).toBe(true);
  await releaseCanvasExport(page);
  expect(await page.locator('.workspace').getAttribute('data-revision')).toBe(String(revision));
  await expect(page.getByRole('status')).toHaveText(/尚未保存的编辑/);
  expect(downloads).toEqual([]);
  expect((await workspace.state()).project.revision).toBe(revision);
  expect((await workspace.state()).connectors![0]!.label!.position).toBe(0.25);
  await page.keyboard.press('Escape');
  await page.mouse.up();
});

test('正文保存失败时松开标签，位置预览退出且正文保存后仍可导出图像', async ({ page, workspace }) => {
  await place(page, '导出正文卡', 80, 80);
  const projectId = (await workspace.state()).project.id;
  const created = await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'connector.create', expected: null,
    payload: { id: 'export-label-reject', path: 'curve', start: { kind: 'free', point: { x: 220, y: 220 } }, end: { kind: 'free', point: { x: 700, y: 540 } } } });
  await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'connector.label', expected: created.connectorVersions['export-label-reject'],
    payload: { id: 'export-label-reject', label: { text: '沿曲线移动', position: 0.25, fontSize: 16, color: '#252933', bold: false } } });
  await page.reload();
  await expect(page.getByRole('status')).toHaveText('已保存到本机');
  let failBody = true;
  await page.route('**/api/mapping/execute', async route => {
    const command = route.request().postDataJSON() as { type?: string };
    if (failBody && command.type === 'body.edit') {
      await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ code: 'SAVE_FAILED', message: '正文保存失败' }) });
      return;
    }
    await route.continue();
  });
  const labelCommands: unknown[] = [];
  const recordLabel = (request: import('@playwright/test').Request) => {
    if (request.url().endsWith('/api/mapping/execute') && request.postDataJSON()?.type === 'connector.label') labelCommands.push(request.postDataJSON());
  };
  page.on('request', recordLabel);
  try {
    await page.getByRole('button', { name: '编辑正文', exact: true }).click();
    await page.getByRole('textbox', { name: '卡片正文', exact: true }).fill('尚未保存的正文');
    await expect(page.getByRole('status')).toHaveText('保存未完成');
    const curve = page.getByRole('button', { name: '普通连线', exact: true }).locator('path');
    const target = await curve.evaluate(element => {
      const path = element as SVGPathElement;
      const point = path.getPointAtLength(path.getTotalLength() * 0.82);
      const screen = new DOMPoint(point.x, point.y).matrixTransform(path.getScreenCTM()!);
      return { x: screen.x, y: screen.y };
    });
    const label = page.getByRole('button', { name: '连线文字', exact: true });
    const initial = (await label.boundingBox())!;
    await label.hover();
    await page.mouse.down();
    await page.mouse.move(target.x, target.y, { steps: 8 });
    await expect.poll(async () => {
      const box = await label.boundingBox();
      return !!box && Math.hypot(box.x + box.width / 2 - target.x, box.y + box.height / 2 - target.y) < 2;
    }).toBe(true);
    await page.mouse.up();
    await expect.poll(async () => {
      const box = await label.boundingBox();
      return !!box && Math.hypot(box.x - initial.x, box.y - initial.y) < 1;
    }).toBe(true);
    expect(labelCommands).toEqual([]);
    expect((await workspace.state()).connectors!.find(item => item.id === 'export-label-reject')!.label!.position).toBe(0.25);
    failBody = false;
    await page.getByRole('button', { name: '重试保存', exact: true }).click();
    await expect(page.getByRole('status')).toHaveText('已保存到本机');
    expect(labelCommands).toEqual([]);
    expect((await workspace.state()).connectors!.find(item => item.id === 'export-label-reject')!.label!.position).toBe(0.25);
    await page.getByRole('button', { name: '关闭正文', exact: true }).click();
    await expect(page.getByRole('complementary', { name: '写字板', exact: true })).toHaveCount(0);
    const downloads: string[] = [];
    page.on('download', download => downloads.push(download.suggestedFilename()));
    await page.getByRole('button', { name: '导出', exact: true }).click();
    const image = page.getByRole('menuitem', { name: '下载画布图像（PNG）', exact: true });
    await expect(image).toBeEnabled();
    const png = page.waitForEvent('download');
    await image.click();
    expect((await png).suggestedFilename()).toContain('.png');
    await expect(page.getByRole('status')).toHaveText('画布图像下载已开始');
    expect(downloads).toHaveLength(1);
    expect((await workspace.state()).connectors!.find(item => item.id === 'export-label-reject')!.label!.position).toBe(0.25);
  } finally {
    page.off('request', recordLabel);
    await page.unrouteAll({ behavior: 'ignoreErrors' });
  }
});

test('未确认保存时两个导出动作都禁用，保存完成后才恢复且草稿未另写', async ({ page, workspace }) => {
  await place(page, '草稿边界卡');
  const before = await workspace.state();
  let release: (() => void) | undefined;
  await page.route('**/api/mapping/execute', async route => {
    const command = route.request().postDataJSON() as { type?: string };
    if (command.type === 'body.edit') await new Promise<void>(resolve => { release = resolve; });
    await route.continue();
  });
  await page.getByRole('button', { name: '编辑正文', exact: true }).click();
  await page.getByRole('textbox', { name: '卡片正文', exact: true }).fill('尚未确认保存的草稿');
  await expect.poll(() => release !== undefined).toBe(true);
  await page.getByRole('button', { name: '导出', exact: true }).click();
  const markdown = page.getByRole('menuitem', { name: '下载可读摘要（Markdown）', exact: true });
  const image = page.getByRole('menuitem', { name: '下载画布图像（PNG）', exact: true });
  await expect(markdown).toBeDisabled();
  await expect(image).toBeDisabled();
  await expect(page.getByRole('note')).toHaveText('当前有未保存内容，请先完成保存；导出只读取已保存状态。');
  expect((await workspace.state()).project.revision).toBe(before.project.revision);
  release!();
  await expect(page.getByRole('status')).toHaveText('已保存到本机');
  await expect(markdown).toBeEnabled();
  await expect(image).toBeEnabled();
  expect((await workspace.state()).project.revision).toBe(before.project.revision + 1);
});

test('裁剪进行中不下载图像，取消后两个导出动作恢复', async ({ page, workspace }) => {
  const projectId = (await workspace.state()).project.id;
  const source = '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="60"><rect width="80" height="60" fill="#22c55e"/></svg>';
  await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'asset.save', expected: null,
    payload: { id: 'export-crop', name: '导出裁剪.svg', mime: 'image/svg+xml', base64: Buffer.from(source).toString('base64') } });
  await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'image.create', expected: null,
    payload: { id: 'export-crop-image', content: { assetId: 'export-crop', crop: { x: 0, y: 0, width: 1, height: 1 } },
      pose: { x: 120, y: 120, width: 160, height: 120, rotation: 0 } } });
  await page.reload();
  await expect(page.getByRole('status')).toHaveText('已保存到本机');
  const revision = (await workspace.state()).project.revision;
  await page.getByRole('img', { name: '导出裁剪.svg', exact: true }).click();
  await page.getByRole('toolbar', { name: '图片操作', exact: true }).getByRole('button', { name: '裁剪', exact: true }).click();
  await expect(page.getByRole('region', { name: '图片裁剪', exact: true })).toBeVisible();
  const downloads: string[] = [];
  page.on('download', download => downloads.push(download.suggestedFilename()));
  await page.getByRole('button', { name: '导出', exact: true }).click();
  const markdown = page.getByRole('menuitem', { name: '下载可读摘要（Markdown）', exact: true });
  const image = page.getByRole('menuitem', { name: '下载画布图像（PNG）', exact: true });
  await expect(page.getByRole('note')).toHaveText('当前有未保存内容，请先完成保存；导出只读取已保存状态。');
  await expect(markdown).toBeDisabled();
  await expect(image).toBeDisabled();
  expect(downloads).toEqual([]);
  expect((await workspace.state()).project.revision).toBe(revision);
  await page.getByRole('toolbar', { name: '裁剪操作', exact: true }).getByRole('button', { name: '取消', exact: true }).click();
  await expect(page.getByRole('region', { name: '图片裁剪', exact: true })).toHaveCount(0);
  await expect(page.getByRole('note')).toHaveCount(0);
  await expect(markdown).toBeEnabled();
  await expect(image).toBeEnabled();
  expect(downloads).toEqual([]);
  expect((await workspace.state()).project.revision).toBe(revision);
});
