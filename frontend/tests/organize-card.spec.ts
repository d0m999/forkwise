import { expect, place, test } from './writing-board-fixture';
import type { OrganizeTask } from '../../backend/src/mapping/organize-contracts';

test('AI 整理从卡片菜单选择范围，审阅后添加并在重开保留归属', async ({ page, workspace }, info) => {
  await place(page, '供应链观察');
  const source = (await workspace.state()).cards[0]!;
  const trigger = page.getByRole('button', { name: 'AI', exact: true });
  await trigger.focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'AI 整理' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button', { name: '用模型整理' })).toBeDisabled();
  await expect(dialog.getByRole('button', { name: '试用模拟整理' })).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await page.keyboard.press('Enter');
  await page.keyboard.press('Tab');
  await expect(dialog.getByRole('checkbox', { name: /卡片标题/ })).toBeFocused();
  await page.keyboard.press('Space');
  await expect(dialog.getByText(/OpenAI 尚未启用，可试用模拟整理/)).toBeVisible();
  await expect(dialog.getByRole('button', { name: '用模型整理' })).toBeDisabled();
  await expect(dialog.getByRole('button', { name: '试用模拟整理' })).toBeEnabled();
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

test('旧模型停用后仍可审阅原候选和选择添加，原模型重试显示停用原因', async ({ page, workspace }) => {
  await place(page, '历史来源');
  const { project, cards: [source] } = await workspace.state();
  const saved = {
    id: 'legacy-partial', cardId: source!.id, mode: 'real', model: 'qwen2.5:7b', attempt: 1,
    state: 'partial', createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:01:00Z',
    input: { cardId: source!.id, thoughtVersionId: source!.versionId, bodyVersionId: source!.body.versionId,
      title: source!.title, blocks: [], omittedBlockCount: source!.body.blocks.length },
    output: { candidate: { title: '旧候选', text: '历史整理结果' }, gaps: ['待补材料'] }, outputAttempt: 1,
    error: null, usage: null, attempts: [], freshness: 'current',
    applied: false, candidateOnCanvas: false, addAvailable: true, cutCopyAvailable: false,
  } satisfies OrganizeTask;
  const projectPath = `**/api/mapping/projects/${project.id}`;
  await page.route(`${projectPath}/cards/${source!.id}/organize/tasks`, route => route.fulfill({ json: [
    { id: saved.id, cardId: saved.cardId, mode: saved.mode, createdAt: saved.createdAt },
  ] }));
  await page.route(`${projectPath}/organize/tasks/${saved.id}`, route => route.fulfill({ json: saved }));

  await page.getByRole('button', { name: 'AI', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'AI 整理' });
  await expect(dialog.getByRole('option', { selected: true })).toHaveText(/^模型整理 /);
  await expect(dialog.getByRole('status')).toHaveText('模型整理 部分完成');
  await expect(dialog.getByRole('heading', { name: '旧候选' })).toBeVisible();
  await expect(dialog.getByRole('button', { name: '添加为新卡' })).toBeEnabled();
  await expect(dialog.getByRole('button', { name: '重试整理' })).toBeDisabled();
  await expect(dialog.getByText('这条记录使用的模型当前不可用，无法重试。')).toBeVisible();
  await dialog.getByText('输入范围与用量', { exact: true }).click();
  await expect(dialog.getByText('模型 qwen2.5:7b。费用未知。')).toBeVisible();
});

test('审阅 OpenAI 回执时逐次显示缓存命中与供应商请求号', async ({ page, workspace }) => {
  await place(page, '回执样例');
  const { project, cards: [source] } = await workspace.state();
  const model = 'openai/gpt-4.1-mini-2025-04-14';
  const createdAt = '2026-11-21T00:00:00Z';
  const history = { id: 'openai-receipt', mode: 'real', createdAt, cardId: source!.id } as const;
  const counts = { model, inputTokens: 2048, outputTokens: 18, responseReceived: true };
  const usage = { cost: null, attempts: [
    { ...counts, phase: 'generate', cachedInputTokens: 1024, providerRequestId: 'req_first' },
    { ...counts, phase: 'repair', cachedInputTokens: 0, providerRequestId: 'req_second' },
  ] } as const;
  const path = `**/api/mapping/projects/${project.id}`;
  await page.route(`${path}/cards/${source!.id}/organize/tasks`, route => route.fulfill({ json: [history] }));
  await page.route(`${path}/organize/tasks/${history.id}`, route => route.fulfill({ json: {
    ...history, model, attempt: 2, state: 'failed', updatedAt: createdAt,
    input: { cardId: source!.id, thoughtVersionId: source!.versionId, bodyVersionId: source!.body.versionId,
      title: source!.title, blocks: [], omittedBlockCount: 0 },
    output: null, outputAttempt: null, error: null, usage, freshness: 'current',
    attempts: [
      { number: 1, state: 'failed', requestedAt: createdAt, finishedAt: createdAt, error: null, output: null,
        usage: { cost: null, attempts: [{ ...counts, phase: 'generate' }] } },
      { number: 2, state: 'failed', requestedAt: createdAt, finishedAt: createdAt, error: null, output: null, usage },
    ],
    applied: false, candidateOnCanvas: false, addAvailable: false, cutCopyAvailable: false,
  } }));
  await page.getByRole('button', { name: 'AI', exact: true }).click();
  const details = page.getByRole('dialog', { name: 'AI 整理' }).locator('details').filter({ hasText: '输入范围与用量' });
  await details.locator('summary').first().click();
  await expect(details.getByText(/缓存命中 1024 token.*req_first/)).toBeVisible({ timeout: 3000 });
  await expect(details.getByText(/缓存命中 0 token.*req_second/)).toBeVisible();
  await expect(details.getByText(/缓存命中未知/)).toBeVisible();
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
    id: 'preflight-cancelled', cardId: card!.id, mode: 'real', model: 'test-model', attempt: 1,
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
  await dialog.getByRole('button', { name: '用模型整理' }).click();
  const startRequest = await started;
  await expect(dialog.getByRole('status')).toHaveText('正在检查整理模型', { timeout: 3000 });
  await expect(dialog.getByRole('button', { name: '取消任务' })).toBeFocused();
  const cancelling = page.waitForRequest(request => new URL(request.url()).pathname === `${apiPath}/tasks/cancel-start`, { timeout: 5000 });
  await page.keyboard.press('Escape');
  expect((await cancelling).postDataJSON()).toEqual(startRequest.postDataJSON());
  if (sourceChanged) {
    await expect(dialog.getByRole('alert')).toHaveText('原卡已更改或删除，请重新选择要整理的内容');
    await expect(dialog.getByRole('button', { name: '取消任务' })).toHaveCount(0);
  } else {
    await expect(dialog.getByRole('status')).toHaveText('模型整理 已取消');
  }
  const lateStart = page.waitForResponse(response => response.request() === startRequest, { timeout: 5000 });
  releaseStart();
  expect(await (await lateStart).finished()).toBeNull();
  if (sourceChanged) {
    await expect(dialog.getByRole('alert')).toHaveText('原卡已更改或删除，请重新选择要整理的内容');
    await expect(dialog.getByRole('button', { name: '取消任务' })).toHaveCount(0);
  } else {
    await expect(dialog.getByRole('status')).toHaveText('模型整理 已取消');
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
  await expect.poll(async () => (await workspace.state()).cards.map(card => card.id)).not.toContain(candidate!.id);
  await expect.poll(() => page.evaluate(async () => (await navigator.clipboard.read()).flatMap(item => item.types)))
    .toContain('web application/x-forkwise-canvas');
  await page.evaluate(() => navigator.clipboard.writeText('其他内容'));
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('其他内容');
  expect(await page.evaluate(async () => (await navigator.clipboard.read()).flatMap(item => item.types))).toEqual(['text/plain']);
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

for (const reopenFrom of ['卡片', '刷新后从卡片', '旧记录损坏后刷新从卡片', '项目记录', '存储拒写的卡片', '无法清除旧记录的卡片']) test(`取消未确认时从${reopenFrom}重开，仍能按原请求取消`, async ({ page, workspace }) => {
  await place(page, '重试取消');
  const corruptStorage = reopenFrom === '旧记录损坏后刷新从卡片';
  const reloadFromCard = corruptStorage || reopenFrom === '刷新后从卡片';
  if (corruptStorage) {
    await page.evaluate(() => sessionStorage.setItem('forkwise.organize-cancellation.v1', '['));
    await page.reload();
    await expect(page.getByRole('status')).toHaveText('已保存到本机');
    await page.getByRole('button', { name: '重试取消', exact: true }).click();
  }
  const storageDenied = reopenFrom === '存储拒写的卡片';
  const cannotClear = reopenFrom === '无法清除旧记录的卡片';
  const denyStorage = (operation: 'setItem' | 'removeItem') => page.evaluate(method => {
    const original = Storage.prototype[method];
    Storage.prototype[method] = function (this: Storage, key: string, ...args: string[]) {
      if (this === window.sessionStorage && key === 'forkwise.organize-cancellation.v1')
        throw new DOMException('标签页存储拒绝更改', 'SecurityError');
      return Reflect.apply(original, this, [key, ...args]);
    };
  }, operation);
  if (storageDenied) await denyStorage('setItem');
  const storageWarning = '当前标签页无法保存这次取消请求，请保持页面打开并重试取消。';
  const { project } = await workspace.state();
  const apiPath = `/api/mapping/projects/${project.id}/organize`;
  await page.route(`**${apiPath}/status`, route => route.fulfill({ json: { model: 'test-model' } }));
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
  const task = { ...prior, id: 'cancel-receipt', mode: 'real', model: 'test-model', state: 'cancelled',
    output: null, outputAttempt: null, addAvailable: false, attempts: [] };
  await page.route(`**${apiPath}/tasks`, async route => {
    if (route.request().method() !== 'POST' || route.request().postDataJSON().mode !== 'real') return route.continue();
    await startHeld;
    await route.fulfill({ json: task });
  });
  const cancellations: unknown[] = [];
  await page.route(`**${apiPath}/tasks/cancel-start`, async route => {
    cancellations.push(route.request().postDataJSON());
    if (cancellations.length === 1) await route.abort();
    else await route.fulfill({ json: task });
  });

  const started = page.waitForRequest(request => request.method() === 'POST' &&
    new URL(request.url()).pathname === `${apiPath}/tasks`, { timeout: 5000 });
  await dialog.getByRole('button', { name: '用模型整理' }).click();
  const startInput = (await started).postDataJSON();
  await dialog.getByRole('button', { name: '取消任务' }).click();
  await expect(dialog.getByRole('status')).toHaveText('取消结果未确认');
  if (storageDenied) await expect(dialog.getByRole('alert')).toContainText(storageWarning, { timeout: 3000 });
  else await expect(dialog.getByText(storageWarning, { exact: false })).toHaveCount(0);
  await expect(history).toBeDisabled({ timeout: 3000 });
  await dialog.getByRole('button', { name: '关闭 AI 整理' }).click();
  await expect(dialog).toHaveCount(0);
  if (reloadFromCard) {
    await page.reload();
    await expect(page.getByRole('status')).toHaveText('已保存到本机');
    await page.getByRole('button', { name: '重试取消', exact: true }).click();
  }
  if (reopenFrom === '项目记录') {
    await place(page, '另一张卡', 480, 340);
    await page.getByRole('button', { name: 'AI', exact: true }).click();
    const selection = dialog.getByRole('group', { name: '选择本次处理的内容' });
    await expect(selection.getByText('另一张卡', { exact: true })).toBeVisible({ timeout: 3000 });
    await selection.getByRole('checkbox', { name: /卡片标题/ }).check();
    await dialog.getByRole('button', { name: '试用模拟整理' }).click();
    await expect(dialog.getByRole('heading', { name: '模拟整理：另一张卡' })).toBeVisible();
    await dialog.getByRole('button', { name: '关闭 AI 整理' }).click();
    await page.getByRole('button', { name: '项目导航' }).click();
    await page.getByRole('button', { name: 'AI 整理记录', exact: true }).press('Enter', { timeout: 5000 });
  } else {
    await page.getByRole('button', { name: 'AI', exact: true }).click();
  }
  const reopened = page.getByRole('dialog', { name: reopenFrom === '项目记录' ? 'AI 整理记录' : 'AI 整理', exact: true });
  const reopenedHistory = reopened.getByRole('combobox', { name: '整理记录' });
  await expect(reopened.getByRole('status')).toHaveText('取消结果未确认', { timeout: 3000 });
  if (storageDenied) await expect(reopened.getByRole('alert')).toContainText(storageWarning);
  if (reopenFrom === '项目记录') {
    await expect(reopened.getByText('原卡：重试取消')).toBeVisible();
    await expect(reopenedHistory).toBeEnabled();
  } else {
    await expect(reopenedHistory).toBeDisabled();
  }
  await expect(reopened.getByRole('group', { name: '选择本次处理的内容' })).toHaveCount(0);
  expect(cancellations).toEqual([startInput]);
  if (reopenFrom === '刷新后从卡片' || cannotClear) await denyStorage('removeItem');
  if (cannotClear) await denyStorage('setItem');
  await reopened.getByRole('button', { name: '取消任务' }).click();
  releaseStart();
  await expect(reopened.getByRole('status')).toHaveText('模型整理 已取消');
  await expect(reopened.getByText(storageWarning, { exact: false })).toHaveCount(0);
  if (cannotClear) {
    await expect(reopened.getByRole('alert')).toContainText('当前标签页无法清除旧记录，刷新后可能再次显示“取消结果未确认”。', { timeout: 3000 });
    await expect(reopened.getByRole('button', { name: '取消任务' })).toHaveCount(0);
  } else await expect(reopened.getByRole('alert')).toHaveCount(0);
  await expect(reopenedHistory).toBeEnabled();
  expect(cancellations).toEqual([startInput, startInput]);
  if (reopenFrom === '刷新后从卡片') {
    await page.route(`**/cards/${task.cardId}/organize/tasks`, route => route.fulfill({ json: [task, prior] }));
    await page.route(`**${apiPath}/tasks/${task.id}`, route => route.fulfill({ json: task }));
    await reopened.getByRole('button', { name: '关闭 AI 整理' }).click();
    await page.reload();
    await expect(page.getByRole('status')).toHaveText('已保存到本机');
    await page.getByRole('button', { name: '重试取消', exact: true }).click();
    await page.getByRole('button', { name: 'AI', exact: true }).click();
    await expect(dialog.getByRole('status')).toHaveText('模型整理 已取消', { timeout: 3000 });
    expect(cancellations).toEqual([startInput, startInput]);
  }
});

for (const reloadWithReadFailure of [false, true]) test(reloadWithReadFailure
  ? '刷新时取消记录读取失败，存储恢复后取消乙卡仍能按原请求确认甲卡'
  : '项目整理记录在甲卡取消未确认时仍可查看已删除的乙卡记录并恢复乙卡请求', async ({ page, workspace }) => {
  const titleA = '待确认的甲卡';
  const titleB = '之后删除的乙卡';
  await place(page, titleA);
  await place(page, titleB, 480, 340);
  const { project, cards } = await workspace.state();
  const cardB = cards.find(card => card.title === titleB)!;
  const apiPath = `/api/mapping/projects/${project.id}/organize`;
  await page.route(`**${apiPath}/status`, route => route.fulfill({ json: { model: 'test-model' } }));

  const dialog = page.getByRole('dialog', { name: 'AI 整理', exact: true });
  const openCard = async (title: string) => {
    await page.getByRole('button', { name: title, exact: true }).click();
    await page.getByRole('button', { name: 'AI', exact: true }).click();
  };
  await openCard(titleB);
  await dialog.getByRole('checkbox', { name: /卡片标题/ }).check();
  const simulated = page.waitForResponse(response => response.request().method() === 'POST' &&
    new URL(response.url()).pathname === `${apiPath}/tasks`, { timeout: 5000 });
  await dialog.getByRole('button', { name: '试用模拟整理' }).click();
  const prior = await (await simulated).json();
  await expect(dialog.getByRole('heading', { name: `模拟整理：${titleB}` })).toBeVisible();
  await dialog.getByRole('button', { name: '关闭 AI 整理' }).click();

  let releaseStarts!: () => void;
  const heldStarts = new Promise<void>(resolve => { releaseStarts = resolve; });
  const starts: unknown[] = [];
  const cancellations: { cardId: string }[] = [];
  await page.route(`**${apiPath}/tasks`, async route => {
    if (route.request().method() !== 'POST') return route.continue();
    starts.push(route.request().postDataJSON());
    await heldStarts;
    await route.abort();
  });
  await page.route(`**${apiPath}/tasks/cancel-start`, route => {
    const input = route.request().postDataJSON();
    cancellations.push(input);
    if (input.cardId !== cardB.id || cancellations.filter(item => item.cardId === cardB.id).length === 1) return route.abort();
    return route.fulfill({ json: { ...prior, id: 'cancelled-b', mode: 'real', model: 'test-model',
      state: 'cancelled', freshness: 'deleted', output: null, outputAttempt: null, addAvailable: false, attempts: [] } });
  });

  try {
    for (const title of [titleA, titleB]) {
      if (title === titleB && reloadWithReadFailure) {
        await page.addInitScript(() => {
          const getItem = Storage.prototype.getItem;
          Storage.prototype.getItem = function (key) {
            if (this === sessionStorage && key === 'forkwise.organize-cancellation.v1')
              throw new DOMException('暂时无法读取取消记录', 'SecurityError');
            return getItem.call(this, key);
          };
          document.addEventListener('restore-cancellation-storage', () => { Storage.prototype.getItem = getItem; }, { once: true });
        });
        await page.reload();
        await expect(page.getByRole('status')).toHaveText('已保存到本机');
        await page.evaluate(() => document.dispatchEvent(new Event('restore-cancellation-storage')));
      }
      await openCard(title);
      if (title === titleB) {
        await expect(dialog.getByRole('heading', { name: `模拟整理：${titleB}` })).toBeVisible();
        await dialog.getByRole('combobox', { name: '整理记录' }).selectOption('');
      }
      await dialog.getByRole('checkbox', { name: /卡片标题/ }).check();
      await dialog.getByRole('button', { name: '用模型整理' }).click();
      await expect.poll(() => starts.length).toBe(title === titleA ? 1 : 2);
      await dialog.getByRole('button', { name: '取消任务' }).click();
      await expect(dialog.getByRole('alert')).toHaveText('未确认取消结果，请重试取消');
      await dialog.getByRole('button', { name: '关闭 AI 整理' }).click();
    }

    await workspace.execute(page, {
      commandId: crypto.randomUUID(), projectId: project.id, type: 'thought.delete',
      expected: { thought: cardB.versionId, body: cardB.body.versionId, pose: cardB.item.versionId, appearance: null },
      payload: { id: cardB.id },
    });
    await expect(page.getByRole('button', { name: titleB, exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: '项目导航' }).click();
    await page.getByRole('button', { name: 'AI 整理记录', exact: true }).press('Enter', { timeout: 5000 });
    const records = page.getByRole('dialog', { name: 'AI 整理记录', exact: true });
    const history = records.getByRole('combobox', { name: '整理记录' });
    await expect(records.getByText(`原卡：${titleA}`)).toBeVisible();
    await records.getByRole('button', { name: '取消任务' }).click();
    await expect(records.getByRole('alert')).toHaveText('未确认取消结果，请重试取消');

    let releaseRead!: () => void;
    const heldRead = new Promise<void>(resolve => { releaseRead = resolve; });
    await page.route(`**${apiPath}/tasks/${prior.id}`, async route => {
      await heldRead;
      await route.continue();
    });
    try {
      await history.selectOption(prior.id, { timeout: 3000 });
      await expect(history).toBeDisabled();
      await page.keyboard.press('Escape');
    } finally {
      releaseRead();
    }
    await expect(records.getByRole('heading', { name: `模拟整理：${titleB}` })).toBeVisible();
    await expect(records.getByText('原卡已删除，仍可查看旧结果。')).toBeVisible();
    await expect(records.getByRole('button', { name: '添加为新卡' })).toBeDisabled();
    expect(cancellations).toEqual([starts[0], starts[1], starts[0]]);

    const pendingB = `取消结果未确认 · 原卡已删除（${cardB.id.slice(0, 8)}）`;
    await history.selectOption({ label: pendingB });
    await expect(records.getByRole('status')).toHaveText('取消结果未确认');
    await records.getByRole('button', { name: '取消任务' }).click();
    await expect(records.getByText('模型整理 已取消', { exact: true })).toBeVisible();
    expect(cancellations).toEqual([starts[0], starts[1], starts[0], starts[1]]);
    expect(starts).toHaveLength(2);
    await expect(history.getByRole('option', { name: pendingB })).toHaveCount(0);
    await history.selectOption({ label: `取消结果未确认 · ${titleA}` });
    await expect(records.getByText(`原卡：${titleA}`)).toBeVisible();
  } finally {
    releaseStarts();
  }
});

test('模型整理提交前说明发送范围和留存政策', async ({ page, workspace }) => {
  await place(page, '发送范围示例');
  expect((await workspace.state()).cards).toHaveLength(1);
  // 仅提供页面读取的模型配置夹具。测试在发送前结束。
  const submissions: string[] = [];
  page.on('request', request => {
    if (request.method() === 'POST' && request.url().endsWith('/organize/tasks')) submissions.push(request.url());
  });
  await page.route('**/organize/status', route =>
    route.fulfill({ json: { model: 'openai/gpt-6-luna', blockedReason: null } }));
  await page.getByRole('button', { name: 'AI', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'AI 整理', exact: true });
  await dialog.getByRole('checkbox', { name: /卡片标题/ }).check();
  await expect(dialog.getByRole('button', { name: '用模型整理' })).toHaveAccessibleDescription(
    '发送给 OpenAI API 的内容仅限本次勾选的标题和正文文字，用于生成整理候选。请求关闭 OpenAI 的响应存储。数据留存按 API 项目的数据控制设置执行，启用前须核验零数据留存（ZDR）和不用于训练条款。',
  );
  expect(submissions).toEqual([]);
});
