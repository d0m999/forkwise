import { test, expect, place } from './writing-board-fixture';

function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

test('正文原生文本undo/redo一次按键只走文本，保存和重绘保持原生缓冲', async ({ page, workspace }) => {
  await place(page, '原生正文', 80, 120);
  await page.getByRole('button', { name: '编辑正文', exact: true }).click();
  const editor = page.getByRole('textbox', { name: '卡片正文', exact: true });
  const requests: string[] = [];
  page.on('request', r => { if (r.url().endsWith('/api/mapping/execute')) requests.push(r.postDataJSON().type); });
  await editor.pressSequentially('native');
  await expect(page.getByRole('status')).toHaveText('已保存到本机');
  await editor.press('Meta+z');
  await expect(editor).toHaveText('');
  await editor.press('Meta+Shift+z');
  await expect(editor).toHaveText('native');
  await expect(page.getByRole('status')).toHaveText('已保存到本机');
  expect(requests).not.toContain('history.undo');
  expect(requests).not.toContain('history.redo');
  expect((await workspace.state()).cards).toHaveLength(1);
});

test('多选中删除当前卡后剩余单卡属于系统选区清理，不自动切卡；明确点击才跟随', async ({ page, workspace }) => {
  await place(page, '待删除甲', 80, 120);
  await place(page, '保留乙', 400, 120);
  await page.getByRole('button', { name: '待删除甲', exact: true }).click();
  await page.locator('.react-flow__node').filter({ has: page.getByRole('button', { name: '待删除甲', exact: true }) }).getByRole('button', { name: '编辑正文', exact: true }).click();
  await page.getByRole('button', { name: '保留乙', exact: true }).click({ modifiers: ['Shift'] });
  await expect(page.locator('.react-flow__node.selected')).toHaveCount(2);
  await expect(page.locator('.body-editor h2')).toHaveText('正在编辑：待删除甲');
  await page.getByRole('toolbar', { name: '卡片操作', exact: true }).first().getByRole('button', { name: '更多', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '更多', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '删除卡片', exact: true }).click();
  await expect(page.getByLabel('已删除卡片')).toBeVisible();
  await expect(page.locator('.body-editor h2')).toHaveText('正在编辑：待删除甲');
  await expect(page.locator('.react-flow__node.selected')).toHaveCount(1);
  await page.getByRole('button', { name: '撤销删除', exact: true }).click();
  await expect(page.locator('.react-flow__node')).toHaveCount(2);
  await expect(page.locator('.body-editor h2')).toHaveText('正在编辑：待删除甲');
  await page.getByRole('button', { name: '保留乙', exact: true }).click();
  await expect(page.locator('.body-editor h2')).toHaveText('正在编辑：保留乙');
  expect((await workspace.state()).cards).toHaveLength(2);
});

test('合成中文composition不拆组合，Enter/Esc优先，关闭只收起并由同Body恢复', async ({ page, workspace }) => {
  await place(page, '中文组合', 80, 120);
  await page.getByRole('button', { name: '编辑正文', exact: true }).click();
  const editor = page.getByRole('textbox', { name: '卡片正文', exact: true });
  await editor.click();
  await editor.dispatchEvent('compositionstart');
  await page.keyboard.insertText('中文组合输入');
  await editor.dispatchEvent('keydown', { key: 'Enter', keyCode: 229, isComposing: true });
  await editor.dispatchEvent('keydown', { key: 'Escape', keyCode: 229, isComposing: true });
  await page.waitForTimeout(2200);
  expect((await workspace.state()).cards[0]!.body.blocks[0]!.text).toBe('');
  await expect(editor).toBeFocused();
  await editor.dispatchEvent('compositionend');
  await page.getByRole('button', { name: '关闭正文' }).click();
  await expect(page.locator('.body-editor')).toHaveCount(0);
  await expect.poll(async () => (await workspace.state()).cards[0]!.body.blocks.map(b => b.text)).toEqual(['中文组合输入']);
  await page.getByRole('button', { name: '编辑正文', exact: true }).click();
  await expect(editor).toHaveText('中文组合输入');
  await expect(editor).not.toBeFocused();
});

test('段落原请求丢ACK、切卡和关闭保持原卡绑定，重开明确恢复保留完整块和身份', async ({ page, workspace }) => {
  const project = (await workspace.state()).project.id;
  for (const [id, x] of [['a', 80], ['b', 400]] as const)
    await workspace.execute(page, { commandId: crypto.randomUUID(), projectId: project, type: 'thought.create', expected: null, payload: { id, title: id, text: '初始' + id, x, y: 120 } });
  await page.getByRole('button', { name: 'a', exact: true }).click();
  await page.locator('.react-flow__node').filter({ has: page.getByRole('button', { name: 'a', exact: true }) }).getByRole('button', { name: '编辑正文', exact: true }).click();
  const editor = page.getByRole('textbox', { name: '卡片正文', exact: true });
  const ack = gate(); let written = false, first: Record<string, any> | undefined;
  await page.route('**/api/mapping/execute', async route => {
    const command = route.request().postDataJSON();
    if (command.type !== 'body.edit' || first) return route.continue();
    first = command; const response = await route.fetch(); written = true;
    await ack.promise; await route.fulfill({ response });
  });
  try {
    await editor.click(); await editor.press('End'); await editor.press('Enter'); await page.keyboard.insertText('甲第二段');
    await expect.poll(() => written).toBe(true);
    await page.getByRole('button', { name: 'b', exact: true }).click();
    ack.release();
    await expect(page.locator('.body-editor h2')).toHaveText('正在编辑：b');
    await expect(editor).toHaveText('初始b');
    expect((await workspace.state()).cards.find(c => c.id === 'a')!.body.blocks.map(b => b.text)).toEqual(['初始a', '甲第二段']);
    expect((await workspace.state()).cards.find(c => c.id === 'b')!.body.blocks.map(b => b.text)).toEqual(['初始b']);
    await editor.press('End'); await editor.press('Enter'); await page.keyboard.insertText('乙待恢复段落');
    await page.route('**/api/mapping/execute', route => route.request().postDataJSON().type === 'body.edit' ? route.abort('failed') : route.continue());
    await page.getByRole('button', { name: '关闭正文' }).click();
    await expect(page.getByRole('status')).toHaveText('保存未完成');
    await page.unrouteAll({ behavior: 'wait' });
    await page.reload();
    await expect(page.getByRole('button', { name: '恢复草稿', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '恢复草稿', exact: true }).click();
    await expect.poll(async () => (await workspace.state()).cards.find(c => c.id === 'b')!.body.blocks.map(b => b.text)).toEqual(['初始b', '乙待恢复段落']);
    const saved = (await workspace.state()).cards.find(c => c.id === 'b')!.body.blocks;
    await workspace.restart(); await workspace.open(page);
    expect((await workspace.state()).cards.find(c => c.id === 'b')!.body.blocks).toEqual(saved);
  } finally { ack.release(); await page.unrouteAll({ behavior: 'wait' }); }
});

test('删除请求真实版本竞争失败不显示已删，重读后的明确删除仍可执行', async ({ page, workspace }) => {
  await place(page, '删除竞争', 80, 120);
  await page.getByRole('button', { name: '编辑正文', exact: true }).click();
  const state = await workspace.state(), card = state.cards[0]!;
  const paused = gate(); let captured = false, first = true;
  await page.route('**/api/mapping/execute', async route => {
    if (route.request().postDataJSON().type !== 'thought.delete' || !first) return route.continue();
    first = false; captured = true; await paused.promise; await route.continue();
  });
  try {
    await page.getByRole('button', { name: '删除竞争', exact: true }).click();
    await page.getByRole('button', { name: '更多', exact: true }).click();
    await page.getByRole('button', { name: '删除卡片', exact: true }).click();
    await expect.poll(() => captured).toBe(true);
    await workspace.execute(page, { commandId: crypto.randomUUID(), projectId: state.project.id, type: 'thought.title', expected: card.versionId, payload: { id: card.id, title: '竞争后的原卡' } });
    paused.release();
    await expect(page.getByRole('alert')).toContainText('删除依据已更新');
    await expect(page.getByLabel('已删除卡片')).toHaveCount(0);
    await expect(page.locator('.react-flow__node')).toHaveCount(1);
    await expect(page.getByRole('button', { name: '竞争后的原卡', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '更多', exact: true }).click();
    await page.getByRole('button', { name: '删除卡片', exact: true }).click();
    await expect(page.getByLabel('已删除卡片')).toBeVisible();
  } finally { paused.release(); await page.unrouteAll({ behavior: 'wait' }); }
});


test('删除后的晚到正文请求不复活，直接撤销不把旧草稿或旧ACK当成保存成功', async ({ page, workspace }) => {
  await place(page, '晚到删除', 80, 120);
  await page.getByRole('button', { name: '编辑正文', exact: true }).click();
  const paused = gate(); let captured = false;
  await page.route('**/api/mapping/execute', async route => {
    if (route.request().postDataJSON().type !== 'body.edit') return route.continue();
    captured = true; await paused.promise; await route.continue();
  });
  try {
    const editor = page.getByRole('textbox', { name: '卡片正文', exact: true });
    await editor.fill('保留但未保存的旧稿');
    await expect.poll(() => captured).toBe(true);
    const state = await workspace.state(), card = state.cards[0]!;
    await workspace.execute(page, { commandId: crypto.randomUUID(), projectId: state.project.id, type: 'thought.delete', expected: { thought: card.versionId, body: card.body.versionId, pose: card.item.versionId, appearance: card.appearance?.versionId ?? null }, payload: { id: card.id } });
    await expect(page.getByLabel('已删除卡片')).toBeVisible();
    paused.release();
    await expect(page.getByRole('status')).toHaveText('保存未完成');
    expect((await workspace.state()).cards).toHaveLength(0);
    await expect(editor).toHaveText('保留但未保存的旧稿');
    await page.getByRole('button', { name: '撤销删除', exact: true }).click();
    await expect(page.getByLabel('已删除卡片')).toHaveCount(0);
    await expect(page.getByRole('status')).toHaveText('保存未完成');
    await expect(editor).toHaveText('保留但未保存的旧稿');
    expect((await workspace.state()).cards[0]!.body.blocks.map(b => b.text)).toEqual(['']);
    await expect(page.getByRole('button', { name: '重试保存', exact: true })).toBeVisible();
  } finally { paused.release(); await page.unrouteAll({ behavior: 'wait' }); }
});


test('保存已真实成功但ACK在途时被外部删除，迟到ACK不得丢掉删除面板的当前完整内容', async ({ page, workspace }) => {
  await place(page, 'ACK在途删除', 80, 120);
  await page.getByRole('button', { name: '编辑正文', exact: true }).click();
  const editor = page.getByRole('textbox', { name: '卡片正文', exact: true });
  await editor.fill('已成功保存的第一段'); await editor.press('End'); await editor.press('Enter'); await page.keyboard.insertText('已成功保存的第二段');
  await expect(page.getByRole('status')).toHaveText('已保存到本机');
  const ack = gate(), reads = gate(); let written = false;
  await page.route('**/api/mapping/projects/*/map?*', async route => { await reads.promise; await route.continue(); });
  await page.route('**/api/mapping/execute', async route => {
    if (route.request().postDataJSON().type !== 'body.edit') return route.continue();
    const response = await route.fetch(); written = true; await ack.promise; await route.fulfill({ response });
  });
  try {
    await editor.press('End'); await page.keyboard.insertText('尾');
    await expect.poll(() => written).toBe(true);
    const state = await workspace.state(), card = state.cards[0]!;
    expect(card.body.blocks.map(b => b.text)).toEqual(['已成功保存的第一段', '已成功保存的第二段尾']);
    await workspace.execute(page, { commandId: crypto.randomUUID(), projectId: state.project.id, type: 'thought.delete', expected: { thought: card.versionId, body: card.body.versionId, pose: card.item.versionId, appearance: card.appearance?.versionId ?? null }, payload: { id: card.id } });
    ack.release(); reads.release();
    await expect(page.getByLabel('已删除卡片')).toBeVisible();
    await expect(page.getByRole('status')).toHaveText('已保存到本机');
    await expect(editor).toHaveText('已成功保存的第一段已成功保存的第二段尾');
    await expect(editor).not.toBeEditable();
    expect((await workspace.state()).cards).toHaveLength(0);
    await page.getByRole('button', { name: '撤销删除', exact: true }).click();
    await expect(editor).toBeEditable();
    expect((await workspace.state()).cards[0]!.body.blocks).toEqual(card.body.blocks);
  } finally { ack.release(); reads.release(); await page.unrouteAll({ behavior: 'wait' }); }
});
