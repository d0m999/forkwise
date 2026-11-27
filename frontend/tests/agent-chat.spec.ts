import { expect, place, test } from './writing-board-fixture';

const threadId = 'bba243c1-12ba-4ed1-98c5-856d14629c3e';
const resumeCommand = `codex --no-daemon resume -C '/tmp/agent-chat-fixture' --model gpt-6-luna '${threadId}'`;

test('无项目右栏复用 Codex 登录，保留失败草稿并按原生身份刷新终端续聊', async ({ page, context, workspace }) => {
  const first = { id: 'chat-1', threadId: null as string | null, model: null as string | null };
  const second = { id: 'chat-2', threadId: null, model: null };
  const conversations: (typeof first)[] = [];
  const messages = [{ id: 'user-1', role: 'user', text: '合成问题一' }];
  const requests: string[] = [];
  const modelUnavailableMessage = '当前 Codex 账户没有列出 gpt-6-luna。';
  let loggedIn = false;
  let modelAvailable = true;
  let popupOpened = false;
  let turnRequests = 0;
  let busy = true;
  const firstDetail = () => ({ ...first, busy, messages, resumeCommand: busy ? undefined : resumeCommand });

  page.on('popup', () => { popupOpened = true; });
  await page.route('**/api/mapping/projects', route => route.fulfill({ json: [] }));
  await page.route('**/api/agent-chat/**', route => {
    const path = new URL(route.request().url()).pathname.slice('/api/agent-chat'.length);
    const method = route.request().method();
    requests.push(`${method} ${path}`);
    if (path === '/status' && method === 'GET') return route.fulfill({ json: {
      loggedIn, modelAvailable: loggedIn && modelAvailable, message: loggedIn && !modelAvailable ? modelUnavailableMessage : undefined,
    } });
    if (path === '/conversations' && method === 'POST') {
      const created = conversations.length === 0 ? first : second;
      expect(conversations).not.toContain(created);
      expect(route.request().postDataJSON()).toEqual({});
      conversations.unshift(created);
      return route.fulfill({ status: 201, json: created });
    }
    if (path === '/conversations') return route.fulfill({ json: { conversations } });
    if (path === '/conversations/chat-1/turns' && method === 'POST') {
      expect(route.request().postDataJSON()).toEqual({ text: '合成问题一' });
      turnRequests += 1;
      if (turnRequests === 1) return route.fulfill({ status: 503, json: { message: '发送暂时失败' } });
      first.threadId = threadId;
      first.model = 'gpt-6-luna';
      return route.fulfill({ status: 202, json: firstDetail() });
    }
    if (path === '/conversations/chat-1') return route.fulfill({ json: first.threadId ? firstDetail() : { ...first, busy: false, messages: [] } });
    if (path === '/conversations/chat-2') return route.fulfill({ json: { ...second, busy: false, messages: [] } });
    throw new Error(`意外的对话请求 ${path}`);
  });

  await page.reload();
  await expect(page.locator('.save-state')).toContainText('已保存到本机');
  await expect(page.getByRole('tab')).toHaveCount(0);
  const toggle = page.getByRole('button', { name: 'Codex 对话', exact: true });
  const chat = page.getByRole('complementary', { name: 'Codex 对话' });
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(chat).toHaveCount(0);
  expect(requests).toEqual([]);
  await toggle.press('Enter');
  await expect(chat.getByText('无项目', { exact: true })).toBeVisible();
  await expect(chat.getByRole('status')).toHaveText('请在终端运行 codex login，登录后点击刷新。');
  await expect(chat.getByRole('button')).toHaveText(['刷新']);
  expect(requests).toEqual(['GET /status']);
  const draft = chat.getByRole('textbox', { name: '消息', exact: true });
  const send = chat.getByRole('button', { name: '发送', exact: true });
  const refresh = chat.getByRole('button', { name: '刷新', exact: true });
  const create = chat.getByRole('button', { name: '新建对话', exact: true });
  const transcript = chat.getByRole('log', { name: '对话消息' });
  loggedIn = true;
  await refresh.click();
  await expect(transcript).toHaveText('新建一段对话开始聊天。');
  await create.click();
  await expect(chat.getByRole('combobox', { name: '对话列表' })).toHaveValue(first.id);
  await draft.fill('合成问题一');
  await send.click();
  await expect(chat.getByRole('alert')).toHaveText('发送暂时失败');
  await expect(draft).toHaveValue('合成问题一');
  await toggle.click();
  await expect(chat).toHaveCount(0);
  await toggle.click();
  await expect(draft).toHaveValue('合成问题一');
  await send.click();
  await expect(chat.getByRole('status')).toHaveText('Codex 正在处理当前回合…');
  await expect(send).toBeDisabled();
  await expect(chat.getByText(threadId, { exact: true })).toBeVisible();
  await expect(chat.getByText('gpt-6-luna', { exact: true })).toBeVisible();
  await expect(chat.getByText('终端续聊', { exact: true })).toHaveCount(0);
  busy = false;
  messages.push({ id: 'assistant-1', role: 'assistant', text: '合成回答一' });
  await expect(transcript.getByText('合成回答一', { exact: true })).toBeVisible();
  await expect(draft).toHaveValue('');

  messages.push({ id: 'terminal-user', role: 'user', text: '终端追问' }, { id: 'terminal-answer', role: 'assistant', text: '终端回答' });
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(transcript.getByText('终端追问', { exact: true })).toBeVisible();
  await expect(transcript.getByText('终端回答', { exact: true })).toBeVisible();
  messages.push({ id: 'terminal-latest', role: 'assistant', text: '手动刷新结果' });
  await refresh.click();
  await expect(transcript.getByText('手动刷新结果', { exact: true })).toBeVisible();
  await expect(chat.getByText(threadId, { exact: true })).toBeVisible();
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: workspace.origin });
  await chat.getByText('终端续聊', { exact: true }).click();
  await chat.getByRole('button', { name: '复制终端命令', exact: true }).click();
  await expect(chat.getByRole('status')).toHaveText('已复制终端命令。');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(resumeCommand);

  modelAvailable = false;
  await refresh.click();
  await expect(chat.getByRole('alert')).toHaveText(modelUnavailableMessage);
  await expect(transcript.getByText('手动刷新结果', { exact: true })).toBeVisible();
  await expect(chat.getByText('终端续聊', { exact: true })).toHaveCount(0);
  await create.click();
  await expect(chat.getByRole('combobox', { name: '对话列表' })).toHaveValue(second.id);
  await expect(draft).toBeVisible();
  await expect(draft).toHaveValue('');
  await expect(transcript.locator('article')).toHaveCount(0);
  await expect(chat.getByText(threadId, { exact: true })).toHaveCount(0);
  await draft.fill('保留给模型恢复后的问题');
  await expect(draft).toHaveValue('保留给模型恢复后的问题');
  await expect(send).toBeDisabled();
  expect(requests).not.toContain('POST /conversations/chat-2/turns');
  expect(requests).not.toContain('POST /authorization');
  expect(popupOpened).toBe(false);
});

test('打开右栏保留画布和写字板的操作区域', async ({ page, workspace }) => {
  const message = '请先在终端运行 codex login，完成登录后回来刷新。';
  await page.route('**/api/agent-chat/status', route => route.fulfill({ json: { loggedIn: false, modelAvailable: false, message } }));
  await place(page, '并排时保留卡片', 280, 200);
  await page.getByRole('button', { name: '编辑正文', exact: true }).click();
  const board = page.getByRole('complementary', { name: '写字板' });
  const canvas = page.getByRole('main');
  const toggle = page.getByRole('button', { name: 'Codex 对话', exact: true });
  await toggle.click();
  const chat = page.getByRole('complementary', { name: 'Codex 对话' });
  await expect(chat).toBeVisible();
  await expect(chat.getByRole('status')).toHaveText(message);
  await expect(canvas).toBeVisible();
  await expect(board.getByRole('textbox', { name: '卡片正文' })).toBeVisible();
  await expect.poll(async () => {
    const [canvasRect, boardRect, chatRect] = await Promise.all([canvas.boundingBox(), board.boundingBox(), chat.boundingBox()]);
    if (!canvasRect || !boardRect || !chatRect) return false;
    return canvasRect.x + canvasRect.width <= boardRect.x && boardRect.x + boardRect.width <= chatRect.x;
  }).toBe(true);
  const editor = board.getByRole('textbox', { name: '卡片正文' });
  await editor.fill('这段正文在右栏打开时仍可保存。');
  await expect.poll(async () => JSON.stringify((await workspace.state()).cards[0]?.body.blocks)).toContain('这段正文在右栏打开时仍可保存。');
  await toggle.click();
  await expect(board).toBeVisible();
  await expect(editor).toHaveText('这段正文在右栏打开时仍可保存。');
});
