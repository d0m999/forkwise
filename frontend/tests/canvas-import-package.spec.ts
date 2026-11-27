import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, expect, place } from './writing-board-fixture';
import { seedCanvasExportSample } from './canvas-export-fixture';
import { readZip, writeZip } from '../../backend/src/mapping/zip-store';
import { verifyPackage } from '../../backend/src/mapping/package-verify';

function manifestOf(bytes: Buffer) {
  return JSON.parse(readZip(bytes).get('forkwise-project.json')!.toString('utf8')) as Record<string, any>;
}

async function stateOf(page: import('@playwright/test').Page, origin: string, projectId: string) {
  const response = await page.request.get(`${origin}/api/mapping/projects/${projectId}`);
  expect(response.ok()).toBe(true);
  return await response.json() as Record<string, any>;
}

async function projectsOf(page: import('@playwright/test').Page, origin: string) {
  const response = await page.request.get(`${origin}/api/mapping/projects`);
  expect(response.ok()).toBe(true);
  return await response.json() as { id: string; name: string; revision: number }[];
}

async function openPackage(page: import('@playwright/test').Page, path: string) {
  const trigger = page.getByRole('button', { name: '导入项目包', exact: true });
  const chooserPromise = page.waitForEvent('filechooser');
  await trigger.click();
  const chooser = await chooserPromise;
  await chooser.setFiles(path);
  const dialog = page.getByRole('dialog', { name: '导入项目包' });
  await expect(dialog).toBeVisible();
  return { trigger, dialog };
}

async function exportPackage(page: import('@playwright/test').Page): Promise<string> {
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出', exact: true }).click();
  await page.getByRole('menuitem', { name: '下载完整项目包（ZIP）', exact: true }).click();
  const download = await downloadPromise;
  const path = await download.path();
  expect(path).not.toBeNull();
  return path!;
}

for (const width of [1360, 760]) test(`${width}px 坏 ZIP 先读到校验错误，取消后可重选`, async ({ page, workspace }, info) => {
  await page.setViewportSize({ width, height: 900 });
  const before = await projectsOf(page, workspace.origin);
  const isolated = mkdtempSync(join(tmpdir(), 'forkwise-import-bad-zip-'));
  try {
    const path = join(isolated, '坏项目包.zip');
    writeFileSync(path, Buffer.from('这不是 ZIP'));
    const { dialog, trigger } = await openPackage(page, path);
    const error = dialog.getByRole('alert');
    const reason = error.getByText('ZIP 缺少目录', { exact: false });
    await expect(reason).toBeVisible();
    await expect(reason).toBeInViewport({ ratio: 1 });
    await expect(error).toBeFocused({ timeout: 3000 });
    expect(await dialog.evaluate(element => element.scrollTop)).toBe(0);
    await expect(dialog.getByLabel('新研究名称')).toHaveCount(0);
    await expect(dialog.getByRole('region', { name: '导入范围' })).toHaveCount(0);
    await expect(dialog.getByRole('region', { name: '导入缺口' })).toHaveCount(0);
    await expect(dialog.getByRole('button', { name: '导入为新研究' })).toBeDisabled();
    await page.screenshot({ path: info.outputPath('bad-zip-first-view.png') });
    await page.keyboard.press('Tab');
    const cancel = dialog.getByRole('button', { name: '取消', exact: true });
    await expect(cancel).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(dialog).toHaveCount(0);
    await expect(trigger).toBeFocused();
    await openPackage(page, path);
    await expect(error).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(trigger).toBeFocused();
    expect(await projectsOf(page, workspace.origin)).toEqual(before);
  } finally {
    rmSync(isolated, { recursive: true, force: true });
  }
});

test('预览校验后导入隔离研究：取消无副作用、确认后逐项对上包内原文、停服重开仍在', async ({ page, workspace }) => {
  test.setTimeout(180000);
  await seedCanvasExportSample(page, workspace);
  const projectId = (await workspace.state()).project.id;
  const execute = (command: Record<string, unknown>) => workspace.execute(page, { commandId: crypto.randomUUID(), projectId, ...command });
  await execute({ type: 'shape.create', expected: null, payload: { id: 'import-shape', content: { shapeType: 'ellipse', shortText: '导入形状', fill: '#dce8dd' }, pose: { x: 900, y: 520, width: 140, height: 90 } } });
  await execute({ type: 'stroke.create', expected: null, payload: { id: 'import-stroke', content: { penKind: 'pen', path: [{ x: 0, y: 0 }, { x: 40, y: 30 }], color: '#365ec9', width: 3, opacity: 1 }, pose: { x: 900, y: 640, width: 60, height: 50 } } });
  let current = await workspace.state();
  const shapeItemId = current.shapes!.find((shape) => shape.id === 'import-shape')!.item.id;
  const strokeItemId = current.strokes!.find((stroke) => stroke.id === 'import-stroke')!.item.id;
  await execute({ type: 'group.create', expected: { groups: { 'import-group': null }, containment: { [shapeItemId]: null, [strokeItemId]: null } }, payload: { id: 'import-group', itemIds: [shapeItemId, strokeItemId] } });
  await page.reload();
  await expect(page.getByRole('status')).toHaveText('已保存到本机');
  const source = await workspace.state();
  const sourceRevision = source.project.revision;

  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出', exact: true }).click();
  await page.getByRole('menuitem', { name: '下载完整项目包（ZIP）', exact: true }).click();
  const download = await downloadPromise;
  const packagePath = await download.path();
  expect(packagePath).not.toBeNull();
  const packageBytes = readFileSync(packagePath!);
  expect(verifyPackage(packageBytes)).toEqual([]);
  const manifest = manifestOf(packageBytes);
  expect(manifest.research).toBeNull();
  const tabsBefore = await page.getByRole('tab').count();

  const first = await openPackage(page, packagePath!);
  await expect(first.dialog.getByLabel('新研究名称')).toHaveValue(manifest.mapping.project.name);
  await page.keyboard.press('Shift+Tab');
  await expect(first.dialog.getByRole('button', { name: '导入为新研究', exact: true })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(first.dialog.getByLabel('新研究名称')).toBeFocused();
  await expect(first.dialog.getByText('没有旧研究归档', { exact: false })).toBeVisible();
  await expect(first.dialog.getByText('叠放与归属已按包内原文重算通过', { exact: false })).toBeVisible();
  await expect(first.dialog.getByText('撤销和重做不会从包里恢复', { exact: false })).toBeVisible();
  await expect(first.dialog.getByRole('button', { name: '导入为新研究', exact: true })).toBeEnabled();
  expect((await projectsOf(page, workspace.origin)).length).toBe(tabsBefore);
  await first.dialog.getByRole('button', { name: '取消', exact: true }).click();
  await expect(first.dialog).toHaveCount(0);
  await expect(first.trigger).toBeFocused();
  expect((await projectsOf(page, workspace.origin)).length).toBe(tabsBefore);

  const second = await openPackage(page, packagePath!);
  await expect(second.dialog.getByLabel('新研究名称')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(second.dialog).toHaveCount(0);
  await expect(second.trigger).toBeFocused();
  expect((await projectsOf(page, workspace.origin)).length).toBe(tabsBefore);

  await page.setViewportSize({ width: 760, height: 900 });
  const third = await openPackage(page, packagePath!);
  await third.dialog.getByLabel('新研究名称').fill('导入副本·中文');
  await page.keyboard.press('Shift+Tab');
  const confirm = third.dialog.getByRole('button', { name: '导入为新研究', exact: true });
  await expect(confirm).toBeFocused();
  await expect(confirm).toBeInViewport({ ratio: 1 });
  let release!: () => void;
  const opening = new Promise<void>(resolve => { release = resolve; });
  const openingMap = (url: URL) => /^\/api\/mapping\/projects\/[^/]+\/map$/.test(url.pathname) &&
    url.pathname !== `/api/mapping/projects/${source.project.id}/map`;
  await page.route(openingMap, async route => {
    await opening;
    await route.continue();
  });
  try {
    await page.keyboard.press('Enter');
    await expect(third.dialog).toHaveCount(0);
    await expect(third.trigger).toBeDisabled();
  } finally {
    release();
  }
  await expect(page.getByRole('tab', { selected: true })).toContainText('导入副本·中文');
  await page.unroute(openingMap);
  await expect(third.trigger).toBeFocused({ timeout: 4000 });
  await expect(page.getByRole('tab')).toHaveCount(tabsBefore + 1);
  await expect(page.getByRole('tab', { name: new RegExp(manifest.mapping.project.name) })).toBeVisible();

  const projects = await projectsOf(page, workspace.origin);
  const importedProject = projects.find((project) => project.name === '导入副本·中文')!;
  const imported = await stateOf(page, workspace.origin, importedProject.id);
  expect(imported.project.revision).toBe(1);

  const sourceById = new Map(source.cards.map((card: any) => [card.id, card]));
  const tagName = new Map(manifest.mapping.tags.map((tag: any) => [tag.id, tag.name]));
  const importedTagName = new Map((imported.tags ?? []).map((tag: any) => [tag.id, tag.name]));
  expect(imported.cards).toHaveLength(manifest.mapping.cards.length);
  for (const card of imported.cards as any[]) {
    const original = manifest.mapping.cards.find((item: any) => item.title === card.title)!;
    expect(card.id).not.toBe(original.id);
    expect(card.body.blocks).toEqual(original.body.blocks);
    expect(card.body.id).toBe(original.body.id);
    expect(card.item.id).toBe(original.item.id);
    expect(card.item.pose).toEqual(original.item.pose);
    expect(card.appearance?.titleColor).toBe(original.appearance?.titleColor);
    expect(card.attachments?.items.map((item: any) => [item.assetId, item.name]))
      .toEqual(original.attachments?.items.map((item: any) => [item.assetId, item.name]));
    expect(card.cardTags?.tagIds.map((id: string) => importedTagName.get(id)))
      .toEqual(original.cardTags?.tagIds.map((id: string) => tagName.get(id)));
  }
  expect(imported.texts.map((value: any) => [value.content, value.item.pose, value.item.createdOrder]))
    .toEqual(manifest.mapping.texts.map((value: any) => [value.content, value.item.pose, value.item.createdOrder]));
  expect(imported.shapes.map((value: any) => [value.content, value.item.pose, value.item.createdOrder]))
    .toEqual(manifest.mapping.shapes.map((value: any) => [value.content, value.item.pose, value.item.createdOrder]));
  expect(imported.strokes.map((value: any) => [value.content, value.item.pose]))
    .toEqual(manifest.mapping.strokes.map((value: any) => [value.content, value.item.pose]));
  expect(imported.images.map((value: any) => [value.content, value.item.pose]))
    .toEqual(manifest.mapping.images.map((value: any) => [value.content, value.item.pose]));
  expect(imported.connectors.map((value: any) => [value.path, value.start, value.end, value.style, value.label]))
    .toEqual(manifest.mapping.connectors.map((value: any) => [value.path, value.start, value.end, value.style, value.label]));
  const importedFrameByName = new Map(imported.frames.map((frame: any) => [frame.name, frame]));
  expect(imported.frames.map((frame: any) => [frame.name, frame.background, frame.pose]))
    .toEqual(manifest.mapping.frames.map((frame: any) => [frame.name, frame.background, frame.pose]));
  expect(imported.groups.map((group: any) => [group.itemId, group.createdOrder]))
    .toEqual(manifest.mapping.groups.map((group: any) => [group.itemId, group.createdOrder]));
  expect(imported.tags!.map((tag: any) => [tag.name, tag.color]).sort())
    .toEqual(manifest.mapping.tags.map((tag: any) => [tag.name, tag.color]).sort());
  expect(imported.attachments!.map((attachment: any) => [attachment.id, attachment.target?.itemId, attachment.versionId]).sort())
    .toEqual(manifest.mapping.attachments.map((attachment: any) => [attachment.id, attachment.target?.itemId, attachment.versionId]).sort());

  const frameNameByOldId = new Map(manifest.mapping.frames.map((frame: any) => [frame.id, frame.name]));
  const frameNameByNewId = new Map(imported.frames.map((frame: any) => [frame.id, frame.name]));
  const normalizeContainment = (rows: any[], nameOf: (id: string) => string) =>
    rows.map((row) => [
      nameOf(row.id),
      row.parent?.kind ?? null,
      row.parent?.kind === 'frame' ? nameOf(row.parent.id) : row.parent?.id,
    ]).sort();
  expect(normalizeContainment(imported.containment!, (id) => frameNameByNewId.get(id) ?? id))
    .toEqual(normalizeContainment(manifest.mapping.containment, (id) => frameNameByOldId.get(id) ?? id));

  for (const resource of manifest.resources as { id: string; sha256: string }[]) {
    const response = await page.request.get(`${workspace.origin}/api/mapping/projects/${importedProject.id}/assets/${encodeURIComponent(resource.id)}`);
    expect(response.ok(), resource.id).toBe(true);
    const asset = await response.json() as { base64: string; hash: string };
    const bytes = Buffer.from(asset.base64, 'base64');
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(resource.sha256);
    expect(asset.hash).toBe(resource.sha256);
  }

  await page.getByRole('tab', { name: new RegExp(manifest.mapping.project.name) }).click();
  await expect(page.getByRole('tab', { selected: true })).toContainText(manifest.mapping.project.name);
  const sourceAfter = await stateOf(page, workspace.origin, source.project.id);
  expect(sourceAfter.project.revision).toBe(sourceRevision);
  expect(sourceAfter.cards.map((card: any) => [card.id, card.title, card.body.versionId]))
    .toEqual(source.cards.map((card: any) => [card.id, card.title, card.body.versionId]));
  expect(sourceAfter.connectors!.map((connector: any) => [connector.id, connector.versionId]))
    .toEqual(source.connectors!.map((connector: any) => [connector.id, connector.versionId]));

  await page.getByRole('tab', { name: /导入副本·中文/ }).click();
  await expect(page.getByRole('tab', { selected: true })).toContainText('导入副本·中文');
  await workspace.restart();
  await page.reload();
  await expect(page.getByRole('tab', { selected: true })).toContainText('导入副本·中文');
  await expect(page.getByRole('status')).toHaveText('已保存到本机');
  const reopened = await stateOf(page, workspace.origin, importedProject.id);
  expect(reopened.cards.map((card: any) => [card.title, card.body.blocks, card.item.pose]))
    .toEqual(imported.cards.map((card: any) => [card.title, card.body.blocks, card.item.pose]));
  expect(reopened.connectors!.map((connector: any) => [connector.start, connector.end, connector.label]))
    .toEqual(imported.connectors!.map((connector: any) => [connector.start, connector.end, connector.label]));
  expect(reopened.frames!.map((frame: any) => [frame.name, frame.id]).sort())
    .toEqual(imported.frames!.map((frame: any) => [frame.name, frame.id]).sort());

  const isolated = mkdtempSync(join(tmpdir(), 'forkwise-import-broken-'));
  try {
    const files = readZip(packageBytes);
    const brokenManifest = JSON.parse(files.get('forkwise-project.json')!.toString('utf8')) as Record<string, any>;
    brokenManifest.resources[0].sha256 = '0'.repeat(64);
    expect(files.delete(brokenManifest.resources[1].path)).toBe(true);
    files.set('forkwise-project.json', Buffer.from(JSON.stringify(brokenManifest)));
    const brokenPath = join(isolated, 'broken.zip');
    writeFileSync(brokenPath, writeZip([...files].map(([name, data]) => ({ name, data }))));
    const broken = await openPackage(page, brokenPath);
    const error = broken.dialog.getByRole('alert');
    await expect(error.getByText('RESOURCE_HASH', { exact: false })).toBeVisible();
    await expect(error.getByText('RESOURCE_MISSING', { exact: false })).toBeVisible();
    await expect(error).toBeFocused();
    await expect(broken.dialog.getByRole('button', { name: '导入为新研究', exact: true })).toBeDisabled();
    await broken.dialog.getByRole('button', { name: '取消', exact: true }).click();
    expect((await projectsOf(page, workspace.origin)).length).toBe(tabsBefore + 1);
  } finally {
    rmSync(isolated, { recursive: true, force: true });
  }

  expect(sourceById.size).toBeGreaterThan(0);
  expect(sourceById.has(imported.cards[0]!.id)).toBe(false);
});


test('请求未送达时刷新并重选同一包，直接重试按上次输入的名称导入', async ({ page, workspace }) => {
  await place(page, '名称恢复卡');
  const packagePath = await exportPackage(page);
  const before = await projectsOf(page, workspace.origin);
  const attempts: { commandId: string; projectId: string; name: string }[] = [];
  await page.route('**/api/mapping/execute', async route => {
    const body = route.request().postDataJSON();
    if (body.type !== 'project.import') return route.continue();
    attempts.push({ commandId: body.commandId, projectId: body.projectId, name: body.payload.name });
    if (attempts.length === 1) return route.abort();
    await route.continue();
  });

  const { dialog } = await openPackage(page, packagePath);
  await dialog.getByLabel('新研究名称').fill('我填写的研究名称');
  await dialog.getByRole('button', { name: '导入为新研究', exact: true }).click();
  await expect(dialog.getByText('响应未收到', { exact: false })).toBeVisible();
  expect(await projectsOf(page, workspace.origin)).toEqual(before);

  await page.reload();
  const reopened = await openPackage(page, packagePath);
  await expect(reopened.dialog.getByLabel('新研究名称')).toHaveValue('我填写的研究名称');
  await reopened.dialog.getByRole('button', { name: '导入为新研究', exact: true }).click();
  await expect(page.getByRole('tab', { selected: true })).toContainText('我填写的研究名称');
  expect(attempts).toHaveLength(2);
  expect(attempts[1]).toEqual(attempts[0]);
  expect(await projectsOf(page, workspace.origin)).toHaveLength(before.length + 1);
});

test('响应丢失后刷新并重选同包同名，用原命令和项目编号重试只建一个项目', async ({ page, workspace }) => {
  test.setTimeout(120000);
  await place(page, '重试卡');
  const packagePath = await exportPackage(page);
  const tabsBefore = await page.getByRole('tab').count();
  let dropped = false;
  const attempts: { commandId: string; projectId: string }[] = [];
  await page.route('**/api/mapping/execute', async (route) => {
    const body = route.request().postDataJSON();
    if (body?.type === 'project.import') attempts.push({ commandId: body.commandId, projectId: body.projectId });
    if (!dropped && body?.type === 'project.import') {
      dropped = true;
      expect((await route.fetch()).ok()).toBe(true);
      await route.abort('failed');
      return;
    }
    await route.continue();
  });
  const { dialog } = await openPackage(page, packagePath);
  await dialog.getByLabel('新研究名称').fill('重试导入');
  await dialog.getByRole('button', { name: '导入为新研究', exact: true }).click();
  await expect(dialog.getByText('响应未收到', { exact: false })).toBeVisible();
  // 服务端已提交、客户端没收到响应；此时项目已经存在，重试只能复用原回执。
  expect((await projectsOf(page, workspace.origin)).length).toBe(tabsBefore + 1);
  const stored = await page.evaluate(() => Object.values(sessionStorage).join(''));
  expect(stored).not.toContain(readFileSync(packagePath).toString('base64'));
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  // 另一份包可以独立导入，且不会清除第一份包的待确认请求。
  const isolated = mkdtempSync(join(tmpdir(), 'forkwise-import-other-'));
  try {
    const otherPath = join(isolated, 'other.zip');
    const files = readZip(readFileSync(packagePath));
    const otherManifest = JSON.parse(files.get('forkwise-project.json')!.toString('utf8')) as Record<string, any>;
    otherManifest.mapping.project.name = '另一个包';
    files.set('forkwise-project.json', Buffer.from(JSON.stringify(otherManifest)));
    writeFileSync(otherPath, writeZip([...files].map(([name, data]) => ({ name, data }))));
    const switched = await openPackage(page, otherPath);
    await expect(switched.dialog.getByLabel('新研究名称')).toHaveValue('另一个包');
    await switched.dialog.getByRole('button', { name: '导入为新研究', exact: true }).click();
    await expect(page.getByRole('tab', { selected: true })).toContainText('另一个包');
  } finally {
    rmSync(isolated, { recursive: true, force: true });
  }
  await page.reload();
  const reopened = await openPackage(page, packagePath);
  await expect(reopened.dialog.getByLabel('新研究名称')).toHaveValue('重试导入');
  await reopened.dialog.getByRole('button', { name: '导入为新研究', exact: true }).click();
  await expect(page.getByRole('tab', { selected: true })).toContainText('重试导入');
  const projects = await projectsOf(page, workspace.origin);
  expect(projects.filter((project) => project.name === '重试导入')).toHaveLength(1);
  await expect(page.getByRole('tab')).toHaveCount(tabsBefore + 2);
  expect(attempts).toHaveLength(3);
  expect(attempts[1]!.projectId).not.toBe(attempts[0]!.projectId);
  expect(attempts[1]!.commandId).not.toBe(attempts[0]!.commandId);
  expect(attempts[2]).toEqual(attempts[0]);
  // 原回执已确认，再次明确导入同包同名属于新的请求。
  const next = await openPackage(page, packagePath);
  await next.dialog.getByLabel('新研究名称').fill('重试导入');
  await next.dialog.getByRole('button', { name: '导入为新研究', exact: true }).click();
  await expect(page.getByRole('tab')).toHaveCount(tabsBefore + 3);
  expect(attempts[3]!.projectId).not.toBe(attempts[0]!.projectId);
  expect(attempts[3]!.commandId).not.toBe(attempts[0]!.commandId);
  await page.unroute('**/api/mapping/execute');
});

test('响应丢失后刷新并改名重试时 ID_CONFLICT 直接打开已导入项目', async ({ page, workspace }) => {
  test.setTimeout(120000);
  await place(page, '改名重试卡');
  const packagePath = await exportPackage(page);
  const tabsBefore = await page.getByRole('tab').count();
  const attempts: { commandId: string; projectId: string }[] = [];
  await page.route('**/api/mapping/execute', async (route) => {
    const body = route.request().postDataJSON();
    if (body?.type === 'project.import') {
      attempts.push({ commandId: body.commandId, projectId: body.projectId });
      if (attempts.length === 1) {
        expect((await route.fetch()).ok()).toBe(true);
        await route.abort('failed');
        return;
      }
    }
    await route.continue();
  });
  const { dialog } = await openPackage(page, packagePath);
  await dialog.getByLabel('新研究名称').fill('改名导入');
  await dialog.getByRole('button', { name: '导入为新研究', exact: true }).click();
  await expect(dialog.getByText('响应未收到', { exact: false })).toBeVisible();
  await page.reload();
  const reopened = await openPackage(page, packagePath);
  await reopened.dialog.getByLabel('新研究名称').fill('另一个名字');
  await reopened.dialog.getByRole('button', { name: '导入为新研究', exact: true }).click();
  await expect(page.getByRole('tab', { selected: true })).toContainText('改名导入');
  await expect(page.getByRole('tab')).toHaveCount(tabsBefore + 1);
  const projects = await projectsOf(page, workspace.origin);
  expect(projects.filter((project) => project.name === '另一个名字')).toHaveLength(0);
  expect(attempts).toHaveLength(2);
  expect(attempts[1]!.projectId).toBe(attempts[0]!.projectId);
  expect(attempts[1]!.commandId).not.toBe(attempts[0]!.commandId);
  await page.unroute('**/api/mapping/execute');
});

test('导入结果未知或重试无权限时保留请求，确定性拒绝后再次导入使用新编号', async ({ page, workspace }) => {
  const packagePath = await exportPackage(page);
  const attempts: { commandId: string; projectId: string }[] = [];
  await page.route('**/api/mapping/execute', async (route) => {
    const body = route.request().postDataJSON();
    if (body?.type === 'project.import') {
      attempts.push({ commandId: body.commandId, projectId: body.projectId });
      if (attempts.length === 1)
        return route.fulfill({ status: 503, json: { code: 'SAVE_FAILED', message: '暂时不可用' } });
      if (attempts.length === 2)
        return route.fulfill({ status: 403, json: { code: 'FORBIDDEN', message: '当前无权读取回执' } });
      if (attempts.length === 3)
        return route.fulfill({ status: 400, json: { code: 'INVALID_PACKAGE', message: '完整项目包校验未通过' } });
    }
    await route.continue();
  });
  const { dialog } = await openPackage(page, packagePath);
  await dialog.getByLabel('新研究名称').fill('服务拒绝后重新导入');
  await dialog.getByRole('button', { name: '导入为新研究', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('原请求已保留');
  await page.reload();
  const reopened = await openPackage(page, packagePath);
  await reopened.dialog.getByLabel('新研究名称').fill('服务拒绝后重新导入');
  const submit = reopened.dialog.getByRole('button', { name: '导入为新研究', exact: true });
  await submit.click();
  await expect(reopened.dialog.getByRole('alert')).toContainText('当前无权读取回执');
  await submit.click();
  await expect(reopened.dialog.getByRole('alert')).toContainText('完整项目包校验未通过');
  await submit.click();
  await expect(page.getByRole('tab', { selected: true })).toContainText('服务拒绝后重新导入');
  expect(attempts).toHaveLength(4);
  expect(attempts[1]).toEqual(attempts[0]);
  expect(attempts[2]).toEqual(attempts[0]);
  expect(attempts[3]!.projectId).not.toBe(attempts[0]!.projectId);
  expect(attempts[3]!.commandId).not.toBe(attempts[0]!.commandId);
  expect((await projectsOf(page, workspace.origin)).filter((project) => project.name === '服务拒绝后重新导入')).toHaveLength(1);
});

test('导入重试记录暂时不可读时，仍可查看只读预览', async ({ page, workspace }) => {
  const packagePath = await exportPackage(page);
  const before = await projectsOf(page, workspace.origin);
  await page.evaluate(() => {
    const original = Storage.prototype.getItem;
    Storage.prototype.getItem = function (key) {
      if (this === sessionStorage && key.startsWith('forkwise:import-attempt:v1:'))
        throw new DOMException('暂时无法读取导入记录', 'SecurityError');
      return original.call(this, key);
    };
  });

  const { dialog } = await openPackage(page, packagePath);
  await expect(dialog.getByText('浏览器无法读取导入重试记录', { exact: false })).toBeVisible();
  await expect(dialog.getByRole('region', { name: '导入范围' })).toBeVisible({ timeout: 3000 });
  await expect(dialog.getByRole('region', { name: '导入缺口' })).toBeVisible();
  await expect(dialog.getByRole('region', { name: '身份映射' })).toBeVisible();
  await expect(dialog.getByRole('button', { name: '导入为新研究', exact: true })).toBeDisabled();
  expect(await projectsOf(page, workspace.origin)).toEqual(before);
});

test('会话存储拒写时不发送导入，已导入但清理失败时仍能打开项目', async ({ page, workspace }) => {
  const packagePath = await exportPackage(page);
  const tabsBefore = await page.getByRole('tab').count();
  let requests = 0;
  page.on('request', (request) => {
    if (request.url().endsWith('/api/mapping/execute') && request.postDataJSON()?.type === 'project.import') requests++;
  });
  const { dialog } = await openPackage(page, packagePath);
  await dialog.getByLabel('新研究名称').fill('会话存储测试');
  await page.evaluate(() => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function(key, value) {
      if (this === sessionStorage) throw new DOMException('导入记录无法保存', 'QuotaExceededError');
      original.call(this, key, value);
    };
  });
  await dialog.getByRole('button', { name: '导入为新研究', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('本次请求未发送');
  expect(requests).toBe(0);
  expect(await projectsOf(page, workspace.origin)).toHaveLength(tabsBefore);

  await page.reload();
  const reopened = await openPackage(page, packagePath);
  await reopened.dialog.getByLabel('新研究名称').fill('会话存储测试');
  await page.evaluate(() => {
    const original = Storage.prototype.removeItem;
    Storage.prototype.removeItem = function(key) {
      if (this === sessionStorage) throw new DOMException('导入记录无法清除', 'SecurityError');
      original.call(this, key);
    };
  });
  await reopened.dialog.getByRole('button', { name: '导入为新研究', exact: true }).click();
  await expect(reopened.dialog.getByRole('status')).toContainText('项目已导入。浏览器未能清除导入重试记录', { timeout: 3000 });
  await expect(reopened.dialog.getByRole('heading', { name: '校验未通过' })).toHaveCount(0);
  await expect(reopened.dialog.getByRole('alert')).toHaveCount(0);
  await expect(page.getByRole('tab', { selected: true })).toContainText('会话存储测试');
  expect(requests).toBe(1);
  const firstProjects = await projectsOf(page, workspace.origin);
  expect(firstProjects.filter(project => project.name === '会话存储测试')).toHaveLength(1);
  expect(firstProjects).toHaveLength(tabsBefore + 1);

  // 刷新恢复正常存储；上次导入已确认，此次明确提交应再建一份同名研究。
  await page.reload();
  const next = await openPackage(page, packagePath);
  await next.dialog.getByLabel('新研究名称').fill('会话存储测试');
  await page.route('**/api/mapping/execute', async (route) => {
    if (route.request().postDataJSON()?.type !== 'project.import') return route.continue();
    const response = await route.fetch();
    expect(response.ok()).toBe(true);
    // 新请求已提交；在回执送达前禁用全部会话存储，仍须打开项目并说明恢复限制。
    await page.evaluate(() => {
      Object.defineProperty(window, 'sessionStorage', {
        get() { throw new DOMException('会话存储不可用', 'SecurityError'); },
      });
    });
    await route.fulfill({ response });
  });
  await next.dialog.getByRole('button', { name: '导入为新研究', exact: true }).click();
  const status = next.dialog.getByRole('status');
  await expect(status).toContainText('项目已导入。浏览器无法清除或更新重试记录');
  await expect(status).toContainText('关闭此标签页并从工作台入口重新打开');
  await expect(next.dialog.getByRole('heading', { name: '校验未通过' })).toHaveCount(0);
  await expect(next.dialog.getByRole('alert')).toHaveCount(0);
  expect(requests).toBe(2);
  const projects = await projectsOf(page, workspace.origin);
  expect(projects.filter((project) => project.name === '会话存储测试')).toHaveLength(2);
  expect(projects).toHaveLength(tabsBefore + 2);
  const secondCopy = projects.find((project) => !firstProjects.some((first) => first.id === project.id))!;
  await expect(page.getByRole('tab', { selected: true })).toHaveAttribute('title', secondCopy.id);
});

test('导入对话框打开期间撤销快捷键不改动源研究', async ({ page, workspace }) => {
  test.setTimeout(120000);
  await place(page, '撤销隔离卡');
  const packagePath = await exportPackage(page);
  const before = await workspace.state();
  expect(before.cards).toHaveLength(1);

  const { dialog } = await openPackage(page, packagePath);
  await dialog.getByRole('button', { name: '取消', exact: true }).focus();
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(400);
  const during = await workspace.state();
  expect(during.project.revision).toBe(before.project.revision);
  expect(during.cards).toHaveLength(before.cards.length);

  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  const after = await workspace.state();
  expect(after.project.revision).toBe(before.project.revision);
  expect(after.cards).toHaveLength(before.cards.length);
});

test('校验未完成时可以关闭预览，迟到的校验结果不会重新打开对话框', async ({ page, workspace }) => {
  test.setTimeout(120000);
  await place(page, '慢校验卡');
  const packagePath = await exportPackage(page);
  const tabsBefore = await page.getByRole('tab').count();

  let release: (() => void) | undefined;
  await page.route('**/api/mapping/import.preview', async (route) => {
    await new Promise<void>((resolve) => { release = resolve; });
    await route.continue();
  });
  const trigger = page.getByRole('button', { name: '导入项目包', exact: true });
  const chooserPromise = page.waitForEvent('filechooser');
  await trigger.click();
  await (await chooserPromise).setFiles(packagePath);
  const dialog = page.getByRole('dialog', { name: '导入项目包' });
  await expect(dialog.getByText('正在校验完整项目包…', { exact: false })).toBeVisible();
  await expect(dialog.getByRole('button', { name: '关闭', exact: true })).toBeEnabled();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();

  release?.();
  await page.waitForTimeout(600);
  await expect(dialog).toHaveCount(0);
  expect((await projectsOf(page, workspace.origin)).length).toBe(tabsBefore);
  await page.unroute('**/api/mapping/import.preview');
});

test('撤权后忽略导入完成后的旧项目列表，项目页签保持撤下', async ({ page, workspace }) => {
  await place(page, '隔离导入源卡', 380, 200);
  const packagePath = await exportPackage(page);
  const { dialog } = await openPackage(page, packagePath);
  await dialog.getByLabel('新研究名称').fill('已导入的隔离副本');
  const endpoint = workspace.origin + '/api/mapping/projects';
  let release!: () => void;
  let readAtServer!: (status: number) => void;
  const hold = new Promise<void>(resolve => { release = resolve; });
  const secondList = new Promise<number>(resolve => { readAtServer = resolve; });
  let listCount = 0;
  await page.route(endpoint, async route => {
    if (++listCount !== 2) return route.continue();
    const result = await route.fetch();
    readAtServer(result.status());
    await hold;
    return route.fulfill({ response: result });
  });
  try {
    await dialog.getByRole('button', { name: '导入为新研究', exact: true }).click();
    await expect(page.getByRole('tab', { selected: true })).toContainText('已导入的隔离副本');
    expect(await secondList).toBe(200);
    await page.evaluate(endpoint => {
      const json = Response.prototype.json;
      Response.prototype.json = async function () {
        const value = await json.call(this);
        if (this.ok && this.url === endpoint) requestAnimationFrame(() => requestAnimationFrame(() => {
          document.documentElement.dataset.lateImportListRead = 'received';
        }));
        return value;
      };
    }, endpoint);
    workspace.revoke();
    await expect(page.getByText('授权已失效，请从本机启动入口重新打开；未确认草稿已保留')).toBeVisible();
    await expect(page.getByRole('tab')).toHaveCount(0);
  } finally { release(); }
  await expect(page.locator('html')).toHaveAttribute('data-late-import-list-read', 'received');
  await expect(page.getByRole('tab')).toHaveCount(0);
  await page.getByRole('button', { name: '项目导航', exact: true }).click();
  await expect(page.locator('.project-nav-list button')).toHaveCount(0);
});
