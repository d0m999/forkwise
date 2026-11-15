import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { loadImage, createCanvas } from '../../backend/node_modules/@napi-rs/canvas/index.js';
import type { Page } from '@playwright/test';
import { test, expect, place, type Workspace } from './writing-board-fixture';
import { seedCanvasExportSample } from './canvas-export-fixture';

test('同一导出入口可读摘要失败不报错成功，重试后真实下载且项目未改', async ({ page, workspace }) => {
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
  await page.evaluate(() => {
    let release = () => undefined;
    const gate = new Promise<void>(resolve => { release = resolve; });
    (window as unknown as { __forkwiseExportHold?: () => Promise<void> }).__forkwiseExportHold = () => gate;
    (window as unknown as { __releaseExportHold?: () => void }).__releaseExportHold = release;
  });
}

async function releaseCanvasExport(page: Page) {
  await page.evaluate(() => {
    (window as unknown as { __releaseExportHold?: () => void }).__releaseExportHold?.();
    delete (window as unknown as { __forkwiseExportHold?: unknown }).__forkwiseExportHold;
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
