/** Real HTTP, IndexedDB and Chrome; only SEC/model responses are synthetic. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
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
  f = initialResearchFixture(origin),
  root = new Hono();
root.use('*', serveStatic({ root: './web' }));
root.route('/', f.app.app);
const server = serve({ fetch: root.fetch, hostname: '127.0.0.1', port });
const token = f.app.access.issue('human', ['*']);
let browser: any, page: any, work: Promise<void> | undefined;
const errors: string[] = [],
  external: string[] = [];
const timer = setInterval(() => {
  if (work) return;
  work = Promise.all([
    f.app.initialResearch.drain(),
    f.app.researchTasks.drain(),
    f.app.publicData.drain(),
    f.app.files.drain(),
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
const api = async (project: string, suffix: string) => {
  const response = await fetch(`${origin}/api/v1/projects/${project}${suffix}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.ok(response.ok);
  return (await response.json()).data;
};
const waitFor = async (read: () => Promise<boolean>, label: string) => {
  for (let i = 0; i < 200; i++) {
    if (await read()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(label);
};
try {
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  page = await browser.newPage({ viewport: { width: 1560, height: 1080 } });
  page.on('pageerror', (e: Error) => errors.push(e.message));
  page.on('request', (r: any) => {
    if (/^https:\/\//.test(r.url())) external.push(r.url());
  });
  await page.goto(origin + '/#token=' + token);
  await page.locator('#connection').filter({ hasText: '已连接' }).waitFor();
  await page.locator('#canvas-research-entry button').click();
  const dialog = page.getByRole('dialog', { name: '输入观点与材料' });
  const text = 'CIK 1 本季营收增长，明年利润可能翻倍。';
  await dialog.locator('[name=text]').fill(text);
  await dialog.getByText('材料出处与范围', { exact: true }).click();
  await dialog.locator('[name=title]').fill('X 观点合成样本');
  await dialog.locator('[name=publisher]').fill('合成作者');
  await dialog.locator('[name=url]').fill('https://example.invalid/post/1');
  await dialog.locator('#entry-close').click();
  await page.locator('#new-project [name=name]').fill('另一个研究');
  await page.locator('#new-project button').click();
  await page.locator('#notice').filter({ hasText: '新项目已保存' }).waitFor();
  const other = await page.locator('#project').inputValue();
  await page.locator('#open-research-entry').click();
  assert.equal(await dialog.locator('[name=text]').inputValue(), '');
  await dialog.locator('[name=text]').fill('另一个项目的未提交草稿');
  await dialog.locator('#entry-close').click();
  await page.locator('#project').selectOption(f.p.id);
  await waitFor(
    async () => (await page.locator('#revision').textContent()).includes('1'),
    '原项目未切回',
  );
  await page.reload();
  await page.locator('#connection').filter({ hasText: '已连接' }).waitFor();
  await page.locator('#project').selectOption(f.p.id);
  await page.locator('#open-research-entry').click();
  assert.equal(await dialog.locator('[name=text]').inputValue(), text);
  let loseMaterial = true,
    loseTask = true;
  await page.route('**/api/v1/projects/**', async (route: any) => {
    const request = route.request(),
      url = request.url();
    if (
      request.method() === 'POST' &&
      ((loseMaterial &&
        url.endsWith('/operations') &&
        request.postDataJSON()?.commands?.some((c: any) => c.op === 'source.import')) ||
        (loseTask && url.endsWith('/initial-research')))
    ) {
      await route.fetch();
      if (url.endsWith('/operations')) loseMaterial = false;
      else loseTask = false;
      await route.abort('failed');
    } else await route.continue();
  });
  await dialog.getByRole('button', { name: '保存并开始研究', exact: true }).click();
  await dialog.locator('#entry-request-status').filter({ hasText: '结果尚未确认' }).waitFor();
  assert.equal(
    (await api(f.p.id, '/state')).objects.filter((e: any) => e.kind === 'source').length,
    2,
  );
  assert.equal(await dialog.locator('#entry-inputs').getAttribute('disabled'), '');
  assert.equal(await dialog.locator('[name=text]').isDisabled(), true);
  await page.reload();
  await page.locator('#connection').filter({ hasText: '已连接' }).waitFor();
  await page.locator('#project').selectOption(f.p.id);
  await page.getByRole('button', { name: '恢复研究请求', exact: true }).click();
  await dialog.getByRole('button', { name: '恢复原研究请求', exact: true }).click();
  await dialog.locator('#entry-request-status').filter({ hasText: '已完成 1 / 2 步' }).waitFor();
  await page.reload();
  await page.locator('#connection').filter({ hasText: '已连接' }).waitFor();
  await page.locator('#project').selectOption(f.p.id);
  await page.getByRole('button', { name: '恢复研究请求', exact: true }).click();
  // Simulate a second tab writing a newer draft while the completion digest is pending.
  await page.evaluate(`(() => {
    const original = crypto.subtle.digest.bind(crypto.subtle);
    crypto.subtle.digest = async function (algorithm, data) {
      const result = await original(algorithm, data);
      const key = 'forkwise-research-entry:' + document.querySelector('#project').value;
      const draft = JSON.parse(localStorage.getItem(key));
      draft.text = '另一页刚填写的新草稿';
      localStorage.setItem(key, JSON.stringify(draft));
      crypto.subtle.digest = original;
      return result;
    };
  })()`);
  await dialog.getByRole('button', { name: '恢复原研究请求', exact: true }).click();
  await dialog.locator('#entry-feedback').filter({ hasText: '研究已排队' }).waitFor();
  await waitFor(
    async () =>
      (await api(f.p.id, '/jobs')).some(
        (j: any) => j.kind === 'workflow.initial' && j.state === 'succeeded',
      ),
    '研究链路未完成',
  );
  assert.equal(
    (await api(f.p.id, '/jobs')).filter((j: any) => j.kind === 'workflow.initial').length,
    1,
  );
  const objects = (await api(f.p.id, '/state')).objects;
  assert.equal(
    objects.filter((e: any) => e.kind === 'source' && e.data.title === 'X 观点合成样本').length,
    1,
  );
  assert.ok(
    objects
      .filter((e: any) => e.kind === 'statement')
      .every((e: any) => e.data.stance.value === 'pending'),
  );
  assert.equal(f.calls.reconstruct, 1);
  assert.match(
    await page.evaluate(
      'localStorage.getItem("forkwise-research-entry:" + document.querySelector("#project").value)',
    ),
    /另一页刚填写的新草稿/,
  );
  assert.equal(await dialog.locator('[name=text]').inputValue(), '另一页刚填写的新草稿');
  mkdirSync('artifacts', { recursive: true });
  await dialog.screenshot({ path: 'artifacts/research-entry-browser.png' });
  await dialog.locator('#entry-close').click();
  await page.locator('#object-list button').filter({ hasText: '本季营收增长' }).waitFor();
  await page
    .frameLocator('#native-canvas')
    .getByRole('button', { name: '选择并操作：本季营收增长', exact: true })
    .click();
  await waitFor(
    async () => (await page.locator('#edit [name=text]').inputValue()) === '本季营收增长',
    '研究候选未接通原画布选择',
  );
  await page.screenshot({ path: 'artifacts/research-entry-canvas.png' });
  await page.locator('#project').selectOption(other);
  await page.locator('#open-research-entry').click();
  assert.equal(await dialog.locator('[name=text]').inputValue(), '另一个项目的未提交草稿');
  await dialog.locator('[name=text]').fill('');
  await dialog.getByText('导入原文件', { exact: true }).click();
  let loseFile = true;
  await page.route('**/files/import', async (route: any) => {
    if (loseFile && route.request().method() === 'POST') {
      loseFile = false;
      await route.fetch();
      await route.abort('failed');
    } else await route.continue();
  });
  await dialog.locator('[name=file]').setInputFiles({
    name: '公司材料.html',
    mimeType: 'text/html',
    buffer: Buffer.from(
      '<!doctype html><html><body><p>CIK 1 本季营收增长，明年利润可能翻倍。</p></body></html>',
    ),
  });
  await dialog.getByRole('button', { name: '保存文件并解析', exact: true }).click();
  await dialog.locator('#entry-request-status').filter({ hasText: '已完成 0 / 1 步' }).waitFor();
  await page.reload();
  await page.locator('#connection').filter({ hasText: '已连接' }).waitFor();
  await page.locator('#project').selectOption(other);
  await page.getByRole('button', { name: '恢复研究请求', exact: true }).click();
  await dialog.getByRole('button', { name: '恢复原研究请求', exact: true }).click();
  await dialog.locator('#entry-feedback').filter({ hasText: '原文件已保存' }).waitFor();
  await waitFor(
    async () => (await api(other, '/state')).objects.some((e: any) => e.kind === 'source_version'),
    '文件解析未完成',
  );
  const version = (await api(other, '/state')).objects.find(
    (e: any) => e.kind === 'source_version',
  );
  await dialog.locator(`#entry-materials input[value="${version.id}"]`).check();
  await dialog.getByRole('button', { name: '保存并开始研究', exact: true }).click();
  await dialog.locator('#entry-feedback').filter({ hasText: '研究已排队' }).waitFor();
  await waitFor(
    async () =>
      (await api(other, '/jobs')).some(
        (j: any) => j.kind === 'workflow.initial' && j.state === 'succeeded',
      ),
    '文件研究未完成',
  );
  assert.equal(
    (await api(other, '/jobs')).filter((j: any) => j.kind === 'material.parse').length,
    1,
  );
  await dialog.getByText('导入原文件', { exact: true }).click();
  await dialog.locator('[name=file]').setInputFiles({
    name: '待转写.png',
    mimeType: 'image/png',
    buffer: Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jNioAAAAASUVORK5CYII=',
      'base64',
    ),
  });
  await dialog.getByRole('button', { name: '保存文件并解析', exact: true }).click();
  await waitFor(
    async () =>
      (await api(other, '/state')).objects.some(
        (e: any) => e.kind === 'source_version' && e.data.textLength === 0,
      ),
    '图片解析未完成',
  );
  const image = (await api(other, '/state')).objects.find(
    (e: any) => e.kind === 'source_version' && e.data.textLength === 0,
  );
  await dialog.locator(`#entry-materials input[value="${image.id}"]`).waitFor();
  assert.equal(
    await dialog.locator(`#entry-materials input[value="${image.id}"]`).isDisabled(),
    true,
  );
  await page.setViewportSize({ width: 390, height: 844 });
  const bounds = await dialog.boundingBox();
  assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 390);
  await dialog.screenshot({ path: 'artifacts/research-entry-narrow.png' });
  const unavailable = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  unavailable.on('pageerror', (e: Error) => errors.push(e.message));
  await unavailable.addInitScript(
    "Object.defineProperty(IDBFactory.prototype, 'open', {value: function () {throw new Error('storage unavailable');}});",
  );
  await unavailable.goto(origin + '/#token=' + token);
  assert.match(await unavailable.evaluate('String(indexedDB.open)'), /storage unavailable/);
  await unavailable.locator('#connection').filter({ hasText: '已连接' }).waitFor();
  await unavailable.locator('#new-project [name=name]').fill('恢复存储不可用时仍可新建项目');
  await unavailable.locator('#new-project button').click();
  await unavailable.locator('#notice').filter({ hasText: '新项目已保存' }).waitFor();
  await unavailable.locator('#open-research-entry').click();
  await unavailable
    .locator('#entry-request-status')
    .filter({ hasText: '尚未发送新研究请求' })
    .waitFor();
  assert.equal(await unavailable.locator('#entry-form [name=text]').isDisabled(), true);
  await unavailable.close();
  assert.deepEqual(errors, []);
  assert.deepEqual(external, []);
  console.log(
    'PASS 画布观点入口、跨项目/刷新草稿、材料和任务双响应丢失恢复、原文件上传恢复与解析后研究、无转写图片禁选、同画布候选与待研究立场、窄窗；真实 HTTP/IndexedDB/Chrome，合成模型与 SEC。',
  );
} catch (error) {
  if (page) await page.screenshot({ path: 'artifacts/research-entry-failure.png' }).catch(() => {});
  throw error;
} finally {
  clearInterval(timer);
  f.app.initialResearch.stop();
  f.app.researchTasks.stop();
  f.app.publicData.stop();
  f.app.files.stop();
  await work;
  if (browser) await browser.close();
  await new Promise<void>((r, j) => server.close((e) => (e ? j(e) : r())));
  f.close();
}
