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

  const third = await openPackage(page, packagePath!);
  await third.dialog.getByLabel('新研究名称').fill('导入副本·中文');
  await third.dialog.getByRole('button', { name: '导入为新研究', exact: true }).click();
  await expect(page.getByRole('tab', { selected: true })).toContainText('导入副本·中文');
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
    files.set('forkwise-project.json', Buffer.from(JSON.stringify(brokenManifest)));
    const brokenPath = join(isolated, 'broken.zip');
    writeFileSync(brokenPath, writeZip([...files].map(([name, data]) => ({ name, data }))));
    const broken = await openPackage(page, brokenPath);
    await expect(broken.dialog.getByText('RESOURCE_HASH', { exact: false })).toBeVisible();
    await expect(broken.dialog.getByRole('button', { name: '导入为新研究', exact: true })).toBeDisabled();
    await broken.dialog.getByRole('button', { name: '取消', exact: true }).click();
    expect((await projectsOf(page, workspace.origin)).length).toBe(tabsBefore + 1);
  } finally {
    rmSync(isolated, { recursive: true, force: true });
  }

  expect(sourceById.size).toBeGreaterThan(0);
  expect(sourceById.has(imported.cards[0]!.id)).toBe(false);
});


test('响应丢失后用原 commandId 重试只建一个项目', async ({ page, workspace }) => {
  test.setTimeout(120000);
  await place(page, '重试卡');
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出', exact: true }).click();
  await page.getByRole('menuitem', { name: '下载完整项目包（ZIP）', exact: true }).click();
  const download = await downloadPromise;
  const packagePath = await download.path();
  expect(packagePath).not.toBeNull();
  const tabsBefore = await page.getByRole('tab').count();
  let dropped = false;
  await page.route('**/api/mapping/execute', async (route) => {
    const body = route.request().postDataJSON() as { type?: string } | null;
    if (!dropped && body?.type === 'project.import') {
      dropped = true;
      await route.fetch();
      await route.abort('failed');
      return;
    }
    await route.continue();
  });
  const { dialog } = await openPackage(page, packagePath!);
  await dialog.getByLabel('新研究名称').fill('重试导入');
  await dialog.getByRole('button', { name: '导入为新研究', exact: true }).click();
  await expect(dialog.getByText('响应未收到', { exact: false })).toBeVisible();
  // 服务端已提交、客户端没收到响应；此时项目已经存在，重试只能复用原回执。
  expect((await projectsOf(page, workspace.origin)).length).toBe(tabsBefore + 1);
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  const reopened = await openPackage(page, packagePath!);
  await reopened.dialog.getByLabel('新研究名称').fill('重试导入');
  await reopened.dialog.getByRole('button', { name: '导入为新研究', exact: true }).click();
  await expect(page.getByRole('tab', { selected: true })).toContainText('重试导入');
  await expect(page.getByRole('tab')).toHaveCount(tabsBefore + 1);
  const projects = await projectsOf(page, workspace.origin);
  expect(projects.filter((project) => project.name === '重试导入')).toHaveLength(1);
  await page.unroute('**/api/mapping/execute');
});

test('响应丢失后改名重试时 ID_CONFLICT 直接打开已导入项目', async ({ page, workspace }) => {
  test.setTimeout(120000);
  await place(page, '改名重试卡');
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出', exact: true }).click();
  await page.getByRole('menuitem', { name: '下载完整项目包（ZIP）', exact: true }).click();
  const download = await downloadPromise;
  const packagePath = await download.path();
  expect(packagePath).not.toBeNull();
  const tabsBefore = await page.getByRole('tab').count();
  let dropped = false;
  await page.route('**/api/mapping/execute', async (route) => {
    const body = route.request().postDataJSON() as { type?: string } | null;
    if (!dropped && body?.type === 'project.import') {
      dropped = true;
      await route.fetch();
      await route.abort('failed');
      return;
    }
    await route.continue();
  });
  const { dialog } = await openPackage(page, packagePath!);
  await dialog.getByLabel('新研究名称').fill('改名导入');
  await dialog.getByRole('button', { name: '导入为新研究', exact: true }).click();
  await expect(dialog.getByText('响应未收到', { exact: false })).toBeVisible();
  await dialog.getByLabel('新研究名称').fill('另一个名字');
  await dialog.getByRole('button', { name: '导入为新研究', exact: true }).click();
  await expect(page.getByRole('tab', { selected: true })).toContainText('改名导入');
  await expect(page.getByRole('tab')).toHaveCount(tabsBefore + 1);
  const projects = await projectsOf(page, workspace.origin);
  expect(projects.filter((project) => project.name === '另一个名字')).toHaveLength(0);
  await page.unroute('**/api/mapping/execute');
});
