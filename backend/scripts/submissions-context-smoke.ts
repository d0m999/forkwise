// Exercises real API, task execution and UI with a synthetic SEC snapshot and model.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { createServer } from 'node:net';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { submissionsFixture } from '../tests/fixtures/submissions.js';
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
await new Promise<void>((resolve, reject) => listener.close((e) => (e ? reject(e) : resolve())));
const origin = `http://127.0.0.1:${port}`,
  f = submissionsFixture(undefined, origin),
  root = new Hono();
root.use('*', serveStatic({ root: './web' }));
root.route('/', f.app.app);
const server = serve({ fetch: root.fetch, hostname: '127.0.0.1', port }),
  token = f.app.access.issue('human', ['*']);
let browser: any, page: any, work: Promise<void> | undefined;
const errors: string[] = [],
  externalRequests: string[] = [];
const timer = setInterval(() => {
  if (work) return;
  work = f.app.researchTasks
    .drain()
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
const api = async (suffix: string) => {
  const response = await fetch(`${origin}/api/v1/projects/${f.p.id}${suffix}`, {
    headers: { Authorization: 'Bearer ' + token },
  });
  assert.ok(response.ok);
  return (await response.json()).data;
};
try {
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  page = await browser.newPage({ viewport: { width: 1500, height: 1100 } });
  page.on('pageerror', (e: Error) => errors.push(e.message));
  page.on('request', (request: any) => {
    if (/^https:\/\//.test(request.url())) externalRequests.push(request.url());
  });
  await page.goto(origin + '/#token=' + token);
  await page.locator('#connection').filter({ hasText: '已连接' }).waitFor();
  await page.locator('#object-list button[data-id=target]').click();
  await page.getByText('对选定材料进行研究', { exact: true }).click();
  await page.locator('#task-kind').selectOption('verify');
  await page.locator('#choose-task-materials').click();
  await page.locator('#task-materials input[value=sv]').check();
  await page.locator('#task-queries').fill('10-Q');
  await page.locator('#run-research-task').click();
  await page
    .locator('#jobs .job')
    .filter({ hasText: 'research.verify：succeeded' })
    .getByRole('button', { name: '查看任务结果' })
    .click();
  const result = page.locator('#task-result');
  await result.filter({ hasText: '按申报记录选取 2 / 匹配 2 条' }).waitFor();
  await result.filter({ hasText: '正文与附件未读取' }).waitFor();
  await result.filter({ hasText: '另列 1 个历史索引文件' }).waitFor();
  await result.locator(':scope > details > summary').click();
  const rows = result.locator('[data-submission]');
  assert.equal(await rows.count(), 2);
  await rows.nth(0).locator('summary').click();
  const first = await rows.nth(0).textContent();
  assert.match(first, /10-Q · 2025-04-01 · 0000000999-25-000001/);
  assert.match(first, /quarterly.htm/);
  assert.doesNotMatch(first, /amendment.htm/);
  await rows.nth(1).locator('summary').click();
  const second = await rows.nth(1).textContent();
  assert.match(second, /10-Q\/A · 2025-05-01 · 0000000999-25-000002/);
  assert.match(second, /修订申报单独保留/);
  assert.doesNotMatch(second, /quarterly.htm/);
  const link = rows.nth(0).getByRole('link', { name: '打开 SEC 申报文件（外部网页）' });
  assert.equal(
    await link.getAttribute('href'),
    'https://www.sec.gov/Archives/edgar/data/1/000000099925000001/quarterly.htm',
  );
  assert.equal(await link.getAttribute('target'), '_blank');
  assert.equal(await link.getAttribute('rel'), 'noopener noreferrer');
  const before = await api('/state');
  await rows.nth(0).getByRole('button', { name: '定位这条引用', exact: true }).first().click();
  const reader = page.getByRole('dialog', { name: '材料原文阅读' });
  await reader.waitFor();
  assert.equal(await reader.locator('mark').textContent(), '"0000000999-25-000001"');
  assert.equal(await reader.getAttribute('data-version'), 'sv');
  await reader.getByRole('button', { name: '返回画布', exact: true }).click();
  assert.deepEqual((await api('/state')).objects, before.objects);
  assert.equal(before.objects.find((e: any) => e.id === 'target').data.stance.value, 'pending');
  assert.equal(f.calls(), 1);
  assert.deepEqual(externalRequests, []);
  assert.deepEqual(errors, []);
  await rows.nth(0).locator('summary').click();
  await rows.nth(1).locator('summary').click();
  mkdirSync('artifacts', { recursive: true });
  await page.setViewportSize({ width: 1500, height: 1900 });
  await result
    .locator(':scope > details')
    .screenshot({ path: 'artifacts/submissions-context-browser.png' });
  await page.reload();
  await page
    .locator('#jobs .job')
    .filter({ hasText: 'research.verify：succeeded' })
    .getByRole('button', { name: '查看任务结果' })
    .click();
  await result.filter({ hasText: '按申报记录选取 2 / 匹配 2 条' }).waitFor();
  assert.equal(f.calls(), 1);
  console.log(
    'PASS 真实 HTTP + Chrome：创建申报索引查证任务、两项原版/修订申报按行展示、字段与日期不串行、正文/历史未读范围、固定版本原句定位、外链安全属性、阅读不改立场及刷新保留；仅合成来源与模型，未访问 SEC 文件',
  );
} catch (error) {
  if (page)
    await page
      .screenshot({ path: 'artifacts/submissions-context-browser-failure.png' })
      .catch(() => {});
  throw error;
} finally {
  clearInterval(timer);
  f.app.researchTasks.stop();
  await work;
  if (browser) await browser.close();
  await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  f.app.db.close();
}
