import { test, expect, place } from './writing-board-fixture';
import { createCanvas, loadImage } from '../../backend/node_modules/@napi-rs/canvas/index.js';

test('旧自定义色诚实保留，删除先显示影响数、过期确认重读且一次撤销恢复标签和关联', async ({ page, workspace }, info) => {
  await place(page, '卡片甲', 70, 130); await place(page, '卡片乙', 470, 160);
  let state = await workspace.state(); const projectId = state.project.id;
  const run = (type: string, payload: object, expected: unknown = null) => workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type, expected, payload });
  await run('tag.create', { id: 'legacy', name: 'Legacy' }); await run('tag.create', { id: 'other', name: 'Other' });
  for (const c of state.cards) await run('card.tags', { id: c.id, tagIds: ['other', 'legacy'] });
  await workspace.installOriginalTagColor('legacy', '#123456');
  await page.reload(); await expect(page.getByRole('status')).toHaveText('已保存到本机');
  await page.locator('.react-flow__node').filter({ has: page.getByRole('button', { name: '卡片甲', exact: true }) }).getByRole('button', { name: '编辑正文' }).click();
  const board = page.getByRole('complementary', { name: '写字板', exact: true });
  await board.getByRole('button', { name: '管理标签', exact: true }).click();
  await board.getByRole('button', { name: 'Legacy颜色：原有颜色', exact: true }).click();
  const palette = board.getByRole('group', { name: 'Legacy标签颜色' });
  await expect(palette.getByText('原有颜色已保留')).toBeVisible();
  await expect(palette.locator('[data-tag-swatch][aria-pressed=true]')).toHaveCount(0);
  expect((await workspace.state()).tags!.find(t => t.id === 'legacy')!.color).toBe('#123456');
  const png = await board.locator('.board-tags .project-tag').filter({ hasText: 'Legacy' }).screenshot();
  await info.attach('legacy-tag-light-surface', { body: png, contentType: 'image/png' });
  const image = await loadImage(png), canvas = createCanvas(image.width, image.height), context = canvas.getContext('2d');
  context.drawImage(image, 0, 0); const rgb = [...context.getImageData(8, 3, 1, 1).data].slice(0, 3);
  for (const channel of rgb) expect(channel).toBeGreaterThanOrEqual(210);
  expect(await board.getByRole('button', { name: 'Legacy颜色：原有颜色', exact: true }).locator('span').evaluate(e => getComputedStyle(e).backgroundColor)).toBe('rgb(18, 52, 86)');
  await palette.getByRole('button', { name: '蓝色', exact: true }).click();
  await expect.poll(async () => (await workspace.state()).tags!.find(t => t.id === 'legacy')!.color).toBe('#d9e7f1');
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect.poll(async () => (await workspace.state()).tags!.find(t => t.id === 'legacy')!.color).toBe('#123456');
  await expect(palette.getByText('原有颜色已保留')).toBeVisible();
  await palette.getByRole('button', { name: '默认', exact: true }).press('Escape');
  const remove = board.getByRole('button', { name: '删除项目标签：Legacy', exact: true });
  await expect(remove).toBeVisible(); await remove.click();
  const confirmation = board.getByRole('alertdialog', { name: '删除项目标签', exact: true });
  await expect(confirmation).toContainText('2 张卡片');
  state = await workspace.state(); const second = state.cards[1]!;
  await run('card.tags', { id: second.id, tagIds: ['other'] }, second.cardTags!.versionId);
  await confirmation.getByRole('button', { name: '确认删除标签', exact: true }).click();
  await expect(confirmation).not.toBeVisible();
  await expect(board.getByText('删除依据已变化，请重新读取并重新确认', { exact: true })).toBeVisible();
  expect((await workspace.state()).tags!.find(t => t.id === 'legacy')!.deleted).toBe(false);
  await remove.click(); await expect(confirmation).toContainText('1 张卡片');
  await confirmation.getByRole('button', { name: '确认删除标签', exact: true }).click();
  await expect.poll(async () => (await workspace.state()).tags!.find(t => t.id === 'legacy')!.deleted).toBe(true);
  await expect(board.getByText('已删除标签：Legacy', { exact: true })).toBeVisible();
  await board.getByRole('button', { name: '撤销标签删除', exact: true }).click();
  await expect.poll(async () => (await workspace.state()).cards[0]!.cardTags?.tagIds).toEqual(['other', 'legacy']);
  state = await workspace.state(); expect(state.tags!.find(t => t.id === 'legacy')).toMatchObject({ id: 'legacy', name: 'Legacy', color: '#123456', deleted: false });
  expect(state.cards[1]!.cardTags!.tagIds).toEqual(['other']);
  await workspace.restart(); await page.reload(); await expect(page.getByRole('status')).toHaveText('已保存到本机');
  expect((await workspace.state()).tags!.find(t => t.id === 'legacy')!.color).toBe('#123456');
});

test('旧黑色在卡面和写字板仍用浅底深字，持久原色与原有颜色点不改', async ({ page, workspace }, info) => {
  await place(page, '旧黑色卡片', 90, 140);
  const initial = await workspace.state(), projectId = initial.project.id;
  await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'tag.create', payload: { id: 'black', name: '旧黑色' }, expected: null });
  await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'card.tags', payload: { id: initial.cards[0]!.id, tagIds: ['black'] }, expected: null });
  await workspace.installOriginalTagColor('black', '#000000');
  await page.reload(); await expect(page.getByRole('status')).toHaveText('已保存到本机');
  const node = page.locator('.react-flow__node').filter({ has: page.getByRole('button', { name: '旧黑色卡片', exact: true }) });
  await node.getByRole('button', { name: '编辑正文' }).click();
  const board = page.getByRole('complementary', { name: '写字板', exact: true });
  for (const [area, chip] of [
    ['card', node.locator('.card-visible-tags .project-tag')],
    ['board', board.locator('.board-tags .project-tag')],
  ] as const) {
    const png = await chip.screenshot();
    await info.attach(`legacy-black-${area}-surface`, { body: png, contentType: 'image/png' });
    const image = await loadImage(png), canvas = createCanvas(image.width, image.height), context = canvas.getContext('2d');
    context.drawImage(image, 0, 0);
    const rgb = [...context.getImageData(8, 3, 1, 1).data].slice(0, 3);
    for (const channel of rgb) expect(channel).toBeGreaterThanOrEqual(210);
    const ink = await chip.evaluate(e => getComputedStyle(e).color.match(/\d+/g)!.slice(0, 3).map(Number));
    for (const channel of ink) expect(channel).toBeLessThan(100);
  }
  await board.getByRole('button', { name: '管理标签', exact: true }).click();
  const trigger = board.getByRole('button', { name: '旧黑色颜色：原有颜色', exact: true });
  expect(await trigger.locator('span').evaluate(e => getComputedStyle(e).backgroundColor)).toBe('rgb(0, 0, 0)');
  await trigger.click();
  await expect(board.getByRole('group', { name: '旧黑色标签颜色', exact: true }).getByText('原有颜色已保留')).toBeVisible();
  await expect(board.locator('[data-tag-swatch][aria-pressed=true]')).toHaveCount(0);
  const beforeReopen = await workspace.state();
  expect(beforeReopen.tags!.find(t => t.id === 'black')!.color).toBe('#000000');
  expect(beforeReopen.cards[0]!.body).toEqual(initial.cards[0]!.body);
  await workspace.restart(); await page.reload(); await expect(page.getByRole('status')).toHaveText('已保存到本机');
  expect(await workspace.state()).toEqual(beforeReopen);
});
