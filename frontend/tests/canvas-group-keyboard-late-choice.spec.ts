import { test, expect } from './writing-board-fixture';
import { fiveMembers } from './group-selection-fixture';

test('真实Tab Shape加Space等待正文ACK时，后选Text不被旧键盘选择覆盖', async ({ page, workspace }) => {
  const { items, visuals, before, timeline } = await fiveMembers(page, workspace);
  await page.getByRole('button', { name: '编辑正文', exact: true }).click();
  const editor = page.getByRole('textbox', { name: '卡片正文', exact: true });
  await expect(editor).toHaveText('组合正文保持');
  await page.getByRole('button', { name: '适应画布', exact: true }).click();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let committed = false, delivered = false;
  const commands: any[] = [];
  page.on('request', request => { if (request.url().endsWith('/api/mapping/execute') && request.method() === 'POST') commands.push(request.postDataJSON()); });
  page.on('response', response => { if (response.url().endsWith('/api/mapping/execute') && response.request().postDataJSON()?.type === 'body.edit') delivered = true; });
  await page.route('**/api/mapping/execute', async route => {
    if (route.request().postDataJSON()?.type !== 'body.edit') { await route.continue(); return; }
    const response = await route.fetch(); expect(response.status()).toBe(200); committed = true;
    await gate; await route.fulfill({ response });
  });
  try {
    await editor.click(); await editor.press('End'); await page.keyboard.insertText('短');
    const tabPath: string[] = [];
    for (let count = 0; count < 96; count++) {
      await page.keyboard.press('Tab');
      tabPath.push(await page.evaluate(() => document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.textContent?.trim() ?? ''));
      if (await visuals.shape.evaluate(element => element === document.activeElement)) break;
    }
    console.log('ISSUE28_KEYBOARD_LATE_TAB', JSON.stringify(tabPath));
    await expect(visuals.shape).toBeFocused(); await page.keyboard.press('Space');
    await expect.poll(() => committed).toBe(true); expect(delivered).toBe(false);
    const pending = await workspace.state();
    expect(pending.cards[0]!.body.blocks.map(block => block.text)).toEqual(['组合正文保持短']);
    await expect(page.locator('.react-flow__node.selected')).toHaveCount(5);
    await visuals.text.click();
    await expect.poll(() => page.locator('.react-flow__node.selected').evaluateAll(nodes => nodes.map(node => (node as HTMLElement).dataset.id!))).toEqual([items.text.item.id]);
    await expect(visuals.text).toBeFocused(); expect(delivered).toBe(false);
    release(); await expect.poll(() => delivered).toBe(true);
    await expect(page.getByRole('status')).toHaveText('已保存到本机');
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect.poll(() => page.locator('.react-flow__node.selected').evaluateAll(nodes => nodes.map(node => (node as HTMLElement).dataset.id!))).toEqual([items.text.item.id]);
    await expect(visuals.text).toBeFocused();
    expect(await workspace.state()).toEqual(pending); expect(pending.project.revision).toBe(before.project.revision + 1);
    expect(pending.groups).toEqual(before.groups); expect(pending.containment).toEqual(before.containment);
    expect(commands.map(command => command.type)).toEqual(['body.edit']);
    expect((await (await page.request.get(workspace.origin + '/api/mapping/projects/' + before.project.id + '/history')).json()).undo).toHaveLength(timeline.undo.length + 1);
  } finally { release(); await page.unrouteAll({ behavior: 'wait' }); }
});
