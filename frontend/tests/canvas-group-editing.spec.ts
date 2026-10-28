import { test, expect } from './writing-board-fixture';
import { fiveMembers } from './group-selection-fixture';

for (const kind of ['card', 'text', 'shape', 'image'] as const) {
  test(`${kind}组内双击进入既有编辑或查看器且Esc不清成员选择`, async ({ page, workspace }) => {
    const { items, visuals, before } = await fiveMembers(page, workspace);
    await visuals[kind].dblclick();
    const node = page.locator('.react-flow__node[data-id="' + items[kind].item.id + '"]');
    if (kind === 'image') {
      const viewer = page.getByRole('dialog', { name: '图片大图', exact: true });
      await expect(viewer).toBeVisible(); await expect(viewer.getByRole('button', { name: '关闭大图' })).toBeFocused();
      await page.keyboard.press('Escape'); await expect(viewer).not.toBeVisible();
      expect(await workspace.state()).toEqual(before);
    } else {
      const editor = kind === 'card' ? page.getByRole('textbox', { name: '卡片标题', exact: true })
        : kind === 'shape' ? page.getByRole('textbox', { name: '形状文字', exact: true }) : page.locator('.canvas-text-input');
      await expect(editor).toBeVisible(); await expect(editor).toBeFocused();
      await editor.fill('保存后的成员内容'); await page.keyboard.press('Escape');
      await expect(editor).not.toBeVisible();
      await expect.poll(async () => {
        const value = await workspace.state();
        return kind === 'card' ? value.cards[0]!.title : kind === 'shape' ? value.shapes![0]!.content.shortText : value.texts![0]!.content.runs.map(run => run.text).join('');
      }).toBe('保存后的成员内容');
      const after = await workspace.state();
      expect(after.groups).toEqual(before.groups); expect(after.containment).toEqual(before.containment);
      expect(after.strokes).toEqual(before.strokes); expect(after.images).toEqual(before.images);
      expect(after.cards[0]!.item.pose).toEqual(before.cards[0]!.item.pose);
      expect(after.shapes![0]!.item.pose).toEqual(before.shapes![0]!.item.pose);
      expect(after.cards[0]!.body).toEqual(before.cards[0]!.body);
    }
    await expect(node).toHaveClass(/selected/); await expect(page.locator('.react-flow__node.selected')).toHaveCount(1);
    await expect(page.getByRole('group', { name: '组合', exact: true })).toHaveAttribute('data-selected', 'false');
  });
}

test('菜单进入组合只进入上下文不暗选首成员，Stroke双击不创建编辑器', async ({ page, workspace }) => {
  const { visuals, before } = await fiveMembers(page, workspace);
  await visuals.shape.click(); await page.getByRole('button', { name: '进入组合', exact: true }).click();
  await expect(page.locator('.react-flow__node.selected')).toHaveCount(0);
  await expect(page.getByRole('group', { name: '组合', exact: true })).toHaveAttribute('data-selected', 'false');
  await visuals.stroke.dblclick(); await expect(page.locator('.react-flow__node.selected')).toHaveCount(1);
  await expect(page.locator('textarea, [contenteditable=true]')).toHaveCount(0);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(await workspace.state()).toEqual(before);
});
