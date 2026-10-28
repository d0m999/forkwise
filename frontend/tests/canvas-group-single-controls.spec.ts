import { test, expect } from './writing-board-fixture';
import { fiveMembers } from './group-selection-fixture';

test('Group加looseCard仅一个direct时不露组内单项工具，选择和领域状态保持', async ({ page, workspace }) => {
  const f = await fiveMembers(page, workspace), projectId = f.before.project.id;
  const layout = page.waitForResponse(response => response.url().endsWith('/api/mapping/execute') && response.request().postDataJSON()?.type === 'card.layout');
  await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'thought.create', expected: null,
    payload: { id: 'single-controls-card', title: '组外卡片C', text: '', x: 1020, y: 600 } });
  await page.reload(); expect((await layout).status()).toBe(200);
  await expect(page.getByRole('status')).toHaveText('已保存到本机');
  const before = await workspace.state(), group = before.groups!.find(value => value.id === 'selection-group')!, loose = before.cards.find(value => value.id === 'single-controls-card')!;
  const members = Object.values(f.items).map(value => value.item.id), all = [...members, loose.item.id];
  expect(before.groups).toHaveLength(1); expect(group.memberItemIds).toEqual(members);
  expect(before.containment!.some(value => value.id === loose.item.id)).toBe(false);
  for (const itemId of members) expect(before.containment!.find(value => value.id === itemId)!.parent).toEqual({ kind: 'group', id: group.itemId });
  expect([before.cards.length, before.texts!.length, before.shapes!.length, before.images!.length, before.strokes!.length]).toEqual([2, 1, 1, 1, 1]);
  const timeline = await (await page.request.get(workspace.origin + '/api/mapping/projects/' + projectId + '/history')).json(), commands: unknown[] = [];
  page.on('request', request => { if (request.url().endsWith('/api/mapping/execute') && request.method() === 'POST') commands.push(request.postDataJSON()); });
  const outline = page.locator('.canvas-group-outline[data-group-id="' + group.id + '"]');
  await f.visuals.shape.click();
  await expect(outline).toHaveAttribute('data-selected', 'true');
  await expect(page.getByRole('button', { name: '进入组合', exact: true })).toBeVisible();
  await expect.poll(() => page.locator('.react-flow__node.selected').evaluateAll(nodes => nodes.map(node => (node as HTMLElement).dataset.id!).sort())).toEqual([...members].sort());
  await page.getByRole('button', { name: '组外卡片C', exact: true }).click({ modifiers: ['Shift'] });
  await expect(outline).toHaveAttribute('data-selected', 'true');
  await expect.poll(() => page.locator('.react-flow__node.selected').evaluateAll(nodes => nodes.map(node => (node as HTMLElement).dataset.id!).sort())).toEqual([...all].sort());
  await expect(page.getByRole('toolbar', { name: '组合操作', exact: true }).getByRole('button', { name: '组合所选对象', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '进入组合', exact: true })).toHaveCount(0);
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  expect(commands).toEqual([]); expect(await workspace.state()).toEqual(before);
  expect(await (await page.request.get(workspace.origin + '/api/mapping/projects/' + projectId + '/history')).json()).toEqual(timeline);
  const controls = {
    shapeHandles: await page.getByRole('button', { name: /^调整形状尺寸：/ }).count(),
    shapeToolbar: await page.getByRole('toolbar', { name: '形状操作', exact: true }).count(),
    imageHandles: await page.getByRole('button', { name: /^调整图片尺寸：/ }).count(),
    imageToolbar: await page.getByRole('toolbar', { name: '图片操作', exact: true }).count(),
    textHandles: await page.getByRole('button', { name: /^调整文字尺寸：/ }).count(),
    textToolbar: await page.getByRole('toolbar', { name: '独立文字样式', exact: true }).count(),
    strokeDelete: await page.getByRole('button', { name: '删除笔迹', exact: true }).count(),
    cardToolbars: await page.getByRole('toolbar', { name: '卡片操作', exact: true }).count(),
  };
  console.log('ISSUE28_SINGLE_CONTROLS_PROOF', JSON.stringify({ selectionInput: ['Shape首click选G', 'Shift-click组外C'], groupId: group.id, memberItemIds: members, directCardItemId: loose.item.id, expectedFlowSelected: all, controls }));
  expect(controls).toEqual({ shapeHandles: 0, shapeToolbar: 0, imageHandles: 0, imageToolbar: 0, textHandles: 0, textToolbar: 0, strokeDelete: 0, cardToolbars: 0 });
  expect(commands).toEqual([]); expect(await workspace.state()).toEqual(before);
  expect(await (await page.request.get(workspace.origin + '/api/mapping/projects/' + projectId + '/history')).json()).toEqual(timeline);
});
