import { test, expect } from './writing-board-fixture';
import { fiveMembers } from './group-selection-fixture';

// Keyboard equivalence follows the approved Slice A engineering contract;
// D410 describes pointer selection. Browser Tab is not native OS acceptance.
const scenarios = [
  ['shape', 'Space', false], ['shape', 'Enter', false],
  ['image', 'Space', false], ['image', 'Enter', false],
  ['shape', 'Space', true], ['image', 'Enter', true],
] as const;

for (const [kind, key, extend] of scenarios) {
  test(`${kind}真实Tab后${extend ? 'Shift+' : ''}${key}${extend ? '把G追加到looseCard且不拆成员' : '首次选G再次选member'}`, async ({ page, workspace }) => {
    const f = await fiveMembers(page, workspace), projectId = f.before.project.id;
    if (extend) {
      const layout = page.waitForResponse(response => response.url().endsWith('/api/mapping/execute') && response.request().postDataJSON()?.type === 'card.layout');
      await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'thought.create', expected: null,
        payload: { id: 'keyboard-loose-card', title: '键盘组外C', text: '', x: 1020, y: 600 } });
      await page.reload(); expect((await layout).status()).toBe(200);
      await expect(page.getByRole('status')).toHaveText('已保存到本机');
    }
    const before = await workspace.state(), group = before.groups!.find(value => value.id === 'selection-group')!;
    const memberIds = Object.values(f.items).map(value => value.item.id), loose = before.cards.find(value => value.id === 'keyboard-loose-card');
    expect(group.memberItemIds).toEqual(memberIds);
    if (extend) expect(before.containment!.some(value => value.id === loose!.item.id)).toBe(false);
    const timeline = await (await page.request.get(workspace.origin + '/api/mapping/projects/' + projectId + '/history')).json(), commands: unknown[] = [];
    page.on('request', request => { if (request.url().endsWith('/api/mapping/execute') && request.method() === 'POST') commands.push(request.postDataJSON()); });
    const outline = page.locator('.canvas-group-outline[data-group-id="' + group.id + '"]');
    if (extend) await page.getByRole('button', { name: '键盘组外C', exact: true }).click();
    const initialIds = extend ? [loose!.item.id] : [];
    await expect.poll(() => page.locator('.react-flow__node.selected').evaluateAll(nodes => nodes.map(node => (node as HTMLElement).dataset.id!).sort())).toEqual([...initialIds].sort());
    await expect(outline).toHaveAttribute('data-selected', 'false');
    const visual = f.visuals[kind], tabPath: string[] = [];
    for (let count = 0; count < 96; count++) {
      await page.keyboard.press('Tab');
      tabPath.push(await page.evaluate(() => {
        const active = document.activeElement as HTMLElement;
        return active.tagName + ':' + (active.getAttribute('aria-label') ?? active.textContent?.trim() ?? '');
      }));
      if (await visual.evaluate(element => element === document.activeElement)) break;
    }
    console.log('ISSUE28_GROUP_KEYBOARD_TAB_PATH', JSON.stringify({ kind, key, extend, tabPath }));
    await expect(visual).toBeFocused();
    await expect.poll(() => page.locator('.react-flow__node.selected').evaluateAll(nodes => nodes.map(node => (node as HTMLElement).dataset.id!).sort())).toEqual([...initialIds].sort());
    await expect(outline).toHaveAttribute('data-selected', 'false');
    expect(commands).toEqual([]); expect(await workspace.state()).toEqual(before);
    expect(await (await page.request.get(workspace.origin + '/api/mapping/projects/' + projectId + '/history')).json()).toEqual(timeline);
    await page.keyboard.press(extend ? 'Shift+' + key : key);
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    console.log('ISSUE28_GROUP_KEYBOARD_FIRST', JSON.stringify({ kind, key, extend,
      selected: await page.locator('.react-flow__node.selected').evaluateAll(nodes => nodes.map(node => (node as HTMLElement).dataset.id!)),
      outlineSelected: await outline.getAttribute('data-selected'), commands }));
    const firstIds = extend ? [...memberIds, loose!.item.id] : memberIds;
    await expect.poll(() => page.locator('.react-flow__node.selected').evaluateAll(nodes => nodes.map(node => (node as HTMLElement).dataset.id!).sort())).toEqual([...firstIds].sort());
    await expect(outline).toHaveAttribute('data-selected', 'true');
    if (extend) {
      await expect(page.getByRole('toolbar', { name: '组合操作', exact: true }).getByRole('button', { name: '组合所选对象', exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: '进入组合', exact: true })).toHaveCount(0);
    } else {
      await expect(page.getByRole('button', { name: '进入组合', exact: true })).toBeVisible();
      await expect(visual).toBeFocused(); await page.keyboard.press(key);
      await expect.poll(() => page.locator('.react-flow__node.selected').evaluateAll(nodes => nodes.map(node => (node as HTMLElement).dataset.id!))).toEqual([f.items[kind].item.id]);
      await expect(outline).toHaveAttribute('data-selected', 'false');
      await expect(page.getByRole('button', { name: '进入组合', exact: true })).toHaveCount(0);
    }
    expect(commands).toEqual([]); expect(await workspace.state()).toEqual(before);
    expect(await (await page.request.get(workspace.origin + '/api/mapping/projects/' + projectId + '/history')).json()).toEqual(timeline);
  });
}
