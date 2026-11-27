import type { Page } from '@playwright/test';
import { test, expect, type Workspace } from './writing-board-fixture';

async function createUnmeasuredCards(page: Page, workspace: Workspace, total: number) {
  const { project } = await workspace.state();
  await page.goto('about:blank'); // 种子只写 HTTP + SQLite，只有一个页面会生成卡面测量。
  for (let index = 0; index < total; index++) {
    await workspace.execute(page, {
      type: 'thought.create', commandId: 'cold-card-' + index, projectId: project.id, expected: null,
      payload: { id: 'cold-card-' + index, title: '首开未测量卡片 ' + index, text: '普通正文',
        x: 100 + 300 * (index % 4), y: 100 + 180 * Math.floor(index / 4) },
    });
  }
  const pending = (await workspace.state()).cards;
  expect(pending.every(value => (value.item.heightPolicy?.necessaryHeight ?? 0) === 0)).toBe(true);
  return project;
}

test('首开一批未测量卡片，保留独立布局确认且不逐张重读整图', async ({ page, workspace }) => {
  const total = 16;
  const project = await createUnmeasuredCards(page, workspace, total);
  const timeline = async () => (await page.request.get(workspace.origin + '/api/mapping/projects/' + project.id + '/history')).json();
  const before = await timeline();
  const layouts: { status: number; id: string }[] = [];
  let indexReads = 0;
  page.on('response', response => {
    const url = new URL(response.url());
    if (url.pathname.endsWith('/map') && url.searchParams.get('view') === 'index' && !url.searchParams.has('cursor')) indexReads++;
    if (!url.pathname.endsWith('/execute')) return;
    const command = response.request().postDataJSON();
    if (command.type === 'card.layout') layouts.push({ status: response.status(), id: command.payload.id });
  });
  await workspace.open(page);
  await expect.poll(() => layouts.length).toBe(total);
  await expect(page.getByRole('status')).toHaveText('已保存到本机');
  expect(layouts.every(layout => layout.status === 200)).toBe(true);
  expect(new Set(layouts.map(layout => layout.id)).size).toBe(total);
  const after = await workspace.state();
  await expect(page.locator('.workspace')).toHaveAttribute('data-revision', String(after.project.revision));
  expect(after.project.revision).toBe(project.revision + total * 2);
  expect(after.cards.every(value => (value.item.heightPolicy?.necessaryHeight ?? 0) > 0)).toBe(true);
  expect((await timeline()).undo.map((action: { id: string }) => action.id)).toEqual(before.undo.map((action: { id: string }) => action.id));
  await page.getByRole('button', { name: '导出', exact: true }).press('Enter');
  await expect(page.getByRole('menuitem', { name: '下载可读摘要（Markdown）', exact: true })).toBeEnabled();
  expect(indexReads).toBeLessThan(total);
});

test('批内请求失败时先读回成功部分，再以原请求重试', async ({ page, workspace }) => {
  const total = 5;
  const project = await createUnmeasuredCards(page, workspace, total);
  const attempts: unknown[] = [];
  await page.route('**/api/mapping/execute', async route => {
    const command = route.request().postDataJSON();
    if (command.type !== 'card.layout') {
      await route.continue();
      return;
    }
    attempts.push(command);
    if (attempts.length === 3) {
      await route.fulfill({ status: 503, json: { code: 'SAVE_FAILED', message: '卡面本次未保存，可以重试' } });
      return;
    }
    await route.continue();
  });
  await workspace.open(page, '卡面布局保存未完成');
  const partial = await workspace.state();
  expect(partial.project.revision).toBe(project.revision + total + 2);
  expect(partial.cards.filter(value => (value.item.heightPolicy?.necessaryHeight ?? 0) > 0)).toHaveLength(2);
  await expect(page.locator('.workspace')).toHaveAttribute('data-revision', String(partial.project.revision));
  await expect(page.getByRole('alert')).toContainText('卡面本次未保存，可以重试');

  await page.getByRole('button', { name: '重试卡面布局', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('已保存到本机');
  expect(attempts).toHaveLength(total + 1);
  expect(attempts[3]).toEqual(attempts[2]);
  const done = await workspace.state();
  expect(done.project.revision).toBe(project.revision + total * 2);
  expect(done.cards.every(value => (value.item.heightPolicy?.necessaryHeight ?? 0) > 0)).toBe(true);
  await expect(page.locator('.workspace')).toHaveAttribute('data-revision', String(done.project.revision));
});

for (const scenario of ['pending', 'published', 'body-single', 'body-selection'] as const) test(
  {
    pending: '批内前一卡布局已写而后一卡待确认时，删除采用前一卡自身回执',
    published: '写入回执晚于后台已发布的布局，删除仍使用捕获时版本',
    'body-single': '单删等待一卡布局批次时，先确认该卡布局、再确认正文派生高度',
    'body-selection': '多选删除等一卡布局批次时，按序确认布局和正文派生高度',
  }[scenario],
  async ({ page, workspace }) => {
  const project = await createUnmeasuredCards(page, workspace, 3);
  const withBody = scenario === 'body-single' || scenario === 'body-selection';
  const multi = scenario === 'body-selection';
  let measurementCount = 0;
  let measuredCardId = '';
  let bodyRequested = false;
  const bodyReplies: { status: number; derivedPoseVersions?: Record<string, { before: string; after: string }> }[] = [];
  const deletions: { status: number; expected: { pose?: string; items?: Record<string, { pose: string }> } }[] = [];
  let thirdStarted!: () => void;
  const started = new Promise<void>(resolve => { thirdStarted = resolve; });
  let release!: () => void, releaseBody!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const pendingBody = new Promise<void>(resolve => { releaseBody = resolve; });
  if (scenario !== 'published') await page.route('**/api/mapping/projects/*/changes?*', route => route.abort());
  await page.route('**/api/mapping/execute', async route => {
    const command = route.request().postDataJSON();
    if (command.type === 'card.layout') {
      measurementCount++;
      if (measurementCount === 2) measuredCardId = command.payload.id;
      if (measurementCount === 3) {
        thirdStarted();
        await pending;
      }
    }
    if (withBody && command.type === 'body.edit') {
      bodyRequested = true;
      await pendingBody;
      const response = await route.fetch();
      bodyReplies.push({ status: response.status(), derivedPoseVersions: (await response.json()).derivedPoseVersions });
      await route.fulfill({ response });
      return;
    }
    if (command.type === 'thought.delete' || command.type === 'canvas.delete-selection') {
      const response = await route.fetch();
      deletions.push({ status: response.status(), expected: command.expected });
      await route.fulfill({ response });
      return;
    }
    await route.continue();
  });
  try {
    await page.goto(workspace.origin);
    await started;
    const beforeDelete = await workspace.state();
    const card = beforeDelete.cards.find(value => value.id === measuredCardId)!;
    expect(card.item.heightPolicy?.necessaryHeight).toBeGreaterThan(0);
    if (scenario === 'published') await expect(page.locator('.workspace')).toHaveAttribute('data-revision', String(beforeDelete.project.revision));
    else await expect(page.locator('.workspace')).toHaveAttribute('data-revision', String(beforeDelete.project.revision - 1));
    const title = page.getByRole('button', { name: card.title, exact: true });
    const toolbar = page.getByRole('toolbar', { name: '卡片操作', exact: true });
    await title.click();
    if (withBody) {
      await page.locator('.thought-card').filter({ has: title })
        .getByRole('button', { name: '编辑正文', exact: true }).click();
      await page.getByRole('textbox', { name: '卡片正文', exact: true }).fill('');
      await expect.poll(() => bodyRequested).toBe(true);
    }
    if (multi) {
      const other = beforeDelete.cards.find(value => value.id !== card.id && value.item.heightPolicy?.necessaryHeight)!;
      await page.getByRole('button', { name: other.title, exact: true }).click({ modifiers: ['Shift'] });
      await expect(page.locator('.react-flow__node.selected')).toHaveCount(2);
      await page.keyboard.press('Delete');
    } else {
      await toolbar.getByRole('button', { name: '更多', exact: true }).click();
      await page.getByRole('button', { name: '删除卡片', exact: true }).click();
    }
    expect(deletions).toEqual([]);
    let expectedPose = card.item.versionId;
    if (withBody) {
      releaseBody();
      await expect.poll(() => bodyReplies.length).toBe(1);
      expect(bodyReplies[0]!.status).toBe(200);
      const bodyPose = bodyReplies[0]!.derivedPoseVersions?.[card.item.id];
      expect(bodyPose?.before).toBe(card.item.versionId);
      expectedPose = bodyPose!.after;
      await expect(page.locator('.workspace')).toHaveAttribute('data-revision', String(beforeDelete.project.revision + 1));
      expect(deletions).toEqual([]);
    }
    release();
    await expect.poll(() => deletions.map(value => value.status)).toEqual([200]);
    const sent = deletions[0]!.expected;
    expect(multi ? sent.items?.[card.item.id]?.pose : sent.pose).toBe(expectedPose);
    await expect(title).toHaveCount(0);
    const afterDelete = await workspace.state();
    expect(afterDelete.cards.map(value => value.id)).not.toContain(measuredCardId);
    expect(afterDelete.cards).toHaveLength(multi ? 1 : 2);
    expect(afterDelete.project.revision).toBe(project.revision + 7 + Number(withBody));
  } finally {
    release();
    releaseBody();
    await page.unrouteAll({ behavior: 'wait' });
  }
});

for (const outcome of ['saved', 'conflict', 'read-failure'] as const) test(
  `旧布局读回晚于更新的标题投影时仍测量新标题（${{ saved: '已写入', conflict: '写入冲突', 'read-failure': '读回重试' }[outcome]}）`,
  async ({ page, workspace }) => {
  const project = await createUnmeasuredCards(page, workspace, 1);
  let firstLayoutStatus: number | undefined;
  let holdingRead = false;
  let held = false;
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const retryRequests: ('history' | 'layout')[] = [];
  let retrying = false;
  page.on('request', request => {
    if (!retrying) return;
    const { pathname } = new URL(request.url());
    if (pathname.endsWith('/history')) retryRequests.push('history');
    if (pathname.endsWith('/execute') && request.postDataJSON()?.type === 'card.layout')
      retryRequests.push('layout');
  });
  page.on('response', response => {
    const request = response.request();
    if (request.method() === 'POST' && new URL(request.url()).pathname.endsWith('/execute') &&
      request.postDataJSON().type === 'card.layout') firstLayoutStatus ??= response.status();
  });
  if (outcome === 'conflict') {
    let preempted = false;
    await page.route('**/api/mapping/execute', async route => {
      if (!preempted && route.request().postDataJSON().type === 'card.layout') {
        preempted = true;
        const card = (await workspace.state()).cards[0]!;
        await workspace.execute(page, {
          commandId: 'intermediate-title',
          projectId: project.id,
          type: 'thought.title',
          expected: card.versionId,
          payload: { id: card.id, title: '中间版本' },
        });
      }
      await route.continue();
    });
  }
  await page.route('**/api/mapping/projects/*/history', async route => {
    if (firstLayoutStatus === undefined || holdingRead) {
      await route.continue();
      return;
    }
    holdingRead = true;
    const response = await route.fetch();
    held = true;
    await pending;
    if (outcome === 'read-failure') await route.fulfill({ status: 503, json: { message: '布局读回测试故障' } });
    else await route.fulfill({ response });
  });
  try {
    await page.goto(workspace.origin);
    await expect.poll(() => held).toBe(true);
    expect(firstLayoutStatus).toBe(outcome === 'conflict' ? 409 : 200);
    const card = (await workspace.state()).cards[0]!;
    const title = '第一行\n第二行\n第三行\n第四行\n第五行\n独立同步';
    await workspace.execute(page, {
      commandId: 'newer-title',
      projectId: project.id,
      type: 'thought.title',
      expected: card.versionId,
      payload: { id: card.id, title },
    });
    await expect(page.locator('.title-button')).toHaveText(title.replaceAll('\n', ' '));
    release();
    if (outcome === 'read-failure') {
      const retry = page.getByRole('button', { name: '重试卡面布局', exact: true });
      await expect(retry).toBeVisible();
      retrying = true;
      await retry.click();
    }
    await expect(page.getByRole('status')).toHaveText('已保存到本机');
    if (outcome === 'read-failure') {
      expect(retryRequests[0]).toBe('history');
      expect(retryRequests.filter(request => request === 'layout')).toHaveLength(1);
    }
    const after = await workspace.state();
    expect(after.cards[0]!.title).toBe(title);
    expect(after.cards[0]!.item.heightPolicy!.necessaryHeight).toBeGreaterThan(100);
    await expect(page.locator('.workspace')).toHaveAttribute('data-revision', String(after.project.revision));
  } finally {
    release();
    await page.unrouteAll({ behavior: 'wait' });
  }
});
