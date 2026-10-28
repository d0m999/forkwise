import { test, expect, type Workspace } from './writing-board-fixture';
import type { Page } from '@playwright/test';
import type { ProjectState } from '../src/api';
import { fiveMembers } from './group-selection-fixture';

async function read(page: Page, workspace: Workspace, projectId: string): Promise<ProjectState> {
  return (await page.request.get(workspace.origin + '/api/mapping/projects/' + projectId)).json();
}
async function frames(page: Page) {
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}
async function bound(page: Page, id: string, text: string) {
  await expect(page.locator('.body-editor small[title]')).toHaveAttribute('title', id);
  await expect(page.getByRole('textbox', { name: '卡片正文', exact: true })).toHaveText(text);
}
async function seed(page: Page, workspace: Workspace, single = false, anotherProject = false) {
  const group = await fiveMembers(page, workspace), projectId = group.before.project.id;
  for (const [id, title, text, x] of [['follow-a', '绑定甲', '甲旧正文', 100], ['follow-b', '独立乙', '乙旧正文', 440], ['follow-c', '独立丙', '丙旧正文', 760]] as const)
    await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'thought.create', expected: null,
      payload: { id, title, text, x, y: 650 } });
  if (single) {
    const initial = await read(page, workspace, projectId), card = initial.cards.find(card => card.id === 'follow-b')!,
      spare = initial.cards.find(card => card.id === 'follow-c')!;
    expect(initial.containment!.some(value => [card.item.id, spare.item.id].includes(value.id))).toBe(false);
    await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'group.create',
      expected: { groups: { 'single-follow': null }, containment: { [card.item.id]: null, [spare.item.id]: null } },
      payload: { id: 'single-follow', itemIds: [card.item.id, spare.item.id] } });
    const created = await read(page, workspace, projectId), group = created.groups!.find(value => value.id === 'single-follow')!,
      membership = created.containment!.find(value => value.id === spare.item.id)!;
    expect(group.memberItemIds).toEqual([card.item.id, spare.item.id]);
    expect(membership.parent).toEqual({ kind: 'group', id: group.itemId });
    await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'group.remove-member',
      expected: { group: group.versionId, containment: membership.versionId }, payload: { id: group.id, itemId: spare.item.id } });
    const released = await read(page, workspace, projectId);
    expect(released.groups!.find(value => value.id === group.id)!.memberItemIds).toEqual([card.item.id]);
    expect(released.containment!.find(value => value.id === spare.item.id)!.parent).toBeNull();
  }
  await page.reload(); await expect(page.getByRole('status')).toHaveText('已保存到本机');
  const a = page.getByRole('button', { name: '绑定甲', exact: true }), b = page.getByRole('button', { name: '独立乙', exact: true }),
    c = page.getByRole('button', { name: '独立丙', exact: true });
  await expect(a).toBeVisible(); await expect(b).toBeVisible(); await expect(c).toBeVisible();
  let otherProjectId = '';
  if (anotherProject) {
    const tabCount = await page.getByRole('tab').count();
    await page.getByRole('button', { name: '新建研究', exact: true }).click();
    await expect(page.getByRole('tab')).toHaveCount(tabCount + 1);
    await expect.poll(async () => {
      const id = await page.getByRole('tab', { selected: true }).getAttribute('title');
      return !!id && id !== projectId;
    }).toBe(true);
    otherProjectId = (await page.getByRole('tab', { selected: true }).getAttribute('title'))!;
    expect(otherProjectId).not.toBe(projectId);
    await page.locator('[role="tab"][title="' + projectId + '"]').click();
    await expect(page.locator('[role="tab"][title="' + projectId + '"]')).toHaveAttribute('aria-selected', 'true');
  }
  const current = await read(page, workspace, projectId), cardA = current.cards.find(card => card.id === 'follow-a')!,
    cardB = current.cards.find(card => card.id === 'follow-b')!, cardC = current.cards.find(card => card.id === 'follow-c')!;
  await page.locator('.react-flow__node[data-id="' + cardA.item.id + '"]').getByRole('button', { name: '编辑正文', exact: true }).click();
  await bound(page, cardA.id, '甲旧正文');
  await page.getByRole('button', { name: '适应画布', exact: true }).click();
  await frames(page); await expect(page.getByRole('status')).toHaveText('已保存到本机');
  const before = await read(page, workspace, projectId), timeline = await (await page.request.get(workspace.origin + '/api/mapping/projects/' + projectId + '/history')).json();
  expect([cardA, cardB, cardC].map(card => [card.id, card.title, card.body.blocks.map(block => block.text)])).toEqual([
    ['follow-a', '绑定甲', ['甲旧正文']], ['follow-b', '独立乙', ['乙旧正文']], ['follow-c', '独立丙', ['丙旧正文']],
  ]);
  const commands: any[] = [];
  page.on('request', request => { if (request.url().endsWith('/api/mapping/execute') && request.method() === 'POST') commands.push(request.postDataJSON()); });
  return { ...group, projectId, otherProjectId, a, b, c, cardA, cardB, cardC, before, timeline, commands };
}
async function settled(page: Page) {
  await expect(page.getByRole('status')).toHaveText('已保存到本机'); await frames(page);
}
async function unchanged(page: Page, workspace: Workspace, data: Awaited<ReturnType<typeof seed>>) {
  expect(data.commands).toEqual([]); expect(await read(page, workspace, data.projectId)).toEqual(data.before);
  expect(await (await page.request.get(workspace.origin + '/api/mapping/projects/' + data.projectId + '/history')).json()).toEqual(data.timeline);
}

test('绑定甲后Group加loose乙混选不是单Card，不跟随写字板', async ({ page, workspace }) => {
  const data = await seed(page, workspace);
  await data.visuals.shape.click(); await data.b.click({ modifiers: ['Shift'] });
  await expect(page.locator('.react-flow__node.selected')).toHaveCount(6);
  await expect(page.getByRole('group', { name: '组合', exact: true })).toHaveAttribute('data-selected', 'true');
  await settled(page); await bound(page, data.cardA.id, '甲旧正文'); await unchanged(page, workspace, data);
});
test('绑定甲后一成员Group整体选中仍不跟随写字板', async ({ page, workspace }) => {
  const data = await seed(page, workspace, true);
  await data.a.click(); await data.b.click();
  await expect(page.locator('.react-flow__node.selected')).toHaveCount(1);
  await expect(page.getByRole('button', { name: '进入组合', exact: true })).toBeVisible();
  await settled(page); await bound(page, data.cardA.id, '甲旧正文'); await unchanged(page, workspace, data);
});
test('Card乙和Shape直选经外部删除自然投影收窄为乙，不触发跟随', async ({ page, workspace }) => {
  const data = await seed(page, workspace);
  await data.visuals.shape.click(); await data.visuals.shape.click(); await data.b.click({ modifiers: ['Shift'] });
  await expect(page.locator('.react-flow__node.selected')).toHaveCount(2);
  await settled(page); await bound(page, data.cardA.id, '甲旧正文');
  const shape = data.before.shapes!.find(value => value.id === data.items.shape.id)!, group = data.before.groups![0]!,
    membership = data.before.containment!.find(value => value.id === shape.item.id)!;
  await workspace.execute(page, { commandId: crypto.randomUUID(), projectId: data.projectId, type: 'shape.delete',
    expected: { shape: shape.versionId, pose: shape.item.versionId, membership: { group: { id: group.id, versionId: group.versionId }, containment: membership.versionId } },
    payload: { id: shape.id } });
  const after = await read(page, workspace, data.projectId);
  await expect(page.locator('.workspace')).toHaveAttribute('data-revision', String(after.project.revision));
  await expect(page.locator('.react-flow__node[data-id="' + shape.item.id + '"]')).toHaveCount(0);
  await expect(page.locator('.react-flow__node.selected')).toHaveCount(1);
  await expect(page.locator('.react-flow__node[data-id="' + data.cardB.item.id + '"]')).toHaveClass(/selected/);
  await settled(page); await bound(page, data.cardA.id, '甲旧正文');
  expect(data.commands).toEqual([]); expect(after.project.revision).toBe(data.before.project.revision + 1);
  expect(after.cards).toEqual(data.before.cards);
  expect((await (await page.request.get(workspace.origin + '/api/mapping/projects/' + data.projectId + '/history')).json()).undo).toHaveLength(data.timeline.undo.length + 1);
});
test('绑定甲后成员Card首click整体不跟随，第二完成click直选才跟随', async ({ page, workspace }) => {
  const data = await seed(page, workspace);
  await data.visuals.card.click(); await expect(page.locator('.react-flow__node.selected')).toHaveCount(5);
  await settled(page); await bound(page, data.cardA.id, '甲旧正文');
  await data.visuals.card.click(); await expect(page.locator('.react-flow__node.selected')).toHaveCount(1);
  await settled(page); await bound(page, data.items.card.id, '组合正文保持'); await unchanged(page, workspace, data);
});

async function heldSave(page: Page, workspace: Workspace, data: Awaited<ReturnType<typeof seed>>) {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let committed = false, delivered = false;
  page.on('response', response => { if (response.url().endsWith('/api/mapping/execute') && response.request().postDataJSON()?.type === 'body.edit') delivered = true; });
  await page.route('**/api/mapping/execute', async route => {
    if (route.request().postDataJSON()?.type !== 'body.edit') { await route.continue(); return; }
    const response = await route.fetch(); expect(response.status()).toBe(200); committed = true;
    await gate; await route.fulfill({ response });
  });
  return {
    async start() {
      const editor = page.getByRole('textbox', { name: '卡片正文', exact: true });
      await editor.click(); await editor.press('End'); await page.keyboard.insertText('短');
      await data.b.click();
      await expect.poll(() => committed).toBe(true); expect(delivered).toBe(false);
      await expect(page.locator('.react-flow__node[data-id="' + data.cardB.item.id + '"]')).toHaveClass(/selected/);
      await frames(page); expect(delivered).toBe(false); await bound(page, data.cardA.id, '甲旧正文短');
      const pending = await read(page, workspace, data.projectId);
      expect(pending.cards.find(card => card.id === data.cardA.id)!.body.blocks.map(block => block.text)).toEqual(['甲旧正文短']);
      expect(pending.project.revision).toBe(data.before.project.revision + 1);
      return pending;
    },
    async finish(pending: ProjectState) {
      release(); await expect.poll(() => delivered).toBe(true); await settled(page);
      expect(await read(page, workspace, data.projectId)).toEqual(pending); expect(data.commands.map(command => command.type)).toEqual(['body.edit']);
      expect((await (await page.request.get(workspace.origin + '/api/mapping/projects/' + data.projectId + '/history')).json()).undo).toHaveLength(data.timeline.undo.length + 1);
    },
    async close() { release(); await page.unrouteAll({ behavior: 'wait' }); },
  };
}
test('dirty甲保存等待时乙再丙，旧乙不覆盖丙且正文只保存回甲', async ({ page, workspace }) => {
  const data = await seed(page, workspace), held = await heldSave(page, workspace, data);
  try {
    const pending = await held.start(); await data.c.click();
    await expect(page.locator('.react-flow__node[data-id="' + data.cardC.item.id + '"]')).toHaveClass(/selected/);
    await held.finish(pending); await bound(page, data.cardC.id, '丙旧正文');
  } finally { await held.close(); }
});
test('dirty甲保存等待时乙再Group加乙，旧单Card请求不得绑定混选', async ({ page, workspace }) => {
  const data = await seed(page, workspace), held = await heldSave(page, workspace, data);
  try {
    const pending = await held.start(); await data.visuals.shape.click(); await data.b.click({ modifiers: ['Shift'] });
    await expect(page.locator('.react-flow__node.selected')).toHaveCount(6);
    await held.finish(pending); await bound(page, data.cardA.id, '甲旧正文短');
  } finally { await held.close(); }
});
test('dirty甲保存等待时乙再切项目，旧乙不在目标项目重开写字板', async ({ page, workspace }) => {
  const data = await seed(page, workspace, false, true), held = await heldSave(page, workspace, data);
  try {
    const pending = await held.start();
    await page.locator('[role="tab"][title="' + data.otherProjectId + '"]').click();
    await expect(page.locator('[role="tab"][title="' + data.projectId + '"]')).toHaveAttribute('aria-selected', 'true');
    await held.finish(pending);
    await expect(page.locator('[role="tab"][title="' + data.otherProjectId + '"]')).toHaveAttribute('aria-selected', 'true');
    await expect(page).toHaveURL(new RegExp('project=' + data.otherProjectId));
    await frames(page); await expect(page.getByLabel('写字板', { exact: true })).toHaveCount(0);
  } finally { await held.close(); }
});
test('dirty甲保存等待时乙到Shape再乙，新选择不被旧finally去重清除', async ({ page, workspace }) => {
  const data = await seed(page, workspace), held = await heldSave(page, workspace, data);
  try {
    const pending = await held.start(); await data.visuals.shape.click(); await data.visuals.shape.click();
    await expect(page.locator('.react-flow__node.selected')).toHaveCount(1);
    await expect(page.locator('.react-flow__node[data-id="' + data.items.shape.item.id + '"]')).toHaveClass(/selected/);
    await data.b.click(); await expect(page.locator('.react-flow__node[data-id="' + data.cardB.item.id + '"]')).toHaveClass(/selected/);
    await held.finish(pending); await bound(page, data.cardB.id, '乙旧正文');
  } finally { await held.close(); }
});
