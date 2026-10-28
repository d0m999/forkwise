import { test, expect } from './writing-board-fixture';
import { fiveMembers } from './group-selection-fixture';

const scenarios = [
  ['Group', '整Group无单项工具'],
  ['oneGroup', '单成员Image组整体选中无单项工具'],
  ['card', 'Card直选仅目标原菜单和尺寸入口'],
  ['text', 'Text直选仅目标原工具和尺寸入口'],
  ['shape', 'Shape直选仅目标原工具和尺寸入口'],
  ['image', 'Image直选仅目标原工具和尺寸入口'],
  ['stroke', 'Stroke直选仅目标删除入口'],
  ['pureCards', '纯direct两Card保原菜单但无single尺寸入口'],
  ['reverse', 'C先直选再Shift加G立即收起single门且direct C未换'],
] as const;

for (const [mode, title] of scenarios) {
  test(title, async ({ page, workspace }) => {
    const f = await fiveMembers(page, workspace), projectId = f.before.project.id;
    if (mode === 'oneGroup') {
      for (const kind of ['card', 'text', 'shape', 'stroke'] as const) {
        const current = await workspace.state(), group = current.groups!.find(value => value.id === 'selection-group')!;
        const membership = current.containment!.find(value => value.id === f.items[kind].item.id)!;
        expect(membership.parent).toEqual({ kind: 'group', id: group.itemId });
        await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'group.remove-member',
          expected: { group: group.versionId, containment: membership.versionId }, payload: { id: group.id, itemId: f.items[kind].item.id } });
      }
      await page.reload();
    }
    if (mode === 'pureCards' || mode === 'reverse') {
      for (const [id, name, x] of (mode === 'pureCards' ? [['controls-c', '组外C', 100], ['controls-d', '组外D', 440]] : [['controls-c', '组外C', 100]]) as [string, string, number][]) {
        const layout = page.waitForResponse(response => response.url().endsWith('/api/mapping/execute') && response.request().postDataJSON()?.type === 'card.layout');
        await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'thought.create', expected: null,
          payload: { id, title: name, text: '', x, y: 650 } });
        await page.reload(); expect((await layout).status()).toBe(200);
        await expect(page.getByRole('status')).toHaveText('已保存到本机');
      }
    }
    await expect(page.getByRole('status')).toHaveText('已保存到本机');
    const before = await workspace.state(), group = before.groups!.find(value => value.id === 'selection-group')!;
    const memberIds = Object.values(f.items).map(value => value.item.id), c = before.cards.find(value => value.id === 'controls-c'), d = before.cards.find(value => value.id === 'controls-d');
    expect(group.memberItemIds).toEqual(mode === 'oneGroup' ? [f.items.image.item.id] : memberIds);
    if (c) expect(before.containment!.some(value => value.id === c.item.id)).toBe(false);
    if (d) expect(before.containment!.some(value => value.id === d.item.id)).toBe(false);
    const timeline = await (await page.request.get(workspace.origin + '/api/mapping/projects/' + projectId + '/history')).json(), commands: unknown[] = [];
    page.on('request', request => { if (request.url().endsWith('/api/mapping/execute') && request.method() === 'POST') commands.push(request.postDataJSON()); });
    const outline = page.locator('.canvas-group-outline[data-group-id="' + group.id + '"]');
    let selectedIds: string[];
    if (mode === 'Group' || mode === 'oneGroup') {
      await f.visuals[mode === 'Group' ? 'shape' : 'image'].click();
      selectedIds = mode === 'Group' ? memberIds : [f.items.image.item.id];
      await expect(outline).toHaveAttribute('data-selected', 'true');
      await expect(page.getByRole('button', { name: '进入组合', exact: true })).toBeVisible();
    } else if (mode === 'pureCards') {
      await page.getByRole('button', { name: '组外C', exact: true }).click();
      await page.getByRole('button', { name: '组外D', exact: true }).click({ modifiers: ['Shift'] });
      selectedIds = [c!.item.id, d!.item.id];
      await expect(outline).toHaveAttribute('data-selected', 'false');
    } else if (mode === 'reverse') {
      await page.getByRole('button', { name: '组外C', exact: true }).click();
      await expect.poll(() => page.locator('.react-flow__node.selected').evaluateAll(nodes => nodes.map(node => (node as HTMLElement).dataset.id!))).toEqual([c!.item.id]);
      await expect(page.getByRole('toolbar', { name: '卡片操作', exact: true })).toHaveCount(1);
      await expect(page.getByRole('button', { name: /^调整卡片尺寸：/ })).toHaveCount(8);
      await f.visuals.shape.click({ modifiers: ['Shift'] });
      selectedIds = [...memberIds, c!.item.id];
      await expect(outline).toHaveAttribute('data-selected', 'true');
      await expect(page.getByRole('toolbar', { name: '组合操作', exact: true }).getByRole('button', { name: '组合所选对象', exact: true })).toBeVisible();
    } else {
      await f.visuals[mode].click(); await f.visuals[mode].click();
      selectedIds = [f.items[mode].item.id];
      await expect(outline).toHaveAttribute('data-selected', 'false');
    }
    await expect.poll(() => page.locator('.react-flow__node.selected').evaluateAll(nodes => nodes.map(node => (node as HTMLElement).dataset.id!).sort())).toEqual([...selectedIds].sort());
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    const controls = {
      shapeHandles: await page.getByRole('button', { name: /^调整形状尺寸：/ }).count(),
      shapeToolbar: await page.getByRole('toolbar', { name: '形状操作', exact: true }).count(),
      imageHandles: await page.getByRole('button', { name: /^调整图片尺寸：/ }).count(),
      imageToolbar: await page.getByRole('toolbar', { name: '图片操作', exact: true }).count(),
      textHandles: await page.getByRole('button', { name: /^调整文字尺寸：/ }).count(),
      textToolbar: await page.getByRole('toolbar', { name: '独立文字样式', exact: true }).count(),
      strokeDelete: await page.getByRole('button', { name: '删除笔迹', exact: true }).count(),
      cardToolbars: await page.getByRole('toolbar', { name: '卡片操作', exact: true }).count(),
      cardHandles: await page.getByRole('button', { name: /^调整卡片尺寸：/ }).count(),
    };
    console.log('ISSUE28_SINGLE_CONTROLS_NEIGHBOR', JSON.stringify({ mode, selectedIds, controls }));
    expect(controls).toEqual({
      shapeHandles: mode === 'shape' ? 4 : 0, shapeToolbar: mode === 'shape' ? 1 : 0,
      imageHandles: mode === 'image' ? 8 : 0, imageToolbar: mode === 'image' ? 1 : 0,
      textHandles: mode === 'text' ? 6 : 0, textToolbar: mode === 'text' ? 1 : 0,
      strokeDelete: mode === 'stroke' ? 1 : 0,
      cardToolbars: mode === 'card' ? 1 : mode === 'pureCards' ? 2 : 0, cardHandles: mode === 'card' ? 8 : 0,
    });
    expect(commands).toEqual([]); expect(await workspace.state()).toEqual(before);
    expect(await (await page.request.get(workspace.origin + '/api/mapping/projects/' + projectId + '/history')).json()).toEqual(timeline);
  });
}
