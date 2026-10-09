/** Real HTTP/SQLite/Chrome and native canvas; external model/SEC responses are synthetic. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { initialResearchFixture } from '../tests/fixtures/initial-research.js';
import { human, expectedOf } from '../tests/helpers.js';
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
const origin = `http://127.0.0.1:${port}`,
  f = initialResearchFixture(origin),
  root = new Hono();
root.use('*', serveStatic({ root: './web' }));
root.route('/', f.app.app);
const server = serve({ fetch: root.fetch, hostname: '127.0.0.1', port });
const token = f.app.access.issue('human', ['*']);
let browser: any, page: any;
const errors: string[] = [],
  external: string[] = [];
const write = (commands: any[]) =>
  f.app.write.execute(f.p.id, human, crypto.randomUUID(), {
    commands,
    expected: expectedOf(f.app.repo.snapshot(f.p.id).objects),
  });
const waitFor = async (read: () => Promise<boolean>, label: string) => {
  for (let i = 0; i < 150; i++) {
    if (await read()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(label);
};
try {
  const job = f.app.initialResearch.request(f.p.id, human, 'results-browser-initial', {
    sourceVersionIds: ['sv'],
  });
  assert.equal((await f.app.initialResearch.run(f.p.id, job.id)).state, 'succeeded');
  const initial = f.app.repo.snapshot(f.p.id);
  const prediction = initial.objects.find(
    (e) => e.kind === 'statement' && e.data.text.includes('明年'),
  )!;
  const premise = initial.objects.find((e) => e.kind === 'statement' && e.id !== prediction.id)!;
  const inference = initial.objects.find((e) => e.kind === 'inference')!;
  const candidate = initial.objects.find(
    (e) => e.kind === 'evidence_link' && e.data.target.id === prediction.id,
  )!;
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  page = await browser.newPage({ viewport: { width: 1560, height: 1080 } });
  page.on('pageerror', (e: Error) => errors.push(e.message));
  page.on('request', (r: any) => {
    if (/^https:\/\//.test(r.url())) external.push(r.url());
  });
  await page.goto(origin + '/#token=' + token);
  await page.locator('#connection').filter({ hasText: '已连接' }).waitFor();
  const frame = page.frameLocator('#native-canvas');
  const check = frame.locator(`[data-check-card="${prediction.id}"]`);
  await waitFor(
    async () => (await check.getAttribute('aria-label'))?.includes('候选依据 1'),
    '画布未显示候选依据',
  );
  await check.click();
  const panel = page.locator('#object-results');
  await panel.locator('[data-result-job]').filter({ hasText: '预测的当前依据' }).waitFor();
  assert.match(await page.locator('#verification-node').innerText(), /下一财年年度报告/);
  assert.equal(await page.locator('#edit [name=stance]').inputValue(), 'pending');
  const link = panel.locator(`[data-evidence-link="${candidate.id}"]`);
  await link.locator('summary').click();
  await link.getByRole('button', { name: '定位这条依据', exact: true }).click();
  const reader = page.getByRole('dialog', { name: '材料原文阅读' });
  await reader.locator('mark').waitFor();
  assert.equal(await reader.locator('mark').textContent(), 'Synthetic');
  await reader.getByRole('button', { name: '返回画布', exact: true }).click();
  await link.getByRole('button', { name: '采用这条依据', exact: true }).click();
  await waitFor(
    async () => (await check.getAttribute('aria-label'))?.includes('已采用依据 1'),
    '采用未同步到画布',
  );
  assert.equal(await page.locator('#edit [name=stance]').inputValue(), 'pending');
  const adopted = f.app.repo.snapshot(f.p.id).objects.find((e) => e.id === candidate.id);
  assert.ok(adopted?.kind === 'evidence_link');
  assert.equal(adopted.data.participation, 'adopted');
  await page.screenshot({ path: 'artifacts/research-results-browser.png' });

  // A premise edit invalidates inference evidence, but leaves a separate prediction's evidence valid.
  write([{ op: 'statement.edit', id: premise.id, text: '已改写的营收前提', scope: 'all' }]);
  await page.locator('#refresh').click();
  await page.locator('#object-list button').filter({ hasText: '营收可能带动利润' }).click();
  await panel
    .locator('[data-evidence-link] summary')
    .filter({ hasText: '对应旧内容或前提' })
    .waitFor();
  assert.equal(await panel.getByRole('button', { name: '采用这条依据', exact: true }).count(), 0);
  await frame.locator(`[data-object-action="judgment"][data-object-id="${inference.id}"]`).click();
  assert.ok(await panel.getByRole('heading', { name: '查证依据与记录' }).isVisible());
  for (const width of [1000, 390, 1560]) {
    await page.setViewportSize({ width, height: 1080 });
    await waitFor(async () => {
      const toolbar = await frame.locator('.object-toolbar').boundingBox(),
        connections = await frame.locator('.connection-actions').boundingBox();
      return Boolean(toolbar && connections && toolbar.y + toolbar.height <= connections.y);
    }, `推导工具条在 ${width}px 仍遮挡`);
    await frame
      .locator(`[data-object-action="judgment"][data-object-id="${inference.id}"]`)
      .click();
    await frame.getByRole('button', { name: '更换前提', exact: true }).click();
    await frame
      .locator('.connection-pick')
      .getByRole('button', { name: '取消', exact: true })
      .click();
  }

  // More than one page, including zero-hit checks with no evidence or model call.
  for (let n = 0; n < 21; n++) {
    const task = f.app.researchTasks.request(f.p.id, human, `browser-empty-${n}`, {
      kind: 'verify',
      sourceVersionIds: ['sv'],
      targetIds: [inference.id],
      retrieval: { queries: [`MissingToken${n}`] },
    });
    await f.app.researchTasks.run(f.p.id, task.id);
  }
  await page.locator('#refresh').click();
  await panel.getByRole('button', { name: '读取更早的核对记录' }).waitFor();
  assert.equal(await panel.locator('[data-result-job]').count(), 20);
  assert.match(await panel.innerText(), /最近核对证据不足/);
  assert.match(await panel.innerText(), /未调用模型/);
  await panel.getByRole('button', { name: '读取更早的核对记录' }).click();
  await waitFor(
    async () => (await panel.locator('[data-result-job]').count()) === 22,
    '分页遗漏记录',
  );
  assert.equal(await panel.getByRole('button', { name: '读取更早的核对记录' }).count(), 0);

  // A late detail response cannot replace another project's selected object.
  const other = f.app.write.createProject(human, 'results-browser-other', { name: '另一个空项目' });
  await page.reload();
  await page.locator('#connection').filter({ hasText: '已连接' }).waitFor();
  await page.locator('#project').selectOption(f.p.id);
  let release!: () => void, entered!: () => void, delivered!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const started = new Promise<void>((r) => {
    entered = r;
  });
  const returned = new Promise<void>((r) => {
    delivered = r;
  });
  let delayed = false;
  await page.route(`**/objects/${prediction.id}/research-results*`, async (route: any) => {
    if (delayed) return route.continue();
    delayed = true;
    const response = await route.fetch();
    entered();
    await gate;
    await route.fulfill({ response });
    delivered();
  });
  await page.locator('#object-list button').filter({ hasText: '明年利润可能翻倍' }).click();
  await started;
  await page.locator('#project').selectOption(other.id);
  release();
  await returned;
  await waitFor(async () => await panel.isHidden(), '旧项目结果未隐藏');
  await page.unroute(`**/objects/${prediction.id}/research-results*`);
  await page.locator('#project').selectOption(f.p.id);
  await page.locator('#object-list button').filter({ hasText: '明年利润可能翻倍' }).click();
  await panel.locator('[data-evidence-link] summary').filter({ hasText: '本人已采用' }).waitFor();
  assert.equal(await page.locator('#edit [name=stance]').inputValue(), 'pending');
  await page.setViewportSize({ width: 390, height: 844 });
  await panel.scrollIntoViewIfNeeded();
  const bounds = await panel.boundingBox();
  assert.ok(bounds && bounds.x >= 0 && bounds.x + bounds.width <= 391);
  await page.screenshot({ path: 'artifacts/research-results-narrow.png' });
  assert.deepEqual(errors, []);
  assert.deepEqual(external, []);
  console.log(
    'PASS 对象查证、预测当前依据、独立验证节点、原文定位、采用后立场保持、前提改写使推导旧结果需复核、零命中与历史分页、迟到响应跨项目隔离、刷新和窄窗；真实本机 HTTP/SQLite/Chrome，合成外部响应。',
  );
} catch (error) {
  if (page)
    await page.screenshot({ path: 'artifacts/research-results-failure.png' }).catch(() => {});
  throw error;
} finally {
  if (browser) await browser.close();
  await new Promise<void>((r, j) => server.close((e) => (e ? j(e) : r())));
  f.close();
}
