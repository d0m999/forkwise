/** Real HTTP + browser path; only model and SEC responses are synthetic fixtures. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { initialFilingsFixture } from '../tests/fixtures/initial-filings.js';
const require = createRequire(import.meta.url);
const { chromium } = require(
  join(
    homedir(),
    '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright',
  ),
);
const listener = createServer();
await new Promise<void>((r) => {
  listener.listen(0, '127.0.0.1', r);
});
const port = (listener.address() as { port: number }).port;
await new Promise<void>((r, j) => listener.close((e) => (e ? j(e) : r())));
const origin = `http://127.0.0.1:${port}`,
  f = initialFilingsFixture(origin);
const root = new Hono();
root.use('*', serveStatic({ root: './web' }));
root.route('/', f.app.app);
const server = serve({ fetch: root.fetch, hostname: '127.0.0.1', port });
const token = f.app.access.issue('human', ['*']);
let work: Promise<void> | undefined, browser: any, page: any, release: (() => void) | undefined;
const errors: string[] = [];
const timer = setInterval(() => {
  if (work) return;
  work = Promise.all([
    f.app.initialResearch.drain(),
    f.app.researchTasks.drain(),
    f.app.publicData.drain(),
    f.app.filings.drain(),
  ])
    .then(
      () => {},
      (e) => {
        errors.push(String(e));
      },
    )
    .finally(() => {
      work = undefined;
    });
}, 100);
const path = `/projects/${f.p.id}`;
const api = async (suffix: string, method = 'GET', body?: unknown) => {
  const response = await fetch(origin + '/api/v1' + path + suffix, {
    method,
    headers: {
      Authorization: 'Bearer ' + token,
      'Content-Type': 'application/json',
      'Idempotency-Key': randomUUID(),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const result = await response.json();
  assert.ok(response.ok, JSON.stringify(result));
  return result.data;
};
const waitFor = async (read: () => Promise<unknown>, message: string) => {
  for (let i = 0; i < 160; i++) {
    if (await read()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(message);
};
try {
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  page = await browser.newPage({ viewport: { width: 1560, height: 1080 } });
  page.on('pageerror', (e: Error) => errors.push(e.message));
  await page.goto(origin + '/#token=' + token);
  await page.locator('#connection').filter({ hasText: '已连接' }).waitFor();
  f.filingHooks.failBody = true;
  await page.getByText('对选定材料进行研究', { exact: true }).click();
  await page.locator('#task-kind').selectOption('initial');
  await page.locator('#choose-task-materials').click();
  await page.locator('#task-materials input[value=sv]').check();
  await page.locator('#run-research-task').click();
  await waitFor(
    async () =>
      (await api('/jobs')).some((j: any) => j.kind === 'workflow.initial' && j.state === 'partial'),
    '正文权限失败未保留部分结果',
  );
  const task = (await api('/jobs')).find((j: any) => j.kind === 'workflow.initial');
  const row = page.locator('#jobs .job').filter({ hasText: '首次研究' }).first();
  await row.getByRole('button', { name: '查看任务结果' }).click();
  const result = page.locator('#task-result');
  await result
    .getByText(/自动选报：10-Q/)
    .first()
    .waitFor({ timeout: 4000 });
  assert.match(await result.innerText(), /2025-04-01.*2025-04-30/);
  assert.match(await result.innerText(), /ACCESS_DENIED/);
  assert.match(await result.innerText(), /历史文件/);
  f.filingHooks.failBody = false;
  await row.getByRole('button', { name: '重试', exact: true }).click();
  await waitFor(
    async () => (await api('/jobs/' + task.id)).state === 'succeeded',
    '正文补取后未完成查证',
  );
  await page.reload();
  await page.locator('#connection').filter({ hasText: '已连接' }).waitFor();
  await page
    .locator('#jobs .job')
    .filter({ hasText: '首次研究' })
    .first()
    .getByRole('button', { name: '查看任务结果' })
    .click();
  await result
    .getByText(/自动选报：10-Q/)
    .first()
    .waitFor();
  assert.match(await result.innerText(), /正文.*材料已取得/);
  assert.equal(await result.getByRole('button', { name: '查看此前材料下的查证' }).count(), 3);
  const finished = await api('/jobs/' + task.id),
    body = finished.output.filings.acquisitions[0];
  assert.equal(f.network.filter((url) => url.includes('/submissions/')).length, 1);
  assert.equal(f.network.filter((url) => url.includes('/Archives/')).length, 2);
  for (const check of finished.output.checks) {
    const detail = await api('/jobs/' + check.jobId);
    assert.equal(detail.output.result.checks[0].citations[0].sourceVersionId, body.sourceVersionId);
  }
  const objects = (await api('/state')).objects;
  assert.ok(
    objects
      .filter((e: any) => ['statement', 'inference'].includes(e.kind))
      .every((e: any) => e.data.stance.value === 'pending'),
  );
  mkdirSync('artifacts', { recursive: true });
  await result.scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'artifacts/initial-filings-browser-wide.png', fullPage: true });
  await result.getByRole('button', { name: '查看正文获取结果' }).click();
  await result.getByRole('button', { name: '查看保存的申报正文' }).click();
  await page.locator('.text-reader-dialog').filter({ hasText: 'Synthetic revenue: 12.' }).waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: 'artifacts/initial-filings-browser-narrow.png' });
  assert.deepEqual(errors, []);
  console.log(
    'PASS 真实 HTTP/SQLite/Chrome/原画布：首次研究自动选报、正文权限失败与原任务续跑、刷新保留范围/缺口、正文引用及阅读、个人立场未改变；外部模型与 SEC 响应为合成夹具',
  );
} catch (error) {
  if (page)
    await page
      .screenshot({ path: 'artifacts/initial-filings-browser-failure.png' })
      .catch(() => {});
  throw error;
} finally {
  clearInterval(timer);
  release?.();
  f.app.initialResearch.stop();
  f.app.researchTasks.stop();
  f.app.publicData.stop();
  f.app.filings.stop();
  await work;
  if (browser) await browser.close();
  await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  f.close();
}
