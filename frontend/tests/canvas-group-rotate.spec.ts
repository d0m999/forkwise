import { test, expect, type Workspace } from './writing-board-fixture';
import type { Page } from '@playwright/test';
import type { Command } from '../src/api';

async function images(page: Page, workspace: Workspace, looseCard = false) {
  const projectId = (await workspace.state()).project.id;
  const execute = (type: string, payload: unknown, expected: unknown = null) => workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type, expected, payload });
  await execute('asset.save', { id: 'asset', name: '组合图.svg', mime: 'image/svg+xml',
    base64: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="160" height="120"><rect width="160" height="120" fill="#43a89a"/></svg>').toString('base64') });
  await execute('image.create', { id: 'first', content: { assetId: 'asset', crop: { x: 0.1, y: 0.2, width: 0.5, height: 0.6 } },
    pose: { x: 100, y: 120, width: 80, height: 40, rotation: 90 } });
  await execute('image.create', { id: 'second', content: { assetId: 'asset', crop: { x: 0, y: 0, width: 1, height: 1 } },
    pose: { x: 300, y: 200, width: 40, height: 100, rotation: 270 } });
  await execute('shape.create', { id: 'loose', content: { shapeType: 'ellipse', shortText: '后选形状' }, pose: { x: 650, y: 350, width: 100, height: 60 } });
  if (looseCard) await execute('thought.create', { id: 'loose-card', title: '后选卡片', text: '', x: 650, y: 500 });
  const raw = await workspace.state(), ids = raw.images!.map(v => v.item.id);
  await execute('group.create', { id: 'images', itemIds: ids }, { groups: { images: null }, containment: Object.fromEntries(ids.map(id => [id, null])) });
  const layout = looseCard ? page.waitForResponse(r => r.url().endsWith('/api/mapping/execute') && r.request().postDataJSON()?.type === 'card.layout') : null;
  await page.reload(); if (layout) expect((await layout).status()).toBe(200);
  await expect(page.getByRole('status')).toHaveText('已保存到本机');
  await page.getByRole('img', { name: '组合图.svg', exact: true }).first().click();
  await expect(page.locator('.canvas-group-outline[data-selected="true"]')).toHaveCount(1);
  return await workspace.state();
}

test('纯图片组合左右90共同中心轨道及自身角度，保crop且一次undo redo重开', async ({ page, workspace }) => {
  const before = await images(page, workspace), commands: Command[] = [];
  page.on('request', r => { if (r.url().endsWith('/api/mapping/execute') && r.method() === 'POST') commands.push(r.postDataJSON()); });
  await page.getByRole('button', { name: '组合右转90°', exact: true }).click();
  await expect.poll(async () => (await workspace.state()).images!.map(v => v.item.pose)).toEqual([
    { x: 270, y: 90, width: 40, height: 80, rotation: 180 }, { x: 130, y: 290, width: 100, height: 40, rotation: 0 },
  ]);
  await expect(page.getByRole('status')).toHaveText('已保存到本机');
  const rotated = await workspace.state();
  for (const value of rotated.images!) {
    expect(value.content).toEqual(before.images!.find(v => v.id === value.id)!.content);
    expect(value.versionId).toBe(before.images!.find(v => v.id === value.id)!.versionId);
    const response = await page.request.get(workspace.origin + `/api/mapping/projects/${before.project.id}/versions/pose/${value.item.id}/${value.item.versionId}`);
    expect(await response.json()).toEqual(value.item);
  }
  expect(commands.map(c => c.type)).toEqual(['group.rotate90']);
  expect(rotated.project.revision).toBe(before.project.revision + 1);
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect.poll(async () => (await workspace.state()).images!.map(v => v.item.pose)).toEqual(before.images!.map(v => v.item.pose));
  await page.getByRole('button', { name: '重做', exact: true }).click();
  await expect.poll(async () => (await workspace.state()).images!.map(v => v.item.pose)).toEqual(rotated.images!.map(v => v.item.pose));
  await page.getByRole('button', { name: '组合左转90°', exact: true }).click();
  await expect.poll(async () => (await workspace.state()).images!.map(v => v.item.pose)).toEqual(before.images!.map(v => v.item.pose));
  const after = await workspace.state(); await page.reload(); await expect(page.getByRole('status')).toHaveText('已保存到本机');
  expect(await workspace.state()).toEqual(after);
});

test('Image原旋转unknown时纯图片Group几何互斥，原请求重试后四角与旋转恢复', async ({ page, workspace }) => {
  await images(page, workspace);
  const pictures = page.getByRole('img', { name: '组合图.svg', exact: true });
  await pictures.first().click(); await expect(page.locator('.react-flow__node.selected')).toHaveCount(1);
  const before = await workspace.state(), attempts: Command[] = [], geometries: Command[] = [];
  await page.route('**/api/mapping/execute', async route => {
    const command = route.request().postDataJSON() as Command;
    if (command.type === 'image.rotate') {
      attempts.push(command); const response = await route.fetch(); expect(response.status()).toBe(200);
      if (attempts.length === 1) await route.abort('connectionreset'); else await route.fulfill({ response });
    } else { if (command.type === 'group.scale' || command.type === 'group.rotate90') geometries.push(command); await route.continue(); }
  });
  try {
    await page.getByRole('button', { name: '向右旋转90°', exact: true }).click();
    const retry = page.getByRole('button', { name: '重试图片调整', exact: true }); await expect(retry).toBeVisible();
    const committed = await workspace.state(); expect(committed.project.revision).toBe(before.project.revision + 1);
    await page.getByRole('img', { name: '后选形状', exact: true }).focus(); await page.keyboard.press('Escape');
    await expect(page.locator('.react-flow__node.selected')).toHaveCount(0);
    const pictureBox = (await pictures.last().boundingBox())!;
    await page.mouse.click(pictureBox.x + pictureBox.width / 2, pictureBox.y + pictureBox.height / 2);
    await expect(page.locator('.canvas-group-outline[data-selected="true"]')).toHaveCount(1);
    await expect(page.locator('.react-flow__node.selected')).toHaveCount(2);
    const handles = page.getByRole('button', { name: /^调整组合尺寸：/ }); await expect(handles).toHaveCount(4);
    const rotations = page.getByRole('button', { name: /^组合[左右]转90°$/ }); await expect(rotations).toHaveCount(2);
    const right = page.getByRole('button', { name: '组合右转90°', exact: true }), rotateBox = (await right.boundingBox())!;
    await page.mouse.click(rotateBox.x + rotateBox.width / 2, rotateBox.y + rotateBox.height / 2);
    await page.waitForTimeout(350); expect(geometries).toEqual([]);
    for (const control of [...await handles.all(), ...await rotations.all()]) await expect(control).toBeDisabled();
    expect(await workspace.state()).toEqual(committed); expect(attempts).toHaveLength(1);
    await retry.click(); await expect(retry).toHaveCount(0);
    expect(attempts).toHaveLength(2); expect(attempts[1]).toEqual(attempts[0]); expect(await workspace.state()).toEqual(committed);
    for (const control of [...await handles.all(), ...await rotations.all()]) await expect(control).toBeEnabled();
    await right.click(); await expect.poll(() => geometries.length).toBe(1);
    await expect(page.getByRole('status')).toHaveText('已保存到本机');
    const after = await workspace.state(); expect(after.project.revision).toBe(committed.project.revision + 1);
    expect(geometries[0]!.type).toBe('group.rotate90');
    for (const value of after.images!) {
      const old = committed.images!.find(v => v.id === value.id)!;
      expect(value.content).toEqual(old.content); expect(value.item.pose.width).toBe(old.item.pose.height);
    }
  } finally { await page.unrouteAll({ behavior: 'wait' }); }
});

for (const mode of ['unknown', 'confirmed-read-failure', 'rejected', 'late-selection'] as const)
  test(`组合几何${mode}复用原请求结果分类且不抢后选对象`, async ({ page, workspace }) => {
    const before = await images(page, workspace, mode === 'late-selection'), projectId = before.project.id, attempts: Command[] = [];
    let applied = false, failRead = mode === 'confirmed-read-failure';
    await page.route('**/api/mapping/execute', async route => {
      const command = route.request().postDataJSON();
      if (command.type !== 'group.rotate90') { await route.continue(); return; }
      if (mode === 'rejected' && attempts.length === 0) {
        const image = before.images![0]!;
        await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'image.rotate',
          expected: { image: image.versionId, pose: image.item.versionId }, payload: { id: image.id, direction: 'left' } });
      }
      attempts.push(command); const response = await route.fetch(); applied = true;
      if ((mode === 'unknown' || mode === 'late-selection') && attempts.length === 1) await route.abort('connectionreset');
      else await route.fulfill({ response });
    });
    await page.route('**/api/mapping/projects/' + projectId + '/map?**', async route => {
      if (applied && failRead && new URL(route.request().url()).searchParams.get('view') === 'index') {
        failRead = false; await route.abort('connectionreset');
      } else await route.continue();
    });
    try {
      await page.getByRole('button', { name: '组合右转90°', exact: true }).click();
      const retry = page.getByRole('button', { name: '重试保存', exact: true }); await expect(retry).toBeVisible();
      expect(attempts).toHaveLength(1);
      const committed = await workspace.state(); expect(committed.project.revision).toBe(before.project.revision + 1);
      if (mode === 'late-selection') {
        const title = page.getByRole('button', { name: '后选卡片', exact: true }); await expect(title).toBeEnabled();
        const box = (await title.boundingBox())!;
        expect(await page.evaluate(p => document.elementFromPoint(p.x, p.y)?.closest<HTMLElement>('.react-flow__node')?.dataset.id,
          { x: box.x + box.width / 2, y: box.y + box.height / 2 })).toBe(before.cards[0]!.item.id);
        await title.click();
        await expect(page.locator('.react-flow__node.selected')).toHaveCount(1);
        await expect(page.locator(`.react-flow__node[data-id="${before.cards[0]!.item.id}"]`)).toHaveClass(/selected/);
      }
      await retry.click();
      if (mode === 'rejected') {
        await page.getByRole('button', { name: '放弃本次组合操作', exact: true }).click();
        expect(attempts).toHaveLength(1);
      } else {
        expect(attempts).toHaveLength(mode === 'confirmed-read-failure' ? 1 : 2);
        if (attempts.length === 2) expect(attempts[1]).toEqual(attempts[0]);
      }
      await expect(retry).toHaveCount(0); expect(await workspace.state()).toEqual(committed);
      if (mode === 'late-selection') {
        await expect(page.locator(`.react-flow__node[data-id="${before.cards[0]!.item.id}"]`)).toHaveClass(/selected/);
        await expect(page.locator('.react-flow__node.selected')).toHaveCount(1);
      }
    } finally { await page.unrouteAll({ behavior: 'wait' }); }
  });
