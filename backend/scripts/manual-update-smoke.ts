/** Real local HTTP + disk SQLite + isolated Chromium; external model output is synthetic. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { createServer } from 'node:net';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { createApplication } from '../src/app.js';
import { human, statement, inference, expectedOf } from '../tests/helpers.js';
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
const directory = mkdtempSync(join(tmpdir(), 'forkwise-manual-update-')),
  origin = `http://127.0.0.1:${port}`;
const app = createApplication({
  database: join(directory, 'test.sqlite'),
  origin,
  researchModel: {
    async generate(schema, _purpose, raw) {
      const scope = raw as any;
      return {
        result: schema.parse({
          proposals: scope.targets.map((target: any) => ({
            target: { id: target.id, versionId: target.contentVersionId },
            proposedText: '依据新材料补充限制',
            reason: '合成材料显示范围有限',
            gaps: [],
            citations: [
              {
                sourceVersionId: scope.materials[0].id,
                start: 0,
                end: 4,
                quote: scope.materials[0].text.slice(0, 4),
              },
            ],
          })),
          gaps: [],
        }),
        usage: null,
      };
    },
  },
});
const project = app.write.createProject(human, randomUUID(), { name: '手动更新浏览器隔离研究' }),
  state = () => app.repo.snapshot(project.id);
const write = (commands: any[]) =>
  app.write.execute(project.id, human, randomUUID(), {
    expected: expectedOf(state().objects),
    commands,
  });
write([
  statement('a', '需求持续增长'),
  statement('b', '收入可能增加'),
  inference('i', ['a'], 'b', '需求传导到收入'),
  {
    op: 'source.create',
    id: 'source',
    data: { title: '合成新披露', publisher: '隔离测试', rights: 'authorized' },
  },
]);
const root = new Hono();
root.use('*', serveStatic({ root: './web' }));
root.route('/', app.app);
const server = serve({ fetch: root.fetch, hostname: '127.0.0.1', port }),
  token = app.access.issue('human', ['*']);
let browser: any, page: any;
const errors: string[] = [];
try {
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on('pageerror', (e: Error) => errors.push(e.message));
  await page.goto(origin + '/#token=' + token);
  await page.locator('#connection').filter({ hasText: '已连接' }).waitFor();
  const open = () => page.locator('#open-manual-updates').click();
  await open();
  const dialog = page.locator('#manual-update-dialog');
  await dialog.locator('[name=scopeLabel]').fill('合成公司经营变化');
  await dialog.locator('[name=sourceId]').selectOption('source');
  await dialog.locator('[name=text]').fill('新增披露显示需求范围有限。');
  await dialog.locator('[name=coverage]').selectOption('full');
  await dialog.locator('[data-targets] input[value=a]').check();
  await dialog.locator('[data-targets] input[value=i]').check();
  await dialog.getByRole('button', { name: '返回画布', exact: true }).click();
  await page.reload();
  await page.locator('#connection').filter({ hasText: '已连接' }).waitFor();
  await open();
  assert.equal(await dialog.locator('[name=text]').inputValue(), '新增披露显示需求范围有限。');
  const preview = async () => {
    const response = page.waitForResponse(
      (r: any) => r.url().endsWith('/manual-updates/preview') && r.status() === 200,
    );
    await dialog.getByRole('button', { name: '预览更新范围与用量', exact: true }).click();
    await response;
    // Click completion does not await the application handler. Only mutate a
    // premise after this exact preview has returned and released its UI lock.
    await page.waitForFunction(
      () =>
        !document.querySelector<HTMLFieldSetElement>('#manual-update-dialog [data-confirm]')!
          .disabled &&
        !document.querySelector<HTMLButtonElement>('#manual-update-dialog [data-submit]')!.disabled,
    );
  };
  await preview();
  await dialog.getByRole('heading', { name: '请核对本次更新范围' }).waitFor();
  assert.equal(app.jobs.list(project.id).length, 0);
  assert.equal(state().objects.filter((e) => e.kind === 'source_version').length, 0);
  assert.match(await dialog.locator('[data-preview]').innerText(), /新增分析 2 项/);
  mkdirSync('artifacts', { recursive: true });
  await page.screenshot({ path: 'artifacts/manual-update-preview.png', fullPage: true });
  let lose = true;
  await page.route('**/manual-updates', async (route: any) => {
    if (route.request().method() === 'POST' && lose) {
      lose = false;
      await route.fetch();
      await route.abort('failed');
    } else await route.continue();
  });
  await dialog.getByRole('button', { name: '确认范围，保存并分析' }).click();
  await dialog.locator('[data-recover]').waitFor();
  assert.equal(app.jobs.list(project.id).length, 1);
  await page.reload();
  await page.locator('#connection').filter({ hasText: '已连接' }).waitFor();
  await open();
  await dialog.getByRole('button', { name: '恢复原更新请求' }).click();
  await dialog.locator('.update-event').waitFor();
  assert.equal(app.jobs.list(project.id).length, 1);
  assert.equal(state().objects.filter((e) => e.kind === 'source_version').length, 1);
  const job = app.jobs.list(project.id)[0];
  assert(job, '更新应已创建一个分析任务');
  await app.researchTasks.run(project.id, job.id);
  assert.equal(app.jobs.get(project.id, job.id).state, 'succeeded');
  await dialog.getByRole('button', { name: '刷新更新记录' }).click();
  await dialog
    .getByText('1 批分析 · 2 条建议 · 0 批处理中 · 0 批待处理', { exact: true })
    .waitFor();
  await preview();
  await dialog.locator('[data-preview]').filter({ hasText: '新增分析 0 项' }).waitFor();
  await dialog.getByRole('button', { name: '确认范围，保存并分析' }).click();
  await dialog.locator('[data-feedback]').filter({ hasText: '未重复生成候选' }).waitFor();
  assert.equal(app.jobs.list(project.id).length, 1);
  await dialog.getByRole('button', { name: '展开本次更新' }).click();
  await dialog.getByRole('button', { name: '复核本批建议' }).click();
  await page.locator('#impact-review-dialog .impact-review-row').first().waitFor();
  assert.equal(await page.locator('#impact-review-dialog .impact-review-row').count(), 2);
  await page
    .locator('#impact-review-dialog')
    .getByRole('button', { name: '返回画布', exact: true })
    .click();
  await open();
  await dialog.locator('[name=text]').fill('新增披露修订了上一版范围。');
  await preview();
  write([{ op: 'statement.edit', id: 'a', text: '另一个标签页改写了前提', scope: 'all' }]);
  await dialog.getByRole('button', { name: '确认范围，保存并分析' }).click();
  await dialog.locator('[data-feedback]').filter({ hasText: '重新预览' }).waitFor();
  assert.equal(state().objects.filter((e) => e.kind === 'source_version').length, 1);
  assert.equal(await dialog.locator('[name=text]').inputValue(), '新增披露修订了上一版范围。');
  await dialog.getByRole('button', { name: '保留草稿，重新预览' }).click();
  await preview();
  await dialog.locator('[data-preview]').filter({ hasText: '另一个标签页改写了前提' }).waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: 'artifacts/manual-update-narrow.png', fullPage: true });
  const bounds = await dialog.boundingBox();
  assert(bounds && bounds.x >= 0 && bounds.x + bounds.width <= 391);
  assert.equal(errors.length, 0, errors.join('\n'));
  console.log(
    'PASS: 更新草稿跨刷新、预览无副作用、原文与目标范围、成功响应丢失后原请求恢复、同版本重复分析去重、事件归集及复核入口、前提并发冲突原子拒绝与草稿保留、重新预览和 390px 窄窗；仅临时数据和合成模型。',
  );
} catch (error) {
  console.log(
    'VISIBLE_FEEDBACK',
    await page?.locator('#manual-update-dialog [data-feedback]').textContent(),
  );
  throw error;
} finally {
  await browser?.close();
  await new Promise<void>((r) => server.close(() => r()));
  app.db.close();
  rmSync(directory, { recursive: true, force: true });
}
