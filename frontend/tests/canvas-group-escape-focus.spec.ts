import { test, expect, type Workspace } from './writing-board-fixture';
import type { Page } from '@playwright/test';
import { fiveMembers } from './group-selection-fixture';

async function frames(page: Page) {
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}
async function selected(page: Page, ids: string[]) {
  await expect.poll(() => page.locator('.react-flow__node.selected').evaluateAll(nodes => nodes.map(node => (node as HTMLElement).dataset.id!).sort())).toEqual([...ids].sort());
}
async function seed(page: Page, workspace: Workspace, line = false) {
  const f = await fiveMembers(page, workspace), projectId = f.before.project.id;
  if (line) {
    const created = await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'connector.create', expected: null,
      payload: { id: 'focus-line', path: 'curve', start: { kind: 'free', point: { x: 120, y: 600 } }, end: { kind: 'free', point: { x: 900, y: 700 } } } });
    await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'connector.label', expected: created.connectorVersions['focus-line'],
      payload: { id: 'focus-line', label: { text: '焦点连线', position: 0.25, fontSize: 16, color: '#252933', bold: false } } });
    await page.reload();
  }
  await frames(page); await expect(page.getByRole('status')).toHaveText('已保存到本机');
  const before = await workspace.state(), timeline = await (await page.request.get(workspace.origin + '/api/mapping/projects/' + projectId + '/history')).json(), commands: unknown[] = [];
  page.on('request', request => { if (request.url().endsWith('/api/mapping/execute') && request.method() === 'POST') commands.push(request.postDataJSON()); });
  return { ...f, projectId, before, timeline, commands, line: page.locator('.canvas-connector[data-connector-id="focus-line"]') };
}
async function unchanged(page: Page, workspace: Workspace, f: Awaited<ReturnType<typeof seed>>) {
  expect(f.commands).toEqual([]); expect(await workspace.state()).toEqual(f.before);
  expect(await (await page.request.get(workspace.origin + '/api/mapping/projects/' + f.projectId + '/history')).json()).toEqual(f.timeline);
}

test('Shape编辑器真实Tab到保存按钮后Esc保编辑和成员，不提交不清选', async ({ page, workspace }) => {
  const f = await seed(page, workspace); await f.visuals.shape.dblclick();
  const editor = page.getByRole('textbox', { name: '形状文字', exact: true }), save = page.getByRole('button', { name: '保存形状文字', exact: true });
  await expect(editor).toBeFocused(); await selected(page, [f.items.shape.item.id]);
  await page.keyboard.press('Tab'); await expect(save).toBeFocused(); await expect(editor).toBeVisible();
  await selected(page, [f.items.shape.item.id]); await unchanged(page, workspace, f);
  await page.keyboard.press('Escape'); await frames(page);
  await expect(editor).toBeVisible(); await selected(page, [f.items.shape.item.id]); await unchanged(page, workspace, f);
});

test('Label编辑器真实Tab到保存按钮后Esc保编辑和线选区，不提交不清选', async ({ page, workspace }) => {
  const f = await seed(page, workspace, true); await page.getByRole('button', { name: '连线文字', exact: true }).dblclick();
  const editor = page.getByRole('textbox', { name: '连线文字', exact: true }), save = page.getByRole('button', { name: '保存文字', exact: true });
  await expect(editor).toBeFocused(); await selected(page, []); await expect(f.line).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('Tab'); await expect(save).toBeFocused(); await expect(editor).toBeVisible();
  await expect(f.line).toHaveAttribute('aria-pressed', 'true'); await unchanged(page, workspace, f);
  await page.keyboard.press('Escape'); await frames(page);
  await expect(editor).toBeVisible(); await selected(page, []); await expect(f.line).toHaveAttribute('aria-pressed', 'true'); await unchanged(page, workspace, f);
});

test('独立Text编辑器真实Tab到文字颜色按钮后Esc保编辑和成员，不打开面板不提交', async ({ page, workspace }) => {
  const f = await seed(page, workspace); await f.visuals.text.dblclick();
  const editor = page.getByRole('textbox', { name: '独立文字', exact: true }), color = page.getByRole('toolbar', { name: '独立文字样式', exact: true }).getByRole('button', { name: '文字颜色', exact: true });
  await expect(editor).toBeFocused(); await selected(page, [f.items.text.item.id]);
  const path: string[] = [];
  for (let count = 0; count < 64; count++) {
    await page.keyboard.press('Tab');
    path.push(await page.evaluate(() => {
      const element = document.activeElement as HTMLElement;
      return element.tagName + ':' + (element.getAttribute('aria-label') ?? element.textContent?.trim() ?? '');
    }));
    await expect(editor).toBeVisible();
    if (await color.evaluate(element => element === document.activeElement)) break;
  }
  console.log('ISSUE28_TEXT_TAB_FOCUS_PATH', JSON.stringify(path));
  await expect(color).toBeFocused(); await expect(editor).toBeVisible(); await expect(page.locator('.text-color-panel')).toHaveCount(0);
  await selected(page, [f.items.text.item.id]); await unchanged(page, workspace, f);
  await page.keyboard.press('Escape'); await frames(page);
  await expect(editor).toBeVisible(); await selected(page, [f.items.text.item.id]); await expect(page.locator('.text-color-panel')).toHaveCount(0); await unchanged(page, workspace, f);
});

test('静态Text工具栏按钮聚焦但没有编辑器时idle Esc仍清成员选择', async ({ page, workspace }) => {
  const f = await seed(page, workspace); await f.visuals.text.click(); await f.visuals.text.click();
  const color = page.getByRole('toolbar', { name: '独立文字样式', exact: true }).getByRole('button', { name: '文字颜色', exact: true });
  await selected(page, [f.items.text.item.id]); await expect(page.getByRole('textbox', { name: '独立文字', exact: true })).toHaveCount(0);
  await color.focus(); await expect(color).toBeFocused(); await expect(page.locator('.text-color-panel')).toHaveCount(0);
  await page.keyboard.press('Escape'); await frames(page);
  await selected(page, []); await expect(page.getByRole('textbox', { name: '独立文字', exact: true })).toHaveCount(0); await unchanged(page, workspace, f);
});
