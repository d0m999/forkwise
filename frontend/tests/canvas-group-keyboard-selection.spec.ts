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


for (const modifier of ['Meta', 'Control']) {
  test(`D414 ${modifier}+G把五类所选对象原子建组且只写一次`, async ({ page, workspace }) => {
    const f = await fiveMembers(page, workspace), projectId = f.before.project.id;
    await f.visuals.shape.click();
    await page.getByRole('button', { name: '取消组合', exact: true }).click();
    await expect(page.getByRole('status')).toHaveText('已保存到本机');
    await expect(page.getByRole('button', { name: '组合所选对象', exact: true })).toBeEnabled();
    await expect(page.locator('.react-flow__node.selected')).toHaveCount(5);
    const before = await workspace.state(), historyUrl = workspace.origin + '/api/mapping/projects/' + projectId + '/history';
    const timeline = await (await page.request.get(historyUrl)).json(), commands: any[] = [];
    expect(before.groups).toEqual([]);
    page.on('request', request => { if (request.url().endsWith('/api/mapping/execute') && request.method() === 'POST') commands.push(request.postDataJSON()); });
    await f.visuals.card.focus();
    await page.keyboard.press(modifier + '+g');
    await expect.poll(async () => (await workspace.state()).groups?.length).toBe(1);
    await expect(page.getByRole('status')).toHaveText('已保存到本机');
    const after = await workspace.state(), group = after.groups![0]!, ids = Object.values(f.items).map(value => value.item.id);
    const history = await (await page.request.get(historyUrl)).json();
    expect(group.memberItemIds).toEqual(ids);
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({ type: 'group.create', projectId,
      payload: { id: group.id, itemIds: ids }, expected: { groups: { [group.id]: null },
        containment: Object.fromEntries(before.containment!.map(value => [value.id, value.versionId])) } });
    expect(after.project.revision).toBe(before.project.revision + 1);
    expect(history.revision).toBe(after.project.revision);
    expect(history.undo).toHaveLength(timeline.undo.length + 1);
    expect(history.undo.at(-1)).toMatchObject({ id: commands[0].commandId, label: 'group.create', target: { id: group.id } });
    for (const field of ['cards', 'texts', 'shapes', 'images', 'strokes', 'connectors'] as const) expect(after[field]).toEqual(before[field]);
    await expect(page.locator('.canvas-group-outline[data-group-id="' + group.id + '"]')).toHaveAttribute('data-selected', 'true');
  });

  test(`D414 ${modifier}+Shift+G仅解唯一所选Group且保五类成员`, async ({ page, workspace }) => {
    const f = await fiveMembers(page, workspace), projectId = f.before.project.id;
    await f.visuals.shape.click();
    await expect(page.getByRole('button', { name: '取消组合', exact: true })).toBeEnabled();
    const before = await workspace.state(), group = before.groups![0]!;
    const historyUrl = workspace.origin + '/api/mapping/projects/' + projectId + '/history';
    const timeline = await (await page.request.get(historyUrl)).json(), commands: any[] = [];
    page.on('request', request => { if (request.url().endsWith('/api/mapping/execute') && request.method() === 'POST') commands.push(request.postDataJSON()); });
    await f.visuals.card.focus();
    await page.keyboard.press(modifier + '+Shift+g');
    await expect.poll(async () => (await workspace.state()).groups?.length).toBe(0);
    await expect(page.getByRole('status')).toHaveText('已保存到本机');
    const after = await workspace.state(), history = await (await page.request.get(historyUrl)).json();
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({ type: 'group.ungroup', projectId, payload: { id: group.id },
      expected: { group: group.versionId, containment: Object.fromEntries(before.containment!.map(value => [value.id, value.versionId])) } });
    expect(after.project.revision).toBe(before.project.revision + 1);
    expect(history.revision).toBe(after.project.revision);
    expect(history.undo).toHaveLength(timeline.undo.length + 1);
    expect(history.undo.at(-1)).toMatchObject({ id: commands[0].commandId, label: 'group.ungroup', target: { id: group.id } });
    for (const field of ['cards', 'texts', 'shapes', 'images', 'strokes', 'connectors'] as const) expect(after[field]).toEqual(before[field]);
    expect(after.containment!.map(value => value.id).sort()).toEqual([...group.memberItemIds].sort());
    expect(after.containment!.every(value => value.parent === null)).toBe(true);
    await expect(page.locator('.react-flow__node.selected')).toHaveCount(5);
    await expect(page.getByRole('button', { name: '组合所选对象', exact: true })).toBeEnabled();
  });
}


test('D414 DOM合成协议和已消费事件保选区状态且不截未执行默认行为', async ({ page, workspace }) => {
  const f = await fiveMembers(page, workspace);
  await f.visuals.shape.click();
  await expect(page.getByRole('button', { name: '取消组合', exact: true })).toBeEnabled();
  const before = await workspace.state(), historyUrl = workspace.origin + '/api/mapping/projects/' + before.project.id + '/history';
  const timeline = await (await page.request.get(historyUrl)).json(), commands: any[] = [];
  page.on('request', request => { if (request.url().endsWith('/api/mapping/execute') && request.method() === 'POST') commands.push(request.postDataJSON()); });
  const prevented = await f.visuals.card.evaluate(element => [
    { consumed: true, init: {} }, { consumed: false, init: { isComposing: true } },
    { consumed: false, init: { keyCode: 229 } }, { consumed: false, init: { altKey: true } },
    { consumed: false, init: { ctrlKey: false } },
  ].map(({ consumed, init }) => {
    const event = new KeyboardEvent('keydown', { key: 'G', code: 'KeyG', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true, ...init });
    if (consumed) event.preventDefault();
    element.dispatchEvent(event);
    return event.defaultPrevented;
  }));
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  expect(prevented).toEqual([true, false, false, false, false]);
  expect(commands).toEqual([]); expect(await workspace.state()).toEqual(before);
  expect(await (await page.request.get(historyUrl)).json()).toEqual(timeline);
  await expect(page.locator('.react-flow__node.selected')).toHaveCount(5);
});

test('D414唯一Group不再建组且解组后的多选不被ShiftG重新建组', async ({ page, workspace }) => {
  const f = await fiveMembers(page, workspace);
  await f.visuals.shape.click();
  const commands: any[] = [];
  page.on('request', request => { if (request.url().endsWith('/api/mapping/execute') && request.method() === 'POST') commands.push(request.postDataJSON()); });
  expect(await f.visuals.card.evaluate(element => element.dispatchEvent(new KeyboardEvent('keydown', { key: 'g', metaKey: true, bubbles: true, cancelable: true })))).toBe(true);
  expect(commands).toEqual([]); expect(await workspace.state()).toEqual(f.before);
  await page.getByRole('button', { name: '取消组合', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('已保存到本机');
  const before = await workspace.state(), historyUrl = workspace.origin + '/api/mapping/projects/' + before.project.id + '/history';
  const timeline = await (await page.request.get(historyUrl)).json(); commands.length = 0;
  await expect(page.getByRole('button', { name: '组合所选对象', exact: true })).toBeEnabled();
  expect(await f.visuals.card.evaluate(element => element.dispatchEvent(new KeyboardEvent('keydown', { key: 'G', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true })))).toBe(true);
  await f.visuals.card.focus(); await page.keyboard.press('Meta+Shift+g');
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  expect(commands).toEqual([]); expect(await workspace.state()).toEqual(before);
  expect(await (await page.request.get(historyUrl)).json()).toEqual(timeline);
  await expect(page.locator('.react-flow__node.selected')).toHaveCount(5);
});

test('D414写字板editable内真实组合键不修改所选Group', async ({ page, workspace }) => {
  const f = await fiveMembers(page, workspace);
  await page.getByRole('button', { name: '编辑正文', exact: true }).click();
  await page.locator('.react-flow__pane').click({ position: { x: 20, y: 20 } });
  await expect(page.locator('.react-flow__node.selected')).toHaveCount(0);
  await f.visuals.shape.click();
  await expect(page.getByRole('button', { name: '取消组合', exact: true })).toBeEnabled();
  const before = await workspace.state(), historyUrl = workspace.origin + '/api/mapping/projects/' + before.project.id + '/history';
  const timeline = await (await page.request.get(historyUrl)).json(), commands: any[] = [];
  page.on('request', request => { if (request.url().endsWith('/api/mapping/execute') && request.method() === 'POST') commands.push(request.postDataJSON()); });
  const editor = page.getByLabel('卡片正文', { exact: true }); await editor.focus();
  await expect(editor).toBeFocused(); await expect(page.locator('.react-flow__node.selected')).toHaveCount(5);
  for (const modifier of ['Meta', 'Control']) {
    await page.keyboard.press(modifier + '+g'); await page.keyboard.press(modifier + '+Shift+g');
  }
  expect(commands).toEqual([]); expect(await workspace.state()).toEqual(before);
  expect(await (await page.request.get(historyUrl)).json()).toEqual(timeline);
  await expect(page.locator('.react-flow__node.selected')).toHaveCount(5);
});

test('D414结构命令已确认但补读失败时组合键零新增请求且重试只读', async ({ page, workspace }) => {
  const f = await fiveMembers(page, workspace), projectId = f.before.project.id;
  await f.visuals.shape.click();
  let applied = false, failRead = true;
  const commands: any[] = [];
  page.on('request', request => { if (request.url().endsWith('/api/mapping/execute') && request.method() === 'POST') commands.push(request.postDataJSON()); });
  await page.route('**/api/mapping/execute', async route => {
    if (route.request().postDataJSON().type !== 'group.ungroup') { await route.continue(); return; }
    const response = await route.fetch(); expect(response.status()).toBe(200); applied = true; await route.fulfill({ response });
  });
  await page.route('**/api/mapping/projects/' + projectId + '/map?**', async route => {
    if (applied && failRead && new URL(route.request().url()).searchParams.get('view') === 'index') { failRead = false; await route.abort('connectionreset'); }
    else await route.continue();
  });
  try {
    await page.getByRole('button', { name: '取消组合', exact: true }).click();
    const retry = page.getByRole('button', { name: '重试保存', exact: true }); await expect(retry).toBeVisible();
    const committed = await workspace.state(), historyUrl = workspace.origin + '/api/mapping/projects/' + projectId + '/history';
    const timeline = await (await page.request.get(historyUrl)).json();
    expect(committed.groups).toEqual([]); expect(commands.map(command => command.type)).toEqual(['group.ungroup']);
    await f.visuals.card.focus();
    for (const modifier of ['Meta', 'Control']) {
      await page.keyboard.press(modifier + '+g'); await page.keyboard.press(modifier + '+Shift+g');
    }
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    expect(commands.map(command => command.type)).toEqual(['group.ungroup']);
    expect(await workspace.state()).toEqual(committed); expect(await (await page.request.get(historyUrl)).json()).toEqual(timeline);
    await retry.click(); await expect(retry).toHaveCount(0);
    await expect(page.getByRole('button', { name: '组合所选对象', exact: true })).toBeEnabled();
    expect(commands.map(command => command.type)).toEqual(['group.ungroup']);
    expect(await workspace.state()).toEqual(committed); expect(await (await page.request.get(historyUrl)).json()).toEqual(timeline);
  } finally { await page.unrouteAll({ behavior: 'wait' }); }
});


test('D414两个loose Card的可组合选区在真实卡片菜单内组合键零写', async ({ page, workspace }) => {
  const projectId = (await workspace.state()).project.id;
  const definitions = [{ id: 'shortcut-menu-a', title: '菜单快捷键甲', x: 100 }, { id: 'shortcut-menu-b', title: '菜单快捷键乙', x: 500 }];
  const layouts = definitions.map(value => page.waitForResponse(response => response.url().endsWith('/api/mapping/execute') &&
    response.request().postDataJSON()?.type === 'card.layout' && response.request().postDataJSON()?.payload.id === value.id));
  for (const value of definitions) await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'thought.create', expected: null,
    payload: { ...value, text: value.title + '正文保持', y: 120 } });
  await page.reload(); for (const layout of layouts) expect((await layout).status()).toBe(200);
  await expect(page.getByRole('status')).toHaveText('已保存到本机');
  await page.getByRole('button', { name: definitions[0]!.title, exact: true }).click();
  await page.getByRole('button', { name: definitions[1]!.title, exact: true }).click({ modifiers: ['Shift'] });
  const before = await workspace.state(), historyUrl = workspace.origin + '/api/mapping/projects/' + projectId + '/history';
  expect(before.cards).toHaveLength(2); expect(before.groups).toEqual([]);
  const ids = before.cards.map(value => value.item.id).sort();
  await expect.poll(() => page.locator('.react-flow__node.selected').evaluateAll(nodes => nodes.map(node => (node as HTMLElement).dataset.id!).sort())).toEqual(ids);
  await expect(page.getByRole('button', { name: '组合所选对象', exact: true })).toBeEnabled();
  const timeline = await (await page.request.get(historyUrl)).json(), commands: any[] = [];
  page.on('request', request => { if (request.url().endsWith('/api/mapping/execute') && request.method() === 'POST') commands.push(request.postDataJSON()); });
  const toolbars = page.getByRole('toolbar', { name: '卡片操作', exact: true }); await expect(toolbars).toHaveCount(2);
  await toolbars.nth(0).getByRole('button', { name: '更多', exact: true }).click();
  const menu = page.getByRole('dialog', { name: '更多', exact: true }); await expect(menu).toHaveCount(1); await expect(menu).toBeVisible();
  await expect.poll(() => page.locator('.react-flow__node.selected').evaluateAll(nodes => nodes.map(node => (node as HTMLElement).dataset.id!).sort())).toEqual(ids);
  await expect(page.getByRole('button', { name: '组合所选对象', exact: true })).toBeEnabled();
  const close = menu.getByRole('button', { name: '关闭卡片菜单', exact: true });
  for (const modifier of ['Meta', 'Control']) {
    for (const action of ['+g', '+Shift+g']) {
      await close.focus(); await expect(close).toBeFocused(); await page.keyboard.press(modifier + action);
    }
  }
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  expect(commands).toEqual([]); expect(await workspace.state()).toEqual(before);
  expect(await (await page.request.get(historyUrl)).json()).toEqual(timeline);
  await expect(menu).toBeVisible();
  await expect.poll(() => page.locator('.react-flow__node.selected').evaluateAll(nodes => nodes.map(node => (node as HTMLElement).dataset.id!).sort())).toEqual(ids);
});
