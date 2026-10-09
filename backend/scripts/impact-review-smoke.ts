/** Isolated browser + real local HTTP/SQLite; only model output is synthetic. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { createServer } from 'node:net';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { impactReviewFixture } from '../tests/fixtures/impact-review.js';
const require = createRequire(import.meta.url);
const { chromium } = require(
  join(
    homedir(),
    '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright',
  ),
);
const listener = createServer();
await new Promise<void>((r) => listener.listen(0, '127.0.0.1', r));
const port = (listener.address() as { port: number }).port;
await new Promise<void>((r, j) => listener.close((e) => (e ? j(e) : r())));
const directory = mkdtempSync(join(tmpdir(), 'forkwise-impact-review-'));
const origin = `http://127.0.0.1:${port}`,
  f = await impactReviewFixture(origin, join(directory, 'test.sqlite'));
const root = new Hono();
root.use('*', serveStatic({ root: './web' }));
root.route('/', f.app.app);
const server = serve({ fetch: root.fetch, hostname: '127.0.0.1', port });
const token = f.app.access.issue('human', ['*']);
let browser: any, page: any;
const errors: string[] = [];
try {
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  page = await browser.newPage({ viewport: { width: 1560, height: 1080 } });
  page.on('pageerror', (e: Error) => errors.push(e.message));
  await page.goto(origin + '/#token=' + token);
  await page.locator('#connection').filter({ hasText: '已连接' }).waitFor();
  const open = async () => {
    await page.locator('#open-impact-reviews').click();
    await page.locator('.impact-review-row').first().waitFor();
  };
  const row = () => page.locator(`.impact-review-row[data-proposal="${f.task.id}_0"]`);
  let failRead = true;
  await page.route('**/impact-reviews?**', async (route: any) => {
    if (failRead) {
      failRead = false;
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ code: 'TEST_UNAVAILABLE', message: '合成读取暂不可用', data: null }),
      });
    } else await route.continue();
  });
  await page.locator('#open-impact-reviews').click();
  await page
    .locator('#impact-review-dialog [data-review-read-error]')
    .filter({ hasText: '合成读取暂不可用' })
    .waitFor();
  await page.getByRole('button', { name: '重试读取', exact: true }).click();
  await page.locator('.impact-review-row').first().waitFor();
  await page.unroute('**/impact-reviews?**');
  await row().getByRole('button', { name: '查看并复核' }).click();
  const dialog = page.locator('#impact-review-dialog');
  const reason = () => dialog.locator('textarea[name=reason]');
  const select = () => dialog.locator('select[name=disposition]');
  const save = () => dialog.getByRole('button', { name: '保存本条复核' }).click();
  await reason().fill('已检查合成新披露，暂维持原判断。');
  await dialog.getByRole('button', { name: '返回画布', exact: true }).click();
  await page.reload();
  await page.locator('#connection').filter({ hasText: '已连接' }).waitFor();
  await open();
  await row().getByRole('button', { name: '查看并复核' }).click();
  assert.equal(await reason().inputValue(), '已检查合成新披露，暂维持原判断。');
  const before = f.get('i');
  await save();
  await dialog.getByRole('heading', { name: '本条已复核', exact: true }).waitFor();
  assert.deepEqual(f.get('i'), before);
  await dialog.getByRole('button', { name: '返回建议列表' }).click();
  await row().getByText('本条已复核', { exact: true }).waitFor();
  assert.equal(
    await page.locator('.impact-review-row').getByText('需复核', { exact: true }).count(),
    1,
  );
  await row().getByRole('button', { name: '查看并复核' }).click();
  await select().selectOption('later');
  await reason().fill('');
  await save();
  await dialog.getByRole('heading', { name: '稍后处理 · 仍需复核', exact: true }).waitFor();
  await select().selectOption('maintained');
  await reason().fill('正在复核，保留这段草稿');
  f.write([{ op: 'statement.edit', id: 'a', text: '前提已改为新的适用范围', scope: 'all' }]);
  await save();
  await dialog.locator('[data-review-feedback]').filter({ hasText: '草稿' }).waitFor();
  assert.equal(await reason().inputValue(), '正在复核，保留这段草稿');
  await dialog.getByRole('button', { name: '重新读取当前内容，保留草稿' }).click();
  await dialog.getByText('当前上下文 a：前提已改为新的适用范围', { exact: true }).waitFor();
  await save();
  await dialog.locator('[data-review-feedback]').filter({ hasText: '请先对照' }).waitFor();
  await dialog.locator('input[name=rechecked]').check();
  await save();
  await dialog.getByRole('heading', { name: '本条已复核', exact: true }).waitFor();
  await dialog.getByRole('button', { name: '查看复核修改历史' }).click();
  await dialog
    .locator('[data-review-history]')
    .getByText(/稍后处理/)
    .waitFor();
  assert.equal(
    f.app.repo.history(f.project.id, f.state().objects.find((e) => e.kind === 'review')!.id).length,
    3,
  );
  mkdirSync('artifacts', { recursive: true });
  await page.screenshot({ path: 'artifacts/impact-review-browser-wide.png' });
  await dialog.getByRole('button', { name: '定位建议原文' }).click();
  await page.locator('.text-reader-dialog').filter({ hasText: '新增披露' }).waitFor();
  await page
    .locator('.text-reader-dialog')
    .getByRole('button', { name: '返回画布', exact: true })
    .click();
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await dialog.evaluate((e: HTMLElement) => e.getBoundingClientRect().width <= 390));
  await page.screenshot({ path: 'artifacts/impact-review-browser-narrow.png' });
  assert.deepEqual(errors, []);
  console.log(
    'PASS 真实本机 HTTP/SQLite/Chrome/原画布：逐条复核、维持/稍后、草稿跨刷新、前提并发变更拒绝与明确复核、历史与原文、窄窗；个人立场保持。模型输出为合成，未使用用户数据。',
  );
} catch (error) {
  if (page)
    await page.screenshot({ path: 'artifacts/impact-review-browser-failure.png' }).catch(() => {});
  throw error;
} finally {
  if (browser) await browser.close();
  await new Promise<void>((r, j) => server.close((e) => (e ? j(e) : r())));
  f.app.db.close();
  rmSync(directory, { recursive: true, force: true });
}
