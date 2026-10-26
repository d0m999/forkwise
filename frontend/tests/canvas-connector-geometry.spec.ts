import { test, expect } from './writing-board-fixture';
import type { Command } from '../../backend/src/mapping/contracts';
import { connectorSurfaceBox, connectorSvgEnds, seedConnectorCard } from './connector-ui-fixture';

test('卡片移动预览时连线沿原固定边同步跟随', async ({ page, workspace }) => {
  const a = await seedConnectorCard(page, workspace, 'moving-a', 130, 150), b = await seedConnectorCard(page, workspace, 'moving-b', 700, 400);
  const projectId = (await workspace.state()).project.id;
  await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'connector.create', expected: null,
    payload: { id: 'following-line', path: 'straight', start: { kind: 'bound', itemId: a.item.id, side: 'right' }, end: { kind: 'bound', itemId: b.item.id, side: 'left' } } });
  await page.reload(); await expect(page.getByRole('status')).toHaveText('已保存到本机');
  const before = await workspace.state(), commands: Command[] = [], line = page.getByRole('button', { name: '普通连线', exact: true });
  const original = await connectorSvgEnds(line.locator('path')), box = await connectorSurfaceBox(page, a.item.id);
  const record = (request: import('@playwright/test').Request) => {
    if (request.url().endsWith('/api/mapping/execute')) commands.push(request.postDataJSON());
  };
  page.on('request', record);
  try {
    await page.keyboard.down('Alt'); await page.mouse.move(box.x + 80, box.y + box.height - 12); await page.mouse.down();
    await page.mouse.move(box.x + 560, box.y + box.height + 168, { steps: 8 });
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    const moved = await connectorSurfaceBox(page, a.item.id), preview = await connectorSvgEnds(line.locator('path'));
    expect(moved.x).toBeGreaterThan(box.x + 100); expect(moved.y).toBeGreaterThan(box.y + 50);
    expect(preview.start.x, '移动中的右边入口必须随实际卡片预览跟随，不能等保存确认').toBeCloseTo(moved.x + moved.width, 0);
    expect(preview.start.y).toBeCloseTo(moved.y + moved.height / 2, 0); expect(preview.end).toEqual(original.end);
    expect(commands).toHaveLength(0); expect(await workspace.state()).toEqual(before);
    const saved = page.waitForResponse(response => response.url().endsWith('/api/mapping/execute') && response.request().postDataJSON()?.type === 'pose.move');
    await page.mouse.up(); await page.keyboard.up('Alt'); expect((await saved).status()).toBe(200);
    await expect(page.getByRole('status')).toHaveText('已保存到本机');
    const after = await workspace.state(); expect(after.connectors).toEqual(before.connectors); expect(after.cards[1]).toEqual(before.cards[1]);
    expect(await connectorSvgEnds(line.locator('path'))).toEqual(preview);
    await page.locator('.react-flow__controls-zoomin').click();
    await page.getByRole('button', { name: '移动', exact: true }).click();
    await page.mouse.move(1180, 650); await page.mouse.down(); await page.mouse.move(1110, 610, { steps: 5 }); await page.mouse.up();
    const transformed = await line.locator('path').evaluate((element, itemId) => {
      const node = [...document.querySelectorAll<HTMLElement>('.react-flow__node[data-id]')].find(value => value.dataset.id === itemId)!;
      const box = node.querySelector('article.thought-card')!.getBoundingClientRect(), path = element as SVGPathElement;
      const point = path.getPointAtLength(0), actual = new DOMPoint(point.x, point.y).matrixTransform(path.getScreenCTM()!);
      return { surface: { x: box.x, y: box.y, width: box.width, height: box.height }, start: { x: actual.x, y: actual.y } };
    }, a.item.id);
    expect(transformed.start.x).toBeCloseTo(transformed.surface.x + transformed.surface.width, 0); expect(transformed.start.y).toBeCloseTo(transformed.surface.y + transformed.surface.height / 2, 0);
    expect(await workspace.state()).toEqual(after); expect(commands).toHaveLength(1);
    console.log('issue26-card-follow', JSON.stringify({ original, box, moved, preview, transformed, commands, connector: after.connectors![0] }));
  } finally { page.off('request', record); await page.keyboard.up('Alt'); await page.mouse.up(); }
});

test('卡片自动增高后连线仍保持原固定边', async ({ page, workspace }) => {
  const a = await seedConnectorCard(page, workspace, 'growing-a', 130, 150), b = await seedConnectorCard(page, workspace, 'growing-b', 700, 400);
  const projectId = (await workspace.state()).project.id;
  await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'connector.create', expected: null,
    payload: { id: 'growing-line', path: 'straight', start: { kind: 'bound', itemId: a.item.id, side: 'right' }, end: { kind: 'bound', itemId: b.item.id, side: 'left' } } });
  await page.reload(); await expect(page.getByRole('status')).toHaveText('已保存到本机');
  const before = await workspace.state(), box = await connectorSurfaceBox(page, a.item.id), line = page.getByRole('button', { name: '普通连线', exact: true });
  const initial = await connectorSvgEnds(line.locator('path')), commands: Command[] = [];
  const record = (request: import('@playwright/test').Request) => { if (request.url().endsWith('/api/mapping/execute')) commands.push(request.postDataJSON()); };
  page.on('request', record);
  try {
    await page.locator('.title-button').first().dblclick();
    const title = page.getByLabel('卡片标题', { exact: true }), text = '第一行\n第二行\n第三行\n第四行\n第五行\n第六行\n第七行\n第八行';
    await title.fill(text); await title.press('Enter');
    await expect.poll(async () => (await workspace.state()).cards.find(card => card.id === a.id)!.item.pose.height).toBeGreaterThan(box.height + 40);
    const after = await workspace.state(); await expect(page.locator('.workspace')).toHaveAttribute('data-revision', String(after.project.revision));
    const grown = await connectorSurfaceBox(page, a.item.id), ends = await connectorSvgEnds(line.locator('path'));
    expect(grown.height).toBeGreaterThan(box.height + 40);
    expect(ends.start.x).toBeCloseTo(grown.x + grown.width, 0); expect(ends.start.y).toBeCloseTo(grown.y + grown.height / 2, 0);
    expect(ends.end).toEqual(initial.end); expect(ends.start.y).not.toBe(initial.start.y);
    expect(after.connectors).toEqual(before.connectors); expect(after.cards[1]).toEqual(before.cards[1]);
    expect(after.cards[0]!.body).toEqual(before.cards[0]!.body);
    expect(after.cards[0]!.item.pose).toMatchObject({ x: a.item.pose.x, y: a.item.pose.y, width: a.item.pose.width });
    expect(commands.filter(command => command.type.startsWith('connector.'))).toHaveLength(0);
    console.log('issue26-card-grow', JSON.stringify({ box, grown, initial, ends, commands, connector: after.connectors![0] }));
  } finally { page.off('request', record); }
});

test('形状调框预览时连线跟随实际表面固定边', async ({ page, workspace }) => {
  const card = await seedConnectorCard(page, workspace, 'shape-protected-card', 700, 400), projectId = (await workspace.state()).project.id;
  await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'shape.create', expected: null,
    payload: { id: 'following-shape', content: { shapeType: 'rectangle', shortText: '随动形状' }, pose: { x: 250, y: 190, width: 240, height: 130 } } });
  const shape = (await workspace.state()).shapes![0]!;
  await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'connector.create', expected: null,
    payload: { id: 'shape-following-line', path: 'straight', start: { kind: 'bound', itemId: shape.item.id, side: 'left' }, end: { kind: 'bound', itemId: card.item.id, side: 'left' } } });
  await page.reload(); await expect(page.getByRole('status')).toHaveText('已保存到本机');
  const before = await workspace.state(), box = await connectorSurfaceBox(page, shape.item.id, 'div[role=img]'), line = page.getByRole('button', { name: '普通连线', exact: true });
  const initial = await connectorSvgEnds(line.locator('path')), commands: Command[] = [];
  const record = (request: import('@playwright/test').Request) => { if (request.url().endsWith('/api/mapping/execute')) commands.push(request.postDataJSON()); };
  page.on('request', record);
  try {
    await page.getByRole('img', { name: '随动形状', exact: true }).click();
    const handle = page.getByRole('button', { name: '调整形状尺寸：左上', exact: true }); expect(await handle.count()).toBe(1);
    const anchor = (await handle.boundingBox())!; await handle.hover(); await page.mouse.down();
    await page.mouse.move(anchor.x + anchor.width / 2 - 80, anchor.y + anchor.height / 2 - 40, { steps: 5 });
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    const resized = await connectorSurfaceBox(page, shape.item.id, 'div[role=img]'), preview = await connectorSvgEnds(line.locator('path'));
    expect(resized.width).toBeGreaterThan(box.width + 50); expect(resized.x).toBeLessThan(box.x - 50);
    expect(preview.start.x).toBeCloseTo(resized.x, 0); expect(preview.start.y).toBeCloseTo(resized.y + resized.height / 2, 0); expect(preview.end).toEqual(initial.end);
    expect(commands).toHaveLength(0); expect(await workspace.state()).toEqual(before);
    const saved = page.waitForResponse(response => response.url().endsWith('/api/mapping/execute') && response.request().postDataJSON()?.type === 'shape.transform');
    await page.mouse.up(); expect((await saved).status()).toBe(200); await expect(page.getByRole('status')).toHaveText('已保存到本机');
    const after = await workspace.state(); expect(after.connectors).toEqual(before.connectors); expect(after.cards).toEqual(before.cards);
    expect(after.shapes![0]).toMatchObject({ id: shape.id, versionId: shape.versionId, content: shape.content, item: { id: shape.item.id } });
    expect(commands).toHaveLength(1); expect(await connectorSvgEnds(line.locator('path'))).toEqual(preview);
    console.log('issue26-shape-follow', JSON.stringify({ box, resized, initial, preview, commands, connector: after.connectors![0] }));
  } finally { page.off('request', record); await page.mouse.up(); }
});

test('独立文字缩放预览时连线跟随内部实际表面', async ({ page, workspace }) => {
  const card = await seedConnectorCard(page, workspace, 'text-protected-card', 700, 400), projectId = (await workspace.state()).project.id;
  await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'text.create', expected: null,
    payload: { id: 'following-text', content: { runs: [{ text: '独立文字\n内部缩放' }], fontSize: 18, lineHeight: 1.5, align: 'left', widthMode: 'fixed', width: 240 }, pose: { x: 250, y: 190, width: 240, height: 54 } } });
  const text = (await workspace.state()).texts![0]!;
  await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'connector.create', expected: null,
    payload: { id: 'text-following-line', path: 'straight', start: { kind: 'bound', itemId: text.item.id, side: 'left' }, end: { kind: 'bound', itemId: card.item.id, side: 'left' } } });
  await page.reload(); await expect(page.getByRole('status')).toHaveText('已保存到本机');
  const before = await workspace.state(), box = await connectorSurfaceBox(page, text.item.id, 'article.canvas-text'), line = page.getByRole('button', { name: '普通连线', exact: true });
  const initial = await connectorSvgEnds(line.locator('path')), commands: Command[] = [];
  const wrapperOrigin = () => page.locator('.react-flow__node[data-id]').evaluateAll((nodes, id) => {
    const box = nodes.find(value => (value as HTMLElement).dataset.id === id)!.getBoundingClientRect(); return { x: box.x, y: box.y };
  }, text.item.id);
  const wrapper = await wrapperOrigin(), record = (request: import('@playwright/test').Request) => { if (request.url().endsWith('/api/mapping/execute')) commands.push(request.postDataJSON()); };
  page.on('request', record);
  try {
    await page.locator('.canvas-text-content').click();
    const handle = page.getByRole('button', { name: '调整文字尺寸：左上', exact: true }); expect(await handle.count()).toBe(1);
    const anchor = (await handle.boundingBox())!; await handle.hover(); await page.mouse.down();
    await page.mouse.move(anchor.x + anchor.width / 2 - 120, anchor.y + anchor.height / 2 - 27, { steps: 5 });
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    const resized = await connectorSurfaceBox(page, text.item.id, 'article.canvas-text'), preview = await connectorSvgEnds(line.locator('path')), heldWrapper = await wrapperOrigin();
    expect(resized.width).toBeGreaterThan(box.width + 50); expect(resized.x).toBeLessThan(box.x - 50);
    expect(heldWrapper.x).toBeCloseTo(wrapper.x, 0); expect(resized.x).toBeLessThan(heldWrapper.x - 50);
    expect(preview.start.x).toBeCloseTo(resized.x, 0); expect(preview.start.y).toBeCloseTo(resized.y + resized.height / 2, 0); expect(preview.end).toEqual(initial.end);
    expect(commands).toHaveLength(0); expect(await workspace.state()).toEqual(before);
    const saved = page.waitForResponse(response => response.url().endsWith('/api/mapping/execute') && response.request().postDataJSON()?.type === 'text.transform');
    await page.mouse.up(); expect((await saved).status()).toBe(200); await expect(page.getByRole('status')).toHaveText('已保存到本机');
    const after = await workspace.state(); expect(after.connectors).toEqual(before.connectors); expect(after.cards).toEqual(before.cards);
    expect(after.texts![0]!.content.runs).toEqual(text.content.runs); expect(after.texts![0]!.id).toBe(text.id); expect(after.texts![0]!.item.id).toBe(text.item.id);
    expect(commands).toHaveLength(1); expect(await connectorSvgEnds(line.locator('path'))).toEqual(preview);
    console.log('issue26-text-follow', JSON.stringify({ box, resized, wrapper, heldWrapper, initial, preview, commands, connector: after.connectors![0] }));
  } finally { page.off('request', record); await page.mouse.up(); }
});

test('图片旋转后连线使用当前外框而不重复旋转端点', async ({ page, workspace }) => {
  const card = await seedConnectorCard(page, workspace, 'image-protected-card', 700, 400), projectId = (await workspace.state()).project.id;
  const source = '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="180"><rect width="300" height="180" fill="blue"/></svg>';
  await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'asset.save', expected: null,
    payload: { id: 'following-asset', name: '旋转绑定.svg', mime: 'image/svg+xml', base64: Buffer.from(source).toString('base64') } });
  await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'image.create', expected: null,
    payload: { id: 'following-image', content: { assetId: 'following-asset', crop: { x: 0.1, y: 0.2, width: 0.7, height: 0.6 } }, pose: { x: 250, y: 190, width: 300, height: 180, rotation: 0 } } });
  const image = (await workspace.state()).images![0]!;
  await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'connector.create', expected: null,
    payload: { id: 'image-following-line', path: 'straight', start: { kind: 'bound', itemId: image.item.id, side: 'top' }, end: { kind: 'bound', itemId: card.item.id, side: 'left' } } });
  await page.reload(); await expect(page.getByRole('status')).toHaveText('已保存到本机');
  const before = await workspace.state(), box = await connectorSurfaceBox(page, image.item.id, '.canvas-image-object'), line = page.getByRole('button', { name: '普通连线', exact: true });
  const initial = await connectorSvgEnds(line.locator('path')), commands: Command[] = [];
  const record = (request: import('@playwright/test').Request) => { if (request.url().endsWith('/api/mapping/execute')) commands.push(request.postDataJSON()); };
  page.on('request', record);
  try {
    await page.getByRole('img', { name: '旋转绑定.svg', exact: true }).click();
    const rotate = page.getByRole('button', { name: '向右旋转90°', exact: true }); expect(await rotate.count()).toBe(1);
    const saved = page.waitForResponse(response => response.url().endsWith('/api/mapping/execute') && response.request().postDataJSON()?.type === 'image.rotate');
    await rotate.click(); expect((await saved).status()).toBe(200); await expect(page.getByRole('status')).toHaveText('已保存到本机');
    const after = await workspace.state(); await expect(page.locator('.workspace')).toHaveAttribute('data-revision', String(after.project.revision));
    const turned = await connectorSurfaceBox(page, image.item.id, '.canvas-image-object'), ends = await connectorSvgEnds(line.locator('path'));
    expect(turned.width).toBeCloseTo(box.height, 0); expect(turned.height).toBeCloseTo(box.width, 0);
    expect(ends.start.x).toBeCloseTo(turned.x + turned.width / 2, 0); expect(ends.start.y).toBeCloseTo(turned.y, 0);
    expect(ends.end).toEqual(initial.end); expect(ends.start.y).not.toBe(initial.start.y);
    expect(after.connectors).toEqual(before.connectors); expect(after.cards).toEqual(before.cards); expect(after.images![0]!.content).toEqual(image.content);
    expect(after.images![0]!.item.pose.rotation).toBe(90); expect(commands).toHaveLength(1); expect(commands[0]!.type).toBe('image.rotate');
    console.log('issue26-image-follow', JSON.stringify({ box, turned, initial, ends, commands, connector: after.connectors![0] }));
  } finally { page.off('request', record); }
});
