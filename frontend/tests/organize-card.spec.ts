import { expect, place, test } from './writing-board-fixture';

test('AI 整理从卡片菜单选择范围，审阅后添加并在重开保留归属', async ({ page, workspace }, info) => {
  await place(page, '供应链观察');
  const source = (await workspace.state()).cards[0]!;
  const trigger = page.getByRole('button', { name: 'AI', exact: true });
  await trigger.focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'AI 整理' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button', { name: '用本机模型整理' })).toBeDisabled();
  await expect(dialog.getByRole('button', { name: '试用模拟整理' })).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await page.keyboard.press('Enter');
  await page.keyboard.press('Tab');
  await expect(dialog.getByRole('checkbox', { name: /卡片标题/ })).toBeFocused();
  await page.keyboard.press('Space');
  await dialog.getByRole('button', { name: '试用模拟整理' }).click();
  await expect(dialog.getByRole('heading', { name: '模拟整理：供应链观察' })).toBeVisible();
  expect((await workspace.state()).cards).toHaveLength(1);
  await page.screenshot({ path: info.outputPath('organize-review.png') });
  await dialog.getByRole('button', { name: '添加为新卡' }).click();
  await expect(dialog.getByText('已添加为新卡', { exact: false })).toBeVisible();
  await dialog.getByRole('button', { name: '关闭 AI 整理' }).click();
  const saved = await workspace.state();
  expect(saved.cards).toHaveLength(2);
  expect(saved.cards[0]!.body).toEqual(source.body);
  expect(saved.cards[1]).toMatchObject({ aiOrigin: { mode: 'simulate', taskId: expect.any(String) } });
  await expect(page.locator('.card-ai-origin')).toHaveText('模拟整理');
  await page.goto('about:blank');
  await workspace.restart();
  await workspace.open(page);
  await expect(page.locator('.card-ai-origin')).toHaveText('模拟整理');
  await expect(page.getByRole('button', { name: '模拟整理：供应链观察', exact: true })).toBeVisible();
  expect((await workspace.state()).cards[1]!.aiOrigin).toEqual(saved.cards[1]!.aiOrigin);
  await page.getByRole('button', { name: '模拟整理：供应链观察', exact: true }).click();
  await page.keyboard.press('ControlOrMeta+d');
  await expect.poll(async () => (await workspace.state()).cards.length).toBe(3);
  const copy = (await workspace.state()).cards.find(card => !saved.cards.some(item => item.id === card.id));
  expect(copy?.aiOrigin).toEqual({ mode: 'simulate' });
  workspace.removeCard(source.id);
  await expect(page.getByRole('button', { name: '供应链观察', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '项目导航' }).click();
  await page.getByRole('button', { name: 'AI 整理记录', exact: true }).click();
  const records = page.getByRole('dialog', { name: 'AI 整理记录' });
  await expect(records.getByText('原卡已删除，仍可查看旧结果。')).toBeVisible();
  await expect(records.getByRole('heading', { name: '模拟整理：供应链观察' })).toBeVisible();
  await expect(records.getByRole('button', { name: '添加为新卡' })).toHaveCount(0);
});

test('无标题卡可整理所选列表和引用，保留未选正文', async ({ page, workspace }) => {
  await place(page, '');
  await page.getByRole('button', { name: '编辑正文', exact: true }).click();
  const editor = page.getByRole('textbox', { name: '卡片正文', exact: true });
  await editor.click();
  await editor.evaluate(element => {
    const clipboardData = new DataTransfer();
    clipboardData.setData('text/plain', '交期延长\n等待公司确认\n内部备注');
    clipboardData.setData('text/html', '<ul><li><strong>交期延长</strong></li></ul><blockquote>等待公司确认</blockquote><h2>内部备注</h2>');
    element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData }));
  });
  await expect.poll(async () => (await workspace.state()).cards[0]!.body.blocks
    .map(({ type, text }) => [type, text])).toEqual([
    ['listItem', '交期延长'], ['quote', '等待公司确认'], ['heading', '内部备注'],
  ]);
  const { project, cards: [source] } = await workspace.state();
  expect(source!.title).toBe('');
  await page.getByRole('button', { name: '关闭正文', exact: true }).click();
  await page.getByRole('button', { name: '未命名卡片', exact: true }).click();
  await page.getByRole('button', { name: 'AI', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'AI 整理' });
  await expect(dialog.getByRole('checkbox', { name: /卡片标题/ })).toHaveCount(0);
  const simulate = dialog.getByRole('button', { name: '试用模拟整理' });
  await expect(simulate).toBeDisabled();
  await dialog.getByRole('checkbox', { name: '列表项 1' }).check();
  await dialog.getByRole('checkbox', { name: '引用 2' }).check();
  await expect(dialog.getByRole('checkbox', { name: '正文标题 3' })).not.toBeChecked();
  const started = page.waitForResponse(response =>
    response.request().method() === 'POST' &&
    new URL(response.url()).pathname === `/api/mapping/projects/${project.id}/organize/tasks`);
  await simulate.click();
  const response = await started;
  expect(response.status()).toBe(201);
  expect((await response.json()).input).toEqual({
    cardId: source!.id, thoughtVersionId: source!.versionId, bodyVersionId: source!.body.versionId,
    title: null, omittedBlockCount: 1,
    blocks: [
      { id: source!.body.blocks[0]!.id, text: '交期延长' },
      { id: source!.body.blocks[1]!.id, text: '等待公司确认' },
    ],
  });
  await expect(dialog.getByRole('status')).toHaveText('模拟整理 可以审阅');
  await expect(dialog.getByRole('article')).toContainText('交期延长');
  await expect(dialog.getByRole('article')).toContainText('等待公司确认');
  await expect(dialog.getByRole('article')).not.toContainText('内部备注');
  expect((await workspace.state()).cards.map(card => card.body)).toEqual([source!.body]);

  const add = dialog.getByRole('button', { name: '添加为新卡' });
  await add.click();
  await expect(dialog.getByText('已添加为新卡', { exact: false })).toBeVisible();
  const firstCandidate = (await workspace.state()).cards.find(card => card.id !== source!.id)!;
  await dialog.getByRole('button', { name: '关闭 AI 整理' }).click();
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect.poll(async () => (await workspace.state()).cards.length).toBe(1);
  const historyUrl = `${workspace.origin}/api/mapping/projects/${project.id}/history`;
  const beforeMove = await page.request.get(historyUrl);
  expect(await beforeMove.json()).toMatchObject({ redo: [expect.objectContaining({ label: 'organize.add' })] });
  await workspace.execute(page, {
    commandId: crypto.randomUUID(), projectId: project.id, type: 'pose.move', expected: source!.item.versionId,
    payload: { id: source!.id, x: source!.item.pose.x + 32, y: source!.item.pose.y },
  });
  const afterMove = await page.request.get(historyUrl);
  expect(await afterMove.json()).toMatchObject({ redo: [] });
  await page.getByRole('button', { name: '未命名卡片', exact: true }).click();
  await page.getByRole('button', { name: 'AI', exact: true }).click();
  await add.click();
  await expect(dialog.getByText('已添加为新卡', { exact: false })).toBeVisible();
  const nextCandidate = (await workspace.state()).cards.find(card => card.id !== source!.id)!;
  expect(nextCandidate.id).not.toBe(firstCandidate.id);
  expect(nextCandidate.aiOrigin).toEqual(firstCandidate.aiOrigin);
});

test('原卡删除后仍可确认已提交的添加回执，沿用原命令号', async ({ page, workspace }) => {
  await place(page, '原卡');
  const { project, cards: [source] } = await workspace.state();
  await page.getByRole('button', { name: 'AI', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'AI 整理' });
  await dialog.getByRole('checkbox', { name: /卡片标题/ }).check();
  await dialog.getByRole('button', { name: '试用模拟整理' }).click();
  const commands: string[] = [];
  await page.route('**/api/mapping/execute', async route => {
    const command = route.request().postDataJSON();
    if (command.type !== 'organize.add') return route.continue();
    commands.push(command.commandId);
    if (commands.length > 1) return route.continue();
    const committed = await route.fetch();
    expect(committed.ok()).toBe(true);
    await route.abort();
  });
  await dialog.getByRole('button', { name: '添加为新卡' }).click();
  await expect(dialog.getByRole('alert')).toContainText('未确认画布更新');
  const candidate = (await workspace.state()).cards.find(card => card.id !== source!.id)!;
  expect(candidate.aiOrigin).toMatchObject({ mode: 'simulate' });
  await workspace.execute(page, {
    commandId: crypto.randomUUID(), projectId: project.id, type: 'thought.delete',
    expected: { thought: source!.versionId, body: source!.body.versionId, pose: source!.item.versionId, appearance: null },
    payload: { id: source!.id },
  });
  await expect(dialog.getByText('原卡已删除，仍可查看旧结果。')).toBeVisible();
  await dialog.getByRole('button', { name: '确认添加结果' }).click({ timeout: 3000 });
  await expect(dialog.getByText('已添加为新卡', { exact: false })).toBeVisible();
  expect(commands).toEqual([commands[0], commands[0]]);
  expect((await workspace.state()).cards.map(card => card.id)).toEqual([candidate.id]);
});

test('整理范围排除整篇正文中无法解析父项的旧列表块', async ({ page, workspace }) => {
  await place(page, '旧正文');
  const source = (await workspace.state()).cards[0]!;
  await workspace.installOriginalBody(source.id, [
    { id: 'visible-text', type: 'text', text: '可整理段落' },
    { id: 'orphan-list', type: 'listItem', listType: 'bullet', parentId: 'unknown', text: '旧列表原件' },
  ]);
  await workspace.open(page);
  await page.getByRole('button', { name: '旧正文', exact: true }).click();
  await page.getByRole('button', { name: 'AI', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'AI 整理' });
  const { project, cards: [card] } = await workspace.state();
  const rejected = await page.request.post(`${workspace.origin}/api/mapping/projects/${project.id}/organize/tasks`, {
    headers: { Origin: workspace.origin },
    data: {
      mode: 'simulate', requestId: crypto.randomUUID(), cardId: card!.id, thoughtVersionId: card!.versionId,
      bodyVersionId: card!.body.versionId, includeTitle: false, blockIds: ['orphan-list'],
    },
  });
  await expect(dialog.getByRole('checkbox', { name: '段落 1' })).toBeVisible();
  expect({
    orphanCheckboxes: await dialog.getByRole('checkbox', { name: /列表项/ }).count(),
    serverCode: (await rejected.json()).code,
  }).toEqual({ orphanCheckboxes: 0, serverCode: 'ORGANIZE_INVALID_SCOPE' });
});

for (const sourceChanged of [false, true]) test(sourceChanged
  ? '预检取消收到原卡过时拒绝后结束等待'
  : '预检期间按 Esc 取消原请求，迟到的开始回执不覆盖取消结果', async ({ page, workspace }) => {
  await place(page, '准备整理');
  const { project, cards: [card] } = await workspace.state();
  const apiPath = `/api/mapping/projects/${project.id}/organize`;
  const task = {
    id: 'preflight-cancelled', cardId: card!.id, mode: 'real', model: 'local-test:1', attempt: 1,
    input: { cardId: card!.id, thoughtVersionId: card!.versionId, bodyVersionId: card!.body.versionId,
      title: card!.title, blocks: [], omittedBlockCount: card!.body.blocks.length },
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), output: null, outputAttempt: null,
    usage: null, attempts: [], error: null, freshness: 'current',
    applied: false, candidateOnCanvas: false, addAvailable: false, cutCopyAvailable: false,
  };
  let releaseStart!: () => void;
  const startHeld = new Promise<void>(resolve => { releaseStart = resolve; });
  await page.route(`**${apiPath}/status`, route => route.fulfill({ json: { model: task.model } }));
  await page.route(`**${apiPath}/tasks`, async route => {
    await startHeld;
    await route.fulfill({ json: { ...task, state: 'running' } });
  });
  await page.route(`**${apiPath}/tasks/cancel-start`, route => route.fulfill(sourceChanged
    ? { status: 409, json: { code: 'ORGANIZE_SOURCE_STALE', message: '原卡已更改或删除，请重新选择要整理的内容' } }
    : { json: { ...task, state: 'cancelled' } }));

  await page.getByRole('button', { name: 'AI', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'AI 整理' });
  await dialog.getByRole('checkbox', { name: /卡片标题/ }).check();
  const started = page.waitForRequest(request => new URL(request.url()).pathname === `${apiPath}/tasks`, { timeout: 5000 });
  await dialog.getByRole('button', { name: '用本机模型整理' }).click();
  const startRequest = await started;
  await expect(dialog.getByRole('status')).toHaveText('正在检查本机模型', { timeout: 3000 });
  await expect(dialog.getByRole('button', { name: '取消任务' })).toBeFocused();
  const cancelling = page.waitForRequest(request => new URL(request.url()).pathname === `${apiPath}/tasks/cancel-start`, { timeout: 5000 });
  await page.keyboard.press('Escape');
  expect((await cancelling).postDataJSON()).toEqual(startRequest.postDataJSON());
  if (sourceChanged) {
    await expect(dialog.getByRole('alert')).toHaveText('原卡已更改或删除，请重新选择要整理的内容');
    await expect(dialog.getByRole('button', { name: '取消任务' })).toHaveCount(0);
  } else {
    await expect(dialog.getByRole('status')).toHaveText('本机模型 已取消');
  }
  const lateStart = page.waitForResponse(response => response.request() === startRequest, { timeout: 5000 });
  releaseStart();
  expect(await (await lateStart).finished()).toBeNull();
  if (sourceChanged) {
    await expect(dialog.getByRole('alert')).toHaveText('原卡已更改或删除，请重新选择要整理的内容');
    await expect(dialog.getByRole('button', { name: '取消任务' })).toHaveCount(0);
  } else {
    await expect(dialog.getByRole('status')).toHaveText('本机模型 已取消');
    await expect(dialog.getByRole('button', { name: '重试整理' })).toBeEnabled();
  }
});

test('覆盖剪贴板且剪切退出撤销历史后可以另建候选卡', async ({ page, workspace }) => {
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await place(page, '候选来源');
  await page.getByRole('button', { name: 'AI', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'AI 整理' });
  await dialog.getByRole('checkbox', { name: /卡片标题/ }).check();
  await dialog.getByRole('button', { name: '试用模拟整理' }).click();
  await dialog.getByRole('button', { name: '添加为新卡' }).click();
  await expect(dialog.getByText('已添加为新卡', { exact: false })).toBeVisible();
  await dialog.getByRole('button', { name: '关闭 AI 整理' }).click();
  const { project, cards: [, candidate] } = await workspace.state();
  await page.getByRole('button', { name: '模拟整理：候选来源', exact: true }).click();
  await page.keyboard.press('ControlOrMeta+x');
  await expect.poll(async () => (await workspace.state()).cards.length).toBe(1);
  await page.evaluate(() => navigator.clipboard.writeText('其他内容'));
  for (let index = 0; index < 40; index++) {
    await workspace.execute(page, {
      commandId: crypto.randomUUID(), projectId: project.id, type: 'thought.create', expected: null,
      payload: { id: crypto.randomUUID(), title: '其他卡片', text: '', x: 4000, y: index * 250 },
    });
  }
  await page.getByRole('button', { name: '候选来源', exact: true }).click();
  await page.getByRole('button', { name: 'AI', exact: true }).click();
  await dialog.getByRole('button', { name: '另建候选卡' }).click({ timeout: 5000 });
  await expect(dialog.getByText('已添加为新卡', { exact: false })).toBeVisible();
  const [replacement] = (await workspace.state()).cards.filter(item => item.aiOrigin);
  expect(replacement?.id).not.toBe(candidate!.id);
  expect(replacement?.aiOrigin).toEqual(candidate!.aiOrigin);
});

test('取消回执丢失时保留当前请求，确认后才允许切换历史', async ({ page, workspace }) => {
  await place(page, '重试取消');
  const { project } = await workspace.state();
  const apiPath = `/api/mapping/projects/${project.id}/organize`;
  await page.route(`**${apiPath}/status`, route => route.fulfill({ json: { model: 'local-test:1' } }));
  await page.getByRole('button', { name: 'AI', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'AI 整理' });
  await dialog.getByRole('checkbox', { name: /卡片标题/ }).check();
  const first = page.waitForResponse(response => new URL(response.url()).pathname === `${apiPath}/tasks` &&
    response.request().method() === 'POST', { timeout: 5000 });
  await dialog.getByRole('button', { name: '试用模拟整理' }).click();
  const prior = await (await first).json();
  const history = dialog.getByRole('combobox', { name: '整理记录' });
  await history.selectOption('');

  let releaseStart!: () => void;
  const startHeld = new Promise<void>(resolve => { releaseStart = resolve; });
  const task = { ...prior, id: 'cancel-receipt', mode: 'real', model: 'local-test:1', state: 'cancelled',
    output: null, outputAttempt: null, addAvailable: false, attempts: [] };
  await page.route(`**${apiPath}/tasks`, async route => {
    await startHeld;
    await route.fulfill({ json: task });
  });
  const cancellations: unknown[] = [];
  await page.route(`**${apiPath}/tasks/cancel-start`, async route => {
    cancellations.push(route.request().postDataJSON());
    if (cancellations.length === 1) await route.abort();
    else await route.fulfill({ json: task });
  });

  await dialog.getByRole('button', { name: '用本机模型整理' }).click();
  const cancel = dialog.getByRole('button', { name: '取消任务' });
  await cancel.click();
  await expect(dialog.getByRole('status')).toHaveText('取消结果未确认');
  await expect(history).toBeDisabled({ timeout: 3000 });
  await cancel.click();
  releaseStart();
  await expect(dialog.getByRole('status')).toHaveText('本机模型 已取消');
  await expect(history).toBeEnabled();
  expect(cancellations).toEqual([expect.objectContaining({ requestId: expect.any(String) }), cancellations[0]]);
});
