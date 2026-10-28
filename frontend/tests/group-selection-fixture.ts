import { expect, type Page } from '@playwright/test';
import type { Workspace } from './writing-board-fixture';

export async function fiveMembers(page: Page, workspace: Workspace) {
  const projectId = (await workspace.state()).project.id;
  const execute = (type: string, payload: unknown, expected: unknown = null) => workspace.execute(page,
    { commandId: crypto.randomUUID(), projectId, type, expected, payload });
  const layout = page.waitForResponse(response => response.url().endsWith('/api/mapping/execute') && response.request().postDataJSON()?.type === 'card.layout');
  await execute('thought.create', { id: 'selection-card', title: '组合卡片', text: '组合正文保持', x: 100, y: 120 });
  await execute('text.create', { id: 'selection-text', content: { runs: [{ text: '组内独立文字' }], fontSize: 18, lineHeight: 1.5,
    align: 'left', widthMode: 'fixed', width: 180 }, pose: { x: 440, y: 140, width: 180, height: 27 } });
  await execute('shape.create', { id: 'selection-shape', content: { shapeType: 'ellipse', shortText: '组内椭圆' },
    pose: { x: 720, y: 120, width: 160, height: 100 } });
  await execute('asset.save', { id: 'selection-asset', name: '组内图片.svg', mime: 'image/svg+xml',
    base64: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="160" height="120"><rect width="160" height="120" fill="#43a89a"/></svg>').toString('base64') });
  await execute('image.create', { id: 'selection-image', content: { assetId: 'selection-asset', crop: { x: 0, y: 0, width: 1, height: 1 } },
    pose: { x: 100, y: 420, width: 160, height: 120, rotation: 0 } });
  await execute('stroke.create', { id: 'selection-stroke', content: { penKind: 'pen', path: [{ x: 0, y: 10 }, { x: 200, y: 10 }], width: 6, color: '#123456', opacity: 1 },
    pose: { x: 440, y: 420, width: 200, height: 20 } });
  const initial = await workspace.state();
  const items = { card: initial.cards[0]!, text: initial.texts![0]!, shape: initial.shapes![0]!, image: initial.images![0]!, stroke: initial.strokes![0]! };
  const ids = Object.values(items).map(value => value.item.id);
  await execute('group.create', { id: 'selection-group', itemIds: ids },
    { groups: { 'selection-group': null }, containment: Object.fromEntries(ids.map(id => [id, null])) });
  await page.reload(); expect((await layout).status()).toBe(200); await expect(page.getByRole('status')).toHaveText('已保存到本机');
  const visuals = { card: page.getByRole('button', { name: '组合卡片', exact: true }),
    text: page.getByRole('group', { name: '独立文字：方向键调整位置，Enter编辑', exact: true }),
    shape: page.getByRole('img', { name: '组内椭圆', exact: true }), image: page.getByRole('img', { name: '组内图片.svg', exact: true }),
    stroke: page.getByRole('button', { name: '选择普通笔笔迹', exact: true }) };
  for (const visual of Object.values(visuals)) await expect(visual).toBeVisible();
  const before = await workspace.state();
  expect([before.cards.length, before.texts!.length, before.shapes!.length, before.images!.length, before.strokes!.length]).toEqual([1, 1, 1, 1, 1]);
  expect(before.groups![0]!.memberItemIds).toEqual(ids);
  expect(Object.values(items).map(value => [value.id, value.item.pose.x, value.item.pose.y])).toEqual([
    ['selection-card', 100, 120], ['selection-text', 440, 140], ['selection-shape', 720, 120], ['selection-image', 100, 420], ['selection-stroke', 440, 420],
  ]);
  const timeline = await (await page.request.get(workspace.origin + '/api/mapping/projects/' + projectId + '/history')).json();
  return { items, visuals, before, timeline };
}
