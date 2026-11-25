import { expect, test, type Workspace } from './writing-board-fixture';
import type { Page, Request } from '@playwright/test';

test.use({ workspaceStartsEmpty: true });

function research(page: Page) {
  return page.getByRole('region', { name: '尚无研究', exact: true });
}

function emptyCanvas(page: Page) {
  return page.getByRole('region', { name: '从一个想法开始', exact: true });
}

async function createResearch(page: Page) {
  await research(page).getByRole('button', { name: '创建研究', exact: true }).click();
  await expect(emptyCanvas(page)).toBeVisible();
}

async function history(page: Page, workspace: Workspace) {
  const id = (await workspace.state()).project.id;
  return (await page.request.get(`${workspace.origin}/api/mapping/projects/${id}/history`)).json();
}

test('新建空研究后可跳过引导，从中央入口落点建卡，保留选中及一次撤销', async ({ page, workspace }) => {
  await expect(research(page)).toBeVisible();
  await expect(emptyCanvas(page)).toHaveCount(0);
  await createResearch(page);
  await expect(research(page)).toHaveCount(0);
  const empty = emptyCanvas(page);
  const create = empty.getByRole('button', { name: '新建卡片', exact: true });
  await expect(create).toBeFocused();

  const navigation = page.getByRole('button', { name: '项目导航', exact: true });
  await navigation.press('Enter');
  const replay = page.getByRole('button', { name: '画布引导', exact: true });
  await replay.press('Enter');
  const dialog = page.getByRole('dialog', { name: '画布引导', exact: true });
  await dialog.getByRole('button', { name: '跳过引导' }).press('Enter');
  await expect(dialog).toHaveCount(0);
  await expect(replay).toBeFocused();
  await navigation.press('Enter');

  const before = await workspace.state();
  expect(before.cards).toEqual([]);
  const writes: string[] = [];
  page.on('request', request => {
    if (request.method() === 'POST' && request.url().endsWith('/api/mapping/execute')) writes.push(request.postDataJSON().type);
  });
  await create.press('Enter');
  await expect(page.locator('#project-canvas')).toBeFocused();
  await expect(page.getByRole('button', { name: '卡片', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByText('点击画布放置卡片', { exact: true })).toBeVisible();
  await expect(empty).toBeVisible();
  await expect(create).toHaveCount(0);
  expect(await workspace.state()).toEqual(before);
  await page.locator('.react-flow__pane').click({ position: { x: 360, y: 210 } });
  const title = page.getByRole('textbox', { name: '卡片标题', exact: true });
  await expect(title).toBeFocused();
  await title.fill('第一张研究卡');
  await title.press('Enter');
  await expect(page.locator('.react-flow__node.selected')).toContainText('第一张研究卡');
  await expect(empty).toHaveCount(0);
  await expect(page.getByRole('button', { name: '选择', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(async () => (await workspace.state()).cards.map(card => card.title)).toEqual(['第一张研究卡']);
  expect(writes.filter(type => type === 'thought.create')).toEqual(['thought.create']);
  expect((await history(page, workspace)).undo.map((entry: { label: string }) => entry.label)).toEqual(['thought.create']);
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect(empty).toBeVisible();
});

test('加载或读取失败不显示无项目空态', async ({ page, workspace }) => {
  await expect(research(page)).toBeVisible();
  let reply!: () => void;
  const delay = new Promise<void>(resolve => { reply = resolve; });
  const endpoint = workspace.origin + '/api/mapping/projects';
  const reached = page.waitForRequest(request => request.url() === endpoint);
  const failed = page.waitForResponse(response => response.url() === endpoint);
  await page.route(endpoint, async route => {
    await delay;
    await route.fulfill({ status: 503, json: { message: '项目暂时无法打开' } });
  });
  try {
    await page.reload({ waitUntil: 'domcontentloaded' });
    await reached;
    await expect(research(page)).toHaveCount(0);
    await expect(emptyCanvas(page)).toHaveCount(0);
  } finally {
    reply();
  }
  expect((await failed).status()).toBe(503);
  await expect(page.getByRole('status')).toHaveText('保存未完成');
  await expect(research(page)).toHaveCount(0);
  await expect(emptyCanvas(page)).toHaveCount(0);
});

test('1360 和 760 宽度下，引导位于顶栏下方，中央按钮和底部卡片入口都能命中', async ({ page, workspace }) => {
  expect(await (await page.request.get(workspace.origin + '/api/mapping/projects')).json()).toEqual([]);
  const invitation = page.getByRole('region', { name: '画布引导', exact: true });
  const topbar = page.locator('.topbar');
  for (const width of [1360, 760]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(invitation).toBeVisible();
    const header = (await topbar.boundingBox())!;
    const invite = (await invitation.boundingBox())!;
    expect(invite.y).toBeGreaterThanOrEqual(header.y + header.height);
    expect(invite.x + invite.width).toBeLessThanOrEqual(width);
    await invitation.getByRole('button', { name: '查看引导', exact: true }).click({ trial: true });
  }
  await createResearch(page);
  for (const width of [1360, 760]) {
    await page.setViewportSize({ width, height: 900 });
    const central = emptyCanvas(page).getByRole('button', { name: '新建卡片', exact: true });
    const bottom = page.getByRole('button', { name: '卡片', exact: true });
    const center = (await central.boundingBox())!;
    const tools = (await bottom.boundingBox())!;
    expect(center.x + center.width / 2).toBeCloseTo(width / 2, 0);
    expect(center.y + center.height).toBeLessThan(tools.y);
    await central.click({ trial: true });
    await bottom.click({ trial: true });
  }
});

for (const object of ['空分区', '自由端连线']) {
  test(`只有${object}时，空画布提示也会退场`, async ({ page, workspace }) => {
    await createResearch(page);
    const projectId = (await workspace.state()).project.id;
    const command = object === '空分区' ? {
      type: 'frame.create',
      expected: { frame: null, groups: {}, containment: {}, poses: {} },
      payload: { id: 'empty-frame', itemIds: [], pose: { x: 130, y: 150, width: 200, height: 160 } },
    } : {
      type: 'connector.create',
      expected: null,
      payload: { id: 'free-line', path: 'straight', start: { kind: 'free', point: { x: 180, y: 170 } },
        end: { kind: 'free', point: { x: 380, y: 270 } } },
    };
    await workspace.execute(page, { ...command, projectId, commandId: 'only-object' });
    await page.reload();
    await expect(page.getByRole('status')).toHaveText('已保存到本机');
    expect((await workspace.state()).cards).toEqual([]);
    await expect(emptyCanvas(page)).toHaveCount(0);
  });
}

for (const method of ['GET', 'PUT']) {
  test(`空工作台的真实引导 ${method} 返回 401 时撤下入口并提示重开`, async ({ page, workspace }) => {
    const endpoint = workspace.origin + '/api/workspace/guide';
    const requestMatches = (request: Request) => request.url() === endpoint && request.method() === method;
    const dialog = page.getByRole('dialog', { name: '画布引导', exact: true });
    const navigation = page.getByRole('button', { name: '项目导航', exact: true });
    if (method === 'PUT') {
      await page.getByRole('button', { name: '查看引导', exact: true }).click();
      await expect(dialog).toBeVisible();
    }
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const requested = page.waitForRequest(requestMatches);
    const returned = page.waitForResponse(response => requestMatches(response.request()));
    await page.route(endpoint, async route => {
      if (route.request().method() === method) await held;
      await route.continue();
    });
    try {
      if (method === 'GET') await page.reload({ waitUntil: 'domcontentloaded' });
      else await dialog.getByRole('button', { name: '跳过引导' }).press('Enter');
      await requested;
      workspace.revoke();
    } finally { release(); }
    expect((await returned).status()).toBe(401);
    await expect(dialog).toHaveCount(0);
    await expect(research(page)).toHaveCount(0);
    await expect(page.getByRole('region', { name: '画布引导', exact: true })).toHaveCount(0);
    await expect(page.getByText('授权已失效，请从本机启动入口重新打开；未确认草稿已保留')).toBeVisible();
    await expect(page.getByRole('button', { name: '新建研究', exact: true })).toBeDisabled();
    if (method === 'PUT') await expect(navigation).toBeFocused();
  });
}


test('未携带启动凭证且无有效会话时，隐藏引导和新建研究空态', async ({ page, workspace }) => {
  await page.context().clearCookies();
  const endpoint = workspace.origin + '/api/mapping/projects';
  const denied = page.waitForResponse(response => response.url() === endpoint);
  await page.goto(workspace.origin);
  expect((await denied).status()).toBe(401);
  await page.getByRole('button', { name: '项目导航', exact: true }).click();
  await expect(page.locator('.project-nav').getByRole('button', { name: '画布引导', exact: true })).toHaveCount(0);
  await expect(research(page)).toHaveCount(0);
  await expect(page.getByRole('button', { name: '新建研究', exact: true })).toBeDisabled();
});
