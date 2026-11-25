import { test, expect, place } from './writing-board-fixture';
import type { Page } from '@playwright/test';
import type { Command, Receipt } from '../../backend/src/mapping/contracts';
import { createFrameCommand } from '../src/canvas-frame-commands';

function holdFirstBody(page: Page, cardId: string, afterCommit = false) {
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  let started = false;
  let receipt: Receipt | undefined;
  const installed = page.route('**/api/mapping/execute', async route => {
    const command = route.request().postDataJSON() as Command;
    if (command.type !== 'body.edit' || command.payload.id !== cardId || started) return route.continue();
    started = true;
    if (!afterCommit) await pending;
    const response = await route.fetch();
    receipt = await response.json();
    if (afterCommit) await pending;
    await route.fulfill({ response });
  });
  return { installed, release, started: () => started, receipt: () => receipt };
}

for (const kind of ['shape', 'image', 'stroke'] as const) {
  test(`首写随动期间直接删除附着${kind}只采用本次正文回执中的布局版本`, async ({ page, workspace }) => {
    await place(page, '短标题', 40, 95);
    const original = await workspace.state(), projectId = original.project.id, card = original.cards[0]!;
    const write = (type: string, payload: unknown, expected: unknown = null) =>
      workspace.execute(page, { commandId: crypto.randomUUID(), type, projectId, expected, payload });
    const pose = { x: 380, y: 270, width: 160, height: 64 };
    if (kind === 'shape') await write('shape.create', { id: 'annotation', content: { shapeType: 'rectangle', shortText: '附着形状' }, pose });
    if (kind === 'image') {
      const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="64"><rect width="160" height="64"/></svg>';
      await write('asset.save', { id: 'annotation-image', name: '附着图片.svg', mime: 'image/svg+xml', base64: Buffer.from(svg).toString('base64') });
      await write('image.create', { id: 'annotation', content: { assetId: 'annotation-image', crop: { x: 0, y: 0, width: 1, height: 1 } }, pose: { ...pose, rotation: 0 } });
    }
    if (kind === 'stroke') await write('stroke.create', { id: 'annotation', content: { penKind: 'pen',
      path: [{ x: 0, y: 1 }, { x: 150, y: 1 }], color: '#252430', width: 2, opacity: 1 }, pose });
    const key = { shape: 'shapes', image: 'images', stroke: 'strokes' }[kind] as 'shapes' | 'images' | 'strokes';
    const value = (await workspace.state())[key]![0]!;
    await write('attachment.attach', { itemId: value.item.id, targetItemId: card.item.id }, {
      attachment: null, target: { itemId: card.item.id, versionId: card.item.versionId }, containment: null,
    });
    if (kind !== 'stroke') await write('connector.create', { id: 'incident', path: 'straight',
      start: { kind: 'bound', itemId: value.item.id, side: 'right' }, end: { kind: 'bound', itemId: card.item.id, side: 'left' } });
    await page.reload();
    await page.locator('.thought-card').getByRole('button', { name: '编辑正文', exact: true }).click();
    if (kind === 'stroke') await page.getByRole('button', { name: '选择普通笔笔迹', exact: true }).press('Enter');
    else await page.getByRole('img', { name: kind === 'shape' ? '附着形状' : '附着图片.svg', exact: true }).click();
    const label = { shape: '删除形状', image: '删除图片', stroke: '删除笔迹' }[kind];
    const remove = page.getByRole('button', { name: label, exact: true });
    await expect(remove).toBeVisible();
    const before = await workspace.state(), gate = holdFirstBody(page, card.id);
    await gate.installed;
    try {
      await page.getByRole('textbox', { name: '卡片正文', exact: true }).fill('第一段正文');
      await expect.poll(gate.started).toBe(true);
      const response = page.waitForResponse(r => r.url().endsWith('/api/mapping/execute') && r.request().postDataJSON()?.type === kind + '.delete');
      await remove.click();
      expect((await workspace.state())[key]).toEqual(before[key]);
      gate.release();
      const saved = await response;
      expect(saved.status()).toBe(200);
      const deletion = saved.request().postDataJSON();
      const derived = gate.receipt()!.derivedPoseVersions![value.item.id]!;
      expect(derived.before).toBe(value.item.versionId);
      expect(deletion.expected.pose).toBe(derived.after);
      if (kind !== 'stroke') expect(deletion.expected.connectors).toEqual({ incident: before.connectors![0]!.versionId });
      const after = await workspace.state();
      expect(after[key]).toEqual([]);
      expect(after.connectors).toEqual([]);
      expect(after.cards[0]!.item.pose.height).toBe(160);
      expect(after.cards[0]!.body.blocks[0]!.text).toBe('第一段正文');
    } finally { gate.release(); await page.unrouteAll({ behavior: 'wait' }); }
  });
}

test('首写等待回执时向下拉伸卡片，以派生高度为基准且批注只按两次中心变化移动', async ({ page, workspace }) => {
  await place(page, '短标题');
  const state = await workspace.state(), projectId = state.project.id, card = state.cards[0]!;
  await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'shape.create', expected: null,
    payload: { id: 'follower', content: { shapeType: 'rectangle', shortText: '随动' }, pose: { x: 420, y: 310, width: 150, height: 90 } } });
  const follower = (await workspace.state()).shapes![0]!;
  await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'attachment.attach',
    expected: { attachment: null, target: { itemId: card.item.id, versionId: card.item.versionId }, containment: null },
    payload: { itemId: follower.item.id, targetItemId: card.item.id } });
  await page.reload();
  await page.locator('.thought-card').getByRole('button', { name: '编辑正文', exact: true }).click();
  const gate = holdFirstBody(page, card.id);
  await gate.installed;
  try {
    await page.getByRole('textbox', { name: '卡片正文', exact: true }).fill('先保存正文');
    await expect.poll(gate.started).toBe(true);
    await page.getByRole('button', { name: '调整卡片尺寸：下', exact: true }).press('ArrowDown');
    expect((await workspace.state()).cards[0]!.item.pose).toEqual(card.item.pose);
    gate.release();
    await expect(page.getByRole('status')).toHaveText('已保存到本机');
    const after = await workspace.state();
    expect(after.cards[0]!.item.pose).toEqual({ ...card.item.pose, height: 170 });
    expect(after.cards[0]!.item.heightPolicy?.manualHeight).toBe(170);
    expect(after.shapes![0]!.item.pose).toEqual({
      ...follower.item.pose, y: follower.item.pose.y + (170 - card.item.pose.height) / 2,
    });
    expect(after.attachments?.[0]?.target?.itemId).toBe(card.item.id);
  } finally { gate.release(); await page.unrouteAll({ behavior: 'wait' }); }
});

for (const peer of [false, true]) {
  test(peer ? '第三方移动位于捕获和本次首写之间时，首写回执不能跨过第三方版本' :
      '首写发生在另一张卡时取消过期放置依赖但保留实际移动目标', async ({ page, workspace }) => {
    await place(page, '写字板卡', 70, 105);
    await place(page, '另一张卡', 405, 275);
    const before = await workspace.state(), projectId = before.project.id;
    const owner = before.cards.find(card => card.title === '写字板卡')!;
    const target = peer ? owner : before.cards.find(card => card.title === '另一张卡')!;
    await page.locator(`.react-flow__node[data-id="${owner.item.id}"]`).getByRole('button', { name: '编辑正文', exact: true }).click();
    const gate = holdFirstBody(page, owner.id);
    await gate.installed;
    try {
      await page.getByRole('textbox', { name: '卡片正文', exact: true }).fill('等待确认的首写');
      await expect.poll(gate.started).toBe(true);
      await page.locator(`.react-flow__node[data-id="${target.item.id}"]`)
        .getByRole('button', { name: '移动卡片：方向键调整位置', exact: true }).press('ArrowRight');
      const overwrite = { x: target.item.pose.x + 50, y: target.item.pose.y + 25 };
      if (peer) await workspace.execute(page, { commandId: crypto.randomUUID(), type: 'pose.move', projectId,
        expected: target.item.versionId, payload: { id: target.id, ...overwrite } });
      gate.release();
      if (peer) await expect(page.getByRole('alert')).toContainText('布局已更新');
      else await expect(page.getByRole('status')).toHaveText('已保存到本机');
      const result = await workspace.state();
      const updated = result.cards.find(card => card.id === target.id)!;
      expect(result.cards.find(card => card.id === owner.id)!.item.pose.height).toBe(160);
      expect(updated.item.pose).toEqual(peer
        ? { ...target.item.pose, ...overwrite, height: 160 }
        : { ...target.item.pose, x: target.item.pose.x + 10 });
    } finally { gate.release(); await page.unrouteAll({ behavior: 'wait' }); }
  });
}

test('首写和第三方移动导致调宽冲突，明确确认时保留新正文高度', async ({ page, workspace }) => {
  await place(page, '短标题');
  const state = await workspace.state(), projectId = state.project.id, card = state.cards[0]!;
  await page.getByRole('button', { name: '写字板', exact: true }).click();
  const gate = holdFirstBody(page, card.id);
  await gate.installed;
  try {
    await page.getByRole('textbox', { name: '卡片正文', exact: true }).fill('新正文');
    await expect.poll(gate.started).toBe(true);
    await page.getByRole('button', { name: '调整卡片尺寸：右', exact: true }).press('ArrowRight');
    const peer = { x: card.item.pose.x + 40, y: card.item.pose.y + 20 };
    await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'pose.move',
      expected: card.item.versionId, payload: { id: card.id, ...peer } });
    gate.release();
    await expect(page.getByRole('alert')).toContainText('布局已更新');
    await page.getByRole('button', { name: '确认保留本次位置', exact: true }).click();
    await expect(page.getByRole('status')).toHaveText('已保存到本机');
    expect((await workspace.state()).cards[0]!.item.pose).toEqual({
      ...card.item.pose, ...peer, width: card.item.pose.width + 10, height: 160,
    });
  } finally { gate.release(); await page.unrouteAll({ behavior: 'wait' }); }
});

for (const handDrawn of [false, true]) {
  test(`${handDrawn ? '手绘' : '从所选'}创建分区只接续自身首写的布局版本`, async ({ page, workspace }) => {
    await place(page, '短标题', 100, 170);
    await page.locator('.react-flow__pane').click({ position: { x: 30, y: 420 } });
    await place(page, '另一卡', 455, 135);
    const before = await workspace.state(), card = before.cards.find(card => card.title === '短标题')!;
    const title = page.getByRole('button', { name: '短标题', exact: true });
    await title.click();
    await page.getByRole('button', { name: '写字板', exact: true }).click();
    if (handDrawn) await page.getByRole('button', { name: '分区', exact: true }).click();
    else {
      await page.getByRole('button', { name: '另一卡', exact: true }).click({ modifiers: ['Shift'] });
      await expect(page.locator('.react-flow__node.selected')).toHaveCount(2);
    }
    const gate = holdFirstBody(page, card.id);
    await gate.installed;
    try {
      await page.getByRole('textbox', { name: '卡片正文', exact: true }).fill('先完成首写');
      await expect.poll(gate.started).toBe(true);
      if (handDrawn) {
        const box = (await page.locator('.react-flow__pane').boundingBox())!;
        await page.mouse.move(box.x + 75, box.y + 105);
        await page.mouse.down();
        await page.mouse.move(box.x + 760, box.y + 358, { steps: 6 });
        await page.mouse.up();
      } else await page.getByRole('button', { name: '创建分区', exact: true }).click();
      gate.release();
      await expect.poll(async () => (await workspace.state()).frames?.length).toBe(1);
      const after = await workspace.state(), frame = after.frames![0]!;
      expect(frame.memberItemIds.toSorted()).toEqual(before.cards.map(value => value.item.id).toSorted());
      expect(after.cards.find(value => value.id === card.id)?.item.pose.height).toBe(160);
      if (handDrawn) expect(frame.pose).toEqual({ x: 75, y: 105, width: 685, height: 253 });
      else expect(frame.pose.y + frame.pose.height).toBe(card.item.pose.y + 160 + 24);
    } finally { gate.release(); await page.unrouteAll({ behavior: 'wait' }); }
  });
}

for (const detach of [false, true]) {
  test(`${detach ? '解除附着' : '附着'}等待目标卡首写后自有几何确认`, async ({ page, workspace }) => {
    await place(page, '短标题', 70, 115);
    const state = await workspace.state(), projectId = state.project.id, card = state.cards[0]!;
    await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'shape.create', expected: null,
      payload: { id: 'annotation', content: { shapeType: 'rectangle', shortText: '批注' }, pose: { x: 400, y: 260, width: 155, height: 85 } } });
    const item = (await workspace.state()).shapes![0]!.item;
    if (detach) await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'attachment.attach',
      payload: { itemId: item.id, targetItemId: card.item.id },
      expected: { attachment: null, target: { itemId: card.item.id, versionId: card.item.versionId }, containment: null } });
    await page.reload();
    await page.locator('.thought-card').getByRole('button', { name: '编辑正文', exact: true }).click();
    await page.getByRole('img', { name: '批注', exact: true }).click();
    if (!detach) await page.getByRole('button', { name: '附着到卡片', exact: true }).click();
    const gate = holdFirstBody(page, card.id);
    await gate.installed;
    try {
      await page.getByRole('textbox', { name: '卡片正文', exact: true }).fill('首写正文');
      await expect.poll(gate.started).toBe(true);
      const response = page.waitForResponse(r => r.url().endsWith('/api/mapping/execute') &&
        r.request().postDataJSON()?.type === (detach ? 'attachment.detach' : 'attachment.attach'));
      if (detach) await page.getByRole('button', { name: '解除附着', exact: true }).click();
      else await page.getByRole('button', { name: '短标题', exact: true }).click();
      gate.release();
      expect((await response).status()).toBe(200);
      const after = await workspace.state();
      expect(after.attachments).toHaveLength(detach ? 0 : 1);
      expect(after.shapes![0]!.item.pose.y).toBe(item.pose.y + (detach ? (160 - card.item.pose.height) / 2 : 0));
    } finally { gate.release(); await page.unrouteAll({ behavior: 'wait' }); }
  });
}

for (const [observeFirst, clearAgain] of [[true, false], [false, false], [false, true]]) {
  test(`删除附着文字在${observeFirst ? '观察读回早于正文回执' : clearAgain ? '首写回执后、清空回执前' : '正文回执早于读回'}时使用已确认的派生版本`, async ({ page, workspace }) => {
    await place(page, '短标题', 40, 95);
    const state = await workspace.state(), projectId = state.project.id, card = state.cards[0]!;
    await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'text.create', expected: null,
      payload: { id: 'note', content: { runs: [{ text: '附着文字' }], fontSize: 16, lineHeight: 1.5, align: 'left', widthMode: 'fixed', width: 150 },
        pose: { x: 380, y: 270, width: 150, height: 24 } } });
    const note = (await workspace.state()).texts![0]!;
    await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'attachment.attach',
      payload: { itemId: note.item.id, targetItemId: card.item.id },
      expected: { attachment: null, target: { itemId: card.item.id, versionId: card.item.versionId }, containment: null } });
    await page.reload();
    await page.locator('.thought-card').getByRole('button', { name: '编辑正文', exact: true }).click();
    await page.locator('.canvas-text-content').click();
    const before = await workspace.state(), gate = holdFirstBody(page, card.id, true);
    await gate.installed;
    let releaseRead!: () => void;
    const holdRead = new Promise<void>(resolve => { releaseRead = resolve; });
    let reading = false;
    if (!observeFirst) {
      await page.route('**/api/mapping/projects/*/changes?*', async route => { await holdRead; await route.continue(); });
      await page.route('**/api/mapping/projects/*/map?*', async route => {
        if (gate.receipt() && !new URL(route.request().url()).searchParams.has('snapshot')) { reading = true; await holdRead; }
        await route.continue();
      });
    }
    try {
      await page.getByRole('textbox', { name: '卡片正文', exact: true }).fill('首写并随动');
      await expect.poll(() => gate.receipt()?.versions?.body).toBeTruthy();
      if (observeFirst) {
        await page.evaluate(() => window.dispatchEvent(new Event('focus')));
        await expect(page.locator('.workspace')).toHaveAttribute('data-revision', String(before.project.revision + 1));
      } else {
        gate.release();
        await expect.poll(() => reading).toBe(true);
        await expect(page.locator('.workspace')).toHaveAttribute('data-revision', String(before.project.revision));
      }
      const secondWrite = clearAgain ? page.waitForResponse(r => r.url().endsWith('/api/mapping/execute') &&
        r.request().postDataJSON()?.type === 'body.edit' && r.request().postDataJSON().payload.blocks?.every((block: { text?: string }) => !block.text)) : null;
      if (secondWrite) await page.getByRole('textbox', { name: '卡片正文', exact: true }).fill('');
      const deletion = page.waitForResponse(r => r.url().endsWith('/api/mapping/execute') && r.request().postDataJSON()?.type === 'text.delete', { timeout: 7000 });
      await page.getByRole('button', { name: '删除文字', exact: true }).click();
      gate.release();
      releaseRead();
      const derivedReceipt: Receipt = secondWrite ? await (await secondWrite).json() : gate.receipt()!;
      const saved = await deletion;
      expect(saved.status()).toBe(200);
      expect(saved.request().postDataJSON().expected.pose).toBe(derivedReceipt.derivedPoseVersions![note.item.id]!.after);
      expect((await workspace.state()).texts).toEqual([]);
    } finally { gate.release(); releaseRead(); await page.unrouteAll({ behavior: 'wait' }); }
  });
}

for (const peerWidth of [290, 315]) {
  test(`确认调宽保持操作时看到的290px，对方宽度为${peerWidth}px`, async ({ page, workspace }) => {
    await place(page, '短标题');
    const before = await workspace.state(), projectId = before.project.id, card = before.cards[0]!;
    await page.getByRole('button', { name: '写字板', exact: true }).click();
    const gate = holdFirstBody(page, card.id);
    await gate.installed;
    try {
      await page.getByRole('textbox', { name: '卡片正文', exact: true }).fill('首次保存');
      await expect.poll(gate.started).toBe(true);
      await page.getByRole('button', { name: '调整卡片尺寸：右', exact: true }).press('ArrowRight');
      await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'pose.batch',
        expected: { [card.id]: card.item.versionId }, payload: { poses: [{ id: card.id, ...card.item.pose, width: peerWidth }] } });
      gate.release();
      await expect(page.getByRole('alert')).toContainText('布局已更新');
      const compared = await workspace.state();
      const response = page.waitForResponse(r => r.url().endsWith('/api/mapping/execute') && r.request().postDataJSON()?.type === 'pose.batch');
      await page.getByRole('button', { name: '确认保留本次位置', exact: true }).click();
      const accepted = await response;
      expect(accepted.status()).toBe(200);
      await expect(page.getByRole('status')).toHaveText('已保存到本机');
      const after = await workspace.state();
      expect(after.cards[0]!.item.pose).toEqual({ ...card.item.pose, width: 290, height: 160 });
      expect(after.cards[0]!.item.heightPolicy?.manualHeight).toBeNull();
      if (peerWidth === 290) {
        expect(await accepted.json()).toMatchObject({ changedIds: [] });
        expect(after.project.revision).toBe(compared.project.revision);
      }
    } finally { gate.release(); await page.unrouteAll({ behavior: 'wait' }); }
  });
}

test('拖缩分区时清空正文改变成员计划，保留原分区并要求重新预览', async ({ page, workspace }) => {
  const projectId = (await workspace.state()).project.id;
  await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'thought.create', expected: null,
    payload: { id: 'member', title: '分区内有正文', text: '将要清空的正文', x: 130, y: 100 } });
  const state = await workspace.state(), card = state.cards[0]!;
  await workspace.execute(page, createFrameCommand(state, [card.item.id], { x: 80, y: 70, width: 430, height: 285 }));
  await page.reload();
  await page.locator('.thought-card').getByRole('button', { name: '编辑正文', exact: true }).click();
  await page.getByRole('button', { name: '分区1', exact: true }).click();
  const before = await workspace.state();
  const gate = holdFirstBody(page, card.id);
  await gate.installed;
  try {
    await page.getByRole('textbox', { name: '卡片正文', exact: true }).fill('');
    await expect.poll(gate.started).toBe(true);
    const handle = page.getByRole('button', { name: '调整分区范围：上边缘', exact: true });
    const box = (await handle.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + 100, { steps: 6 });
    await page.mouse.up();
    gate.release();
    await expect.poll(async () => (await workspace.state()).cards[0]!.item.pose.height).toBeLessThan(70);
    await expect.poll(async () =>
      (await page.getByRole('alert').count()) > 0 || (await workspace.state()).frames![0]!.pose.y !== before.frames![0]!.pose.y,
    ).toBe(true);
    const after = await workspace.state();
    expect(after.frames).toEqual(before.frames);
    expect(after.containment).toEqual(before.containment);
    await expect(page.getByRole('alert')).toContainText('请重新预览分区范围');
  } finally { gate.release(); await page.unrouteAll({ behavior: 'wait' }); }
});
