import { test, expect } from './writing-board-fixture';
import type { Workspace } from './writing-board-fixture';
import type { Page } from '@playwright/test';
import { fiveMembers } from './group-selection-fixture';

// Shared real rejection boundary: the owner receives a genuine SQLite 409,
// while tests control only transport/storage availability through public APIs.
async function rejectedMove(page: Page, workspace: Workspace, mode: 'normal' | 'quota' | 'late-read') {
  const f = await fiveMembers(page, workspace), projectId = f.before.project.id, attempts: any[] = [];
  let rejectNext = true, rejected = false, compareHeld = false, release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  try {
    if (mode === 'quota') {
      const quota = await page.evaluate(() => {
        let failed = false;
        try { for (let i = 0; i < 1024; i++) localStorage.setItem('issue28-quota-large-' + i, 'x'.repeat(16384)); } catch (error) { failed = (error as DOMException).name === 'QuotaExceededError'; }
        try { for (let i = 0; i < 1024; i++) localStorage.setItem('issue28-quota-small-' + i, 'x'.repeat(64)); } catch (error) { failed &&= (error as DOMException).name === 'QuotaExceededError'; }
        return failed;
      });
      expect(quota).toBe(true);
    }
    await page.route('**/api/mapping/execute', async route => {
      const command = route.request().postDataJSON();
      if (command.type !== 'canvas.move-selection') { await route.continue(); return; }
      if (rejectNext) {
        rejectNext = false;
        await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'text.move', expected: f.before.texts![0]!.item.versionId,
          payload: { id: f.items.text.id, x: 450, y: 145 } });
      }
      const response = await route.fetch(); attempts.push({ command, status: response.status() });
      rejected = response.status() === 409; await route.fulfill({ response });
    });
    await page.route('**/api/mapping/projects/' + projectId + '/map?**', async route => {
      if (mode !== 'late-read' || !rejected || compareHeld || new URL(route.request().url()).searchParams.get('view') !== 'index') { await route.continue(); return; }
      compareHeld = true; await gate; await route.abort('connectionreset');
    });
    await f.visuals.shape.click(); const box = (await f.visuals.shape.boundingBox())!, x = box.x + box.width / 2, y = box.y + box.height / 2;
    await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.move(x + 40, y + 20, { steps: 4 }); await page.mouse.up();
    await expect.poll(() => rejected).toBe(true); expect(attempts).toHaveLength(1);
    const panel = page.getByRole('region', { name: '混合移动保存冲突', exact: true });
    return { ...f, projectId, attempts, panel, held: () => compareHeld, release,
      async close() {
        release();
        await page.evaluate(() => { for (const key of Object.keys(localStorage)) if (key.startsWith('issue28-quota-')) localStorage.removeItem(key); });
        await page.unrouteAll({ behavior: 'wait' });
      } };
  } catch (failure) {
    release();
    await page.unrouteAll({ behavior: 'wait' });
    throw failure;
  }
}

test('v2五类移动拒绝记录含Stroke和原Pose，刷新恢复后放弃再操作不复用旧请求', async ({ page, workspace }) => {
  const f = await rejectedMove(page, workspace, 'normal');
  try {
    await expect(f.panel).toBeVisible(); await expect(f.panel.locator('tbody tr')).toHaveCount(5);
    await expect(f.panel.getByText('笔迹 5', { exact: true })).toBeVisible();
    await expect(f.panel.getByText('原位置未记录', { exact: true })).toHaveCount(0);
    const record = await page.evaluate(() => Object.entries(localStorage).filter(([key]) => key.startsWith('forkwise:canvas-move-conflict:v1:')).map(([, value]) => JSON.parse(value)));
    expect(record).toHaveLength(1); expect(record[0].schema).toBe(2);
    expect(record[0].value.command).toEqual(f.attempts[0].command);
    expect(record[0].value.targets.map((target: any) => target.itemId)).toEqual(Object.values(f.items).map(value => value.item.id));
    for (const value of [...f.before.cards, ...f.before.texts!, ...f.before.shapes!, ...f.before.images!, ...f.before.strokes!]) expect(record[0].value.targets.find((target: any) => target.itemId === value.item.id).pose).toEqual(value.item.pose);
    const peer = await workspace.state(), historyUrl = workspace.origin + '/api/mapping/projects/' + f.projectId + '/history';
    const timeline = await (await page.request.get(historyUrl)).json();
    await page.reload(); await page.getByRole('button', { name: '恢复混合移动草稿', exact: true }).click();
    await expect(f.panel).toBeVisible(); await expect(f.panel.locator('tbody tr')).toHaveCount(5);
    await expect(f.panel.getByText('笔迹 5', { exact: true })).toBeVisible();
    await f.panel.getByRole('button', { name: '放弃本次混合移动，保留已保存位置', exact: true }).click();
    await expect(f.panel).toHaveCount(0); expect(await workspace.state()).toEqual(peer);
    expect(await (await page.request.get(historyUrl)).json()).toEqual(timeline); expect(f.attempts).toHaveLength(1);
    await f.visuals.shape.click(); const box = (await f.visuals.shape.boundingBox())!, x = box.x + box.width / 2, y = box.y + box.height / 2;
    await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.move(x + 20, y + 10, { steps: 2 }); await page.mouse.up();
    await expect.poll(() => f.attempts.length).toBe(2); expect(f.attempts[1].status).toBe(200);
    expect(f.attempts[1].command.commandId).not.toBe(f.attempts[0].command.commandId);
    expect((await workspace.state()).project.revision).toBe(peer.project.revision + 1);
  } finally { await f.close(); }
});

test('真实Storage quota阻止接管时拒绝命令留队，释放空间后只持久化和GET不再POST', async ({ page, workspace }) => {
  const f = await rejectedMove(page, workspace, 'quota');
  try {
    const retry = page.getByRole('button', { name: '重试画布保存', exact: true });
    await expect(retry).toBeVisible(); await expect(f.panel).toHaveCount(0);
    const peer = await workspace.state(), historyUrl = workspace.origin + '/api/mapping/projects/' + f.projectId + '/history';
    const timeline = await (await page.request.get(historyUrl)).json();
    await page.evaluate(() => { for (const key of Object.keys(localStorage)) if (key.startsWith('issue28-quota-')) localStorage.removeItem(key); });
    await retry.click(); await expect(f.panel).toBeVisible(); await expect(f.panel.locator('tbody tr')).toHaveCount(5);
    expect(f.attempts).toHaveLength(1); expect(await workspace.state()).toEqual(peer);
    expect(await (await page.request.get(historyUrl)).json()).toEqual(timeline);
    await f.panel.getByRole('button', { name: '放弃本次混合移动，保留已保存位置', exact: true }).click();
    await expect(f.panel).toHaveCount(0); expect(f.attempts).toHaveLength(1);
  } finally { await f.close(); }
});

test('原比较GET未完时明确放弃，迟到GET失败不为已退役记录挂错误', async ({ page, workspace }) => {
  const f = await rejectedMove(page, workspace, 'late-read');
  try {
    await expect.poll(() => f.held()).toBe(true); await expect(f.panel).toBeVisible();
    await expect(f.panel.getByText('尚未读取', { exact: true })).toHaveCount(5);
    await f.panel.getByRole('button', { name: '放弃本次混合移动，保留已保存位置', exact: true }).click();
    await expect(f.panel).toHaveCount(0);
    f.release();
    await expect(page.getByRole('status')).toHaveText('已保存到本机');
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(page.locator('.save-state [role=alert]')).toHaveCount(0);
    await expect(page.getByRole('button', { name: '重试画布保存', exact: true })).toHaveCount(0);
    expect(f.attempts).toHaveLength(1);
  } finally { await f.close(); }
});

test('旧v1混合移动记录可恢复而不补造原Pose，未知格式保持原件', async ({ page, workspace }) => {
  const f = await fiveMembers(page, workspace), before = await workspace.state();
  const selected = [before.cards[0]!, before.texts![0]!];
  const command = { commandId: crypto.randomUUID(), projectId: before.project.id, type: 'canvas.move',
    expected: Object.fromEntries(selected.map(value => [value.item.id, value.item.versionId])),
    payload: { targets: selected.map((value, index) => ({ kind: index === 0 ? 'card' : 'text', id: value.id, itemId: value.item.id, x: value.item.pose.x + 40, y: value.item.pose.y + 20 })) } };
  const key = 'forkwise:canvas-move-conflict:v1:legacy', unknown = 'forkwise:canvas-move-conflict:v1:unknown';
  const raw = JSON.stringify({ schema: 1, value: { command, saved: selected.map(value => ({ itemId: value.item.id, position: { x: value.item.pose.x, y: value.item.pose.y } })) } });
  await page.evaluate(({ key, unknown, raw }) => { localStorage.setItem(key, raw); localStorage.setItem(unknown, '{"schema":99,"untouched":true}'); }, { key, unknown, raw });
  await page.reload(); await page.getByRole('button', { name: '恢复混合移动草稿', exact: true }).click();
  const panel = page.getByRole('region', { name: '混合移动保存冲突', exact: true });
  await expect(panel).toBeVisible(); await expect(panel.locator('tbody tr')).toHaveCount(2);
  await expect(panel.getByText('原位置未记录', { exact: true })).toHaveCount(2);
  await panel.getByRole('button', { name: '放弃本次混合移动，保留已保存位置', exact: true }).click();
  await expect(panel).toHaveCount(0); expect(await workspace.state()).toEqual(before);
  expect(await page.evaluate(key => localStorage.getItem(key), unknown)).toBe('{"schema":99,"untouched":true}');
  const timeline = await (await page.request.get(workspace.origin + '/api/mapping/projects/' + before.project.id + '/history')).json();
  expect(timeline).toEqual(f.timeline);
});
