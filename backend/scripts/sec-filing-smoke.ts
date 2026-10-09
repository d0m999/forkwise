// Real local HTTP/SQLite/Chrome; only SEC responses and model output are synthetic.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { createServer } from 'node:net';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { filingFixture } from '../tests/fixtures/sec-filings.js';
import { human, statement } from '../tests/helpers.js';
import type { StructuredModel } from '../src/services/research-tasks.js';
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
await new Promise<void>((r) => listener.close(() => r()));
const origin = `http://127.0.0.1:${port}`;
const model: StructuredModel = {
  async generate(schema, _purpose, raw) {
    const input = raw as any;
    return {
      result: schema.parse({
        checks: input.targets.map((t: any) => ({
          target: { id: t.id, versionId: t.contentVersionId },
          relation: 'insufficient',
          aspect: 'reported_fact',
          explanation: '合成索引不证明收入',
          citations: [],
          gaps: ['需要正文'],
        })),
        gaps: [],
      }) as any,
      usage: { cost: null },
    };
  },
};
const f = await filingFixture(origin, model),
  root = new Hono();
f.app.write.execute(f.project.id, human, 'smoke-target', {
  expected: {},
  commands: [statement('target', '核对本季收入')],
});
const task = f.app.researchTasks.request(f.project.id, human, 'smoke-submissions-check', {
  kind: 'verify',
  targetIds: ['target'],
  sourceVersionIds: [f.request.indexSourceVersionId],
  retrieval: { queries: ['10-Q'], maxCharacters: 80000 },
});
await f.app.researchTasks.run(f.project.id, task.id);
root.use('*', serveStatic({ root: './web' }));
root.route('/', f.app.app);
const server = serve({ fetch: root.fetch, hostname: '127.0.0.1', port }),
  token = f.app.access.issue('human', ['*']);
let browser: any, page: any, work: Promise<void> | undefined;
const errors: string[] = [];
const timer = setInterval(() => {
  if (work) return;
  work = f.app.filings
    .drain()
    .catch((e) => errors.push(String(e)))
    .then(() => {})
    .finally(() => {
      work = undefined;
    });
}, 100);
try {
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  page = await browser.newPage({ viewport: { width: 1500, height: 1050 } });
  page.on('pageerror', (e: Error) => errors.push(e.message));
  await page.goto(origin + '/#token=' + token);
  await page.locator('#connection').filter({ hasText: '已连接' }).waitFor();
  await page
    .locator('#jobs .job')
    .filter({ hasText: 'research.verify：succeeded' })
    .getByRole('button', { name: '查看任务结果' })
    .click();
  const result = page.locator('#task-result');
  await result.locator(':scope > details > summary').click();
  await result.locator('[data-submission] > summary').click();
  let dropped = false;
  await page.route('**/public-data/filing', async (route: any) => {
    if (dropped) {
      await route.continue();
      return;
    }
    dropped = true;
    const response = await route.fetch();
    assert.equal(response.status(), 200);
    await route.abort('failed');
  });
  await result.getByRole('button', { name: '获取正文并保存为材料' }).click();
  await page.getByRole('button', { name: '恢复研究请求', exact: true }).waitFor();
  assert.ok(dropped);
  await page.reload();
  await page.getByRole('button', { name: '恢复研究请求', exact: true }).click();
  await page.getByRole('button', { name: '恢复原研究请求', exact: true }).click();
  await page.locator('#entry-close').click();
  await page
    .locator('#jobs .job')
    .filter({ hasText: 'source.sec-filing：succeeded' })
    .getByRole('button', { name: '查看任务结果' })
    .click();
  await result.filter({ hasText: 'HTML 主文件已保存' }).waitFor();
  await result.filter({ hasText: '未获取附件' }).waitFor();
  await result.getByRole('button', { name: '查看保存的申报正文' }).click();
  await page
    .getByRole('dialog', { name: '材料原文阅读' })
    .filter({ hasText: 'Synthetic revenue: 12.' })
    .waitFor();
  assert.equal(
    f.app.jobs.list(f.project.id).filter((j) => j.kind === 'source.sec-filing').length,
    1,
  );
  assert.equal(f.calls.length, 2);
  assert.equal(
    (f.app.repo.snapshot(f.project.id).objects.find((e) => e.id === 'target')!.data as any).stance
      .value,
    'pending',
  );
  assert.equal(
    f.app.repo.snapshot(f.project.id).objects.filter((e) => e.kind === 'evidence_link').length,
    0,
  );
  mkdirSync('artifacts', { recursive: true });
  await page.screenshot({ path: 'artifacts/sec-filing-browser.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: 'artifacts/sec-filing-narrow.png', fullPage: true });
  assert.deepEqual(errors, []);
  console.log(
    'PASS 从固定索引记录取得并保存 HTML 主文件、任务完成、正文阅读、响应丢失后跨刷新原键恢复且单份任务、个人立场保持、窄窗；真实 HTTP/SQLite/Chrome，SEC 与模型仅合成响应。',
  );
} catch (e) {
  if (page) {
    mkdirSync('artifacts', { recursive: true });
    await page.screenshot({ path: 'artifacts/sec-filing-failure.png', fullPage: true });
  }
  throw e;
} finally {
  clearInterval(timer);
  f.app.filings.stop();
  await work;
  await browser?.close();
  await new Promise<void>((r) => server.close(() => r()));
  f.close();
}
