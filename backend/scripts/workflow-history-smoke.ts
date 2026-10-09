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
import { initialResearchFixture } from '../tests/fixtures/initial-research.js';
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
  f = initialResearchFixture(origin);
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
  const frame = page.frameLocator('#native-canvas');
  const history = async (direction: 'undo' | 'redo') => {
    const button = frame.locator(
      `[data-history=${direction}][title="${direction === 'undo' ? '撤销' : '重做'}：梳理并查证"]`,
    );
    await button.waitFor();
    await button.click();
  };
  const start = async () => {
    await page.getByText('对选定材料进行研究', { exact: true }).click();
    await page.locator('#task-kind').selectOption('initial');
    await page.locator('#choose-task-materials').click();
    await page.locator('#task-materials input[value=sv]').check();
    await page.locator('#run-research-task').click();
  };
  await start();
  await waitFor(
    async () =>
      (await api('/jobs')).some(
        (j: any) => j.kind === 'workflow.initial' && j.state === 'succeeded',
      ),
    '首次研究未完成',
  );
  const completed = await api('/state'),
    beforeCalls = { ...f.calls };
  assert.equal(completed.objects.filter((e: any) => e.kind === 'statement').length, 2);
  assert.equal(completed.objects.filter((e: any) => e.kind === 'evidence_link').length, 3);
  assert.equal(completed.objects.filter((e: any) => e.kind === 'verification_node').length, 1);
  await page.locator('#object-list button').filter({ hasText: '本季营收增长' }).waitFor();
  await history('undo');
  await waitFor(
    async () =>
      (await api('/state')).objects.every((e: any) =>
        ['source', 'source_version'].includes(e.kind),
      ),
    '整组撤销未完成',
  );
  await page
    .locator('#jobs .job')
    .filter({ hasText: '首次研究' })
    .filter({ hasText: '研究结果已撤销' })
    .first()
    .waitFor();
  await page.reload();
  await page.locator('#connection').filter({ hasText: '已连接' }).waitFor();
  await history('redo');
  await waitFor(
    async () =>
      (await api('/state')).objects.filter((e: any) => e.kind === 'evidence_link').length === 3,
    '重做未恢复查证',
  );
  assert.deepEqual(
    (await api('/state')).objects.map((e: any) => [e.id, e.data, e.contentVersionId]),
    completed.objects.map((e: any) => [e.id, e.data, e.contentVersionId]),
  );
  assert.deepEqual(f.calls, beforeCalls);
  assert.match((await api('/materials/sv')).text, /营收增长/);
  const row = page.locator('#jobs .job').filter({ hasText: '首次研究' }).first();
  await row.filter({ hasText: '仅保留已完成结果' }).waitFor();
  await row.getByRole('button', { name: '查看任务结果' }).click();
  await page.locator('#task-result').filter({ hasText: '继续查证请发起新的研究任务' }).waitFor();
  // Keep the second workflow's first verification inside a fake external call.
  let enter!: () => void;
  const started = new Promise<void>((r) => {
    enter = r;
  });
  f.hooks.duringVerify = () => {
    enter();
    return new Promise<void>((r) => {
      release = r;
    });
  };
  // The details element is already open from viewing the preceding task.
  await page.locator('#task-kind').selectOption('initial');
  await page.locator('#choose-task-materials').click();
  await page.locator('#task-materials input[value=sv]').check();
  await page.locator('#run-research-task').click();
  await Promise.race([
    started,
    new Promise((_, reject) => setTimeout(() => reject(new Error('查证未启动')), 15_000).unref()),
  ]);
  const partial = await api('/state');
  assert.equal(partial.objects.filter((e: any) => e.kind === 'statement').length, 4);
  await waitFor(
    async () =>
      (await api('/jobs')).some((j: any) => j.kind === 'workflow.initial' && j.state === 'running'),
    '未出现活动流程',
  );
  const active = (await api('/jobs')).find(
    (j: any) => j.kind === 'workflow.initial' && j.state === 'running',
  );
  // The first group's label is identical; wait for synchronization of new history version.
  await page.locator('#object-list button').filter({ hasText: '本季营收增长' }).nth(1).waitFor();
  await history('undo');
  await waitFor(
    async () => (await api('/jobs/' + active.id)).historyState === 'undone',
    '活动任务未停止',
  );
  assert.equal((await api('/jobs/' + active.id)).state, 'cancelled');
  assert.equal((await api('/state')).objects.filter((e: any) => e.kind === 'statement').length, 2);
  await history('redo');
  await waitFor(
    async () => (await api('/jobs/' + active.id)).historyState === 'stopped',
    '重做未保留停止标记',
  );
  release!();
  release = undefined;
  await waitFor(async () => !work, '旧运行未返回');
  assert.deepEqual(
    (await api('/state')).objects.map((e: any) => [e.id, e.data]),
    partial.objects.map((e: any) => [e.id, e.data]),
  );
  assert.equal(
    (await api('/state')).objects.filter((e: any) => e.kind === 'evidence_link').length,
    3,
  );
  await page.reload();
  await page
    .locator('#jobs .job')
    .filter({ hasText: '首次研究' })
    .filter({ hasText: 'cancelled' })
    .filter({ hasText: '仅保留已完成结果' })
    .waitFor();
  assert.equal(
    await page.locator('#jobs').getByRole('button', { name: '重试', exact: true }).count(),
    0,
  );
  const keys = await page.evaluate(() =>
    Object.keys(localStorage).filter((k) => k.startsWith('forkwise-canvas-recovery:')),
  );
  assert.deepEqual(keys, []);
  assert.deepEqual(errors, []);
  mkdirSync('artifacts', { recursive: true });
  await page.screenshot({ path: 'artifacts/workflow-history-browser.png', fullPage: true });
  console.log(
    'PASS 真实 HTTP + Chrome + 原画布：首次研究整组撤销/重做、刷新保留、来源和任务审计保留、活动模型调用停止、立即重做拒绝晚到结果、任务状态与重试入口一致；模型/SEC 为临时合成夹具',
  );
} catch (error) {
  if (page)
    await page
      .screenshot({ path: 'artifacts/workflow-history-browser-failure.png' })
      .catch(() => {});
  throw error;
} finally {
  clearInterval(timer);
  release?.();
  f.app.initialResearch.stop();
  f.app.researchTasks.stop();
  f.app.publicData.stop();
  await work;
  if (browser) await browser.close();
  await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  f.close();
}
