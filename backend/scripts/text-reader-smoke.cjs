const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { mkdtempSync, readFileSync, existsSync, rmSync, mkdirSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir, homedir } = require('node:os');
const { createServer } = require('node:net');
const { randomUUID } = require('node:crypto');
const { chromium } = require(
  join(
    homedir(),
    '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright',
  ),
);
(async () => {
  const directory = mkdtempSync(join(tmpdir(), 'forkwise-text-reader-')),
    listener = createServer();
  await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  const child = spawn(process.execPath, ['dist/src/server.js'], {
    env: {
      ...process.env,
      FORKWISE_PORT: String(port),
      FORKWISE_DATA_DIR: directory,
      FORKWISE_OLLAMA_MODEL: '',
      FORKWISE_OLLAMA_VISION_MODEL: '',
      SEC_USER_AGENT: '',
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let browser,
    page,
    logs = '';
  child.stderr.on('data', (b) => (logs += b));
  const errors = [];
  try {
    const file = join(directory, 'local-access.json');
    for (let i = 0; !existsSync(file) && i < 100; i++) await new Promise((r) => setTimeout(r, 100));
    assert.ok(existsSync(file), logs);
    const config = JSON.parse(readFileSync(file, 'utf8'));
    const api = async (path, method = 'GET', body) => {
      const response = await fetch(config.origin + '/api/v1' + path, {
        method,
        headers: {
          Authorization: 'Bearer ' + config.token,
          'Content-Type': 'application/json',
          'Idempotency-Key': randomUUID(),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      const result = await response.json();
      assert.equal(response.ok, true, result.message);
      return result.data;
    };
    for (let i = 0; i < 100; i++) {
      try {
        await api('/projects');
        break;
      } catch (e) {
        if (e.cause?.code !== 'ECONNREFUSED' || i === 99) throw e;
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    const project = await api('/projects', 'POST', { name: '文字引用阅读测试' }),
      path = '/projects/' + project.id;
    const before = '原作者🙂\n' + '前文与背景\n'.repeat(6000),
      quote = '当期收入上升，但不能据此证明下一期利润。',
      after = '\n后续说明'.repeat(6000) + '<img src=x onerror="window.__readerInjected=true">';
    const text = before + quote + after;
    const citation = {
      sourceVersionId: 'old',
      start: before.length,
      end: before.length + quote.length,
      quote,
    };
    await api(path + '/operations', 'POST', {
      expected: {},
      commands: [
        {
          op: 'source.create',
          id: 's',
          data: {
            title: '固定版本材料',
            publisher: '合成作者',
            rights: 'authorized',
            url: 'https://example.invalid/original',
          },
        },
        {
          op: 'source.import',
          id: 'old',
          sourceId: 's',
          text,
          retrievedAt: '2026-10-07T01:00:00Z',
          publishedAt: null,
        },
        {
          op: 'source.import',
          id: 'new',
          sourceId: 's',
          text: '后来披露的新内容，不能替代早先引用。',
          retrievedAt: '2026-10-07T02:00:00Z',
          publishedAt: null,
        },
        {
          op: 'statement.create',
          id: 'claim',
          data: {
            text: '需要对照原句的主张',
            origin: 'author',
            participation: 'reference',
            stance: { value: 'pending', reason: '' },
            citations: [citation],
          },
        },
      ],
    });
    const baseline = (await api(path + '/state')).objects;
    browser = await chromium.launch({
      headless: true,
      executablePath:
        process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    });
    page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(config.url);
    await page.locator('#object-list button[data-id="claim"]').click();
    const frame = page.frameLocator('#native-canvas');
    const open = async () => {
      await frame.locator('[data-object-action="more"]').click();
      await frame.locator('[data-object-action="source"][data-object-id="claim"]').click();
      await frame.getByRole('button', { name: '查看已保存材料', exact: true }).click();
    };
    await open();
    const dialog = page.getByRole('dialog', { name: '材料原文阅读' });
    await dialog.waitFor({ state: 'visible' });
    assert.equal(await dialog.locator('mark').textContent(), quote);
    assert.equal(await dialog.getAttribute('data-version'), 'old');
    assert.ok((await dialog.locator('[data-text]').textContent()).length < 20000);
    await dialog.getByText('保存范围尚未说明', { exact: false }).waitFor();
    const original = dialog.getByRole('link', { name: '打开原始网页', exact: true });
    assert.equal(await original.getAttribute('href'), 'https://example.invalid/original');
    assert.equal(await original.getAttribute('target'), '_blank');
    await dialog.getByRole('button', { name: '放大阅读', exact: true }).click();
    await dialog.getByRole('button', { name: '还原大小', exact: true }).click();
    await dialog.getByRole('button', { name: '上一段', exact: true }).click();
    await dialog.getByRole('button', { name: '回到引用', exact: true }).click();
    assert.equal(await dialog.locator('mark').textContent(), quote);
    const markBounds = await dialog.locator('mark').boundingBox(),
      textBounds = await dialog.locator('[data-text]').boundingBox();
    assert.ok(
      markBounds.y >= textBounds.y &&
        markBounds.y + markBounds.height <= textBounds.y + textBounds.height,
      '引用应实际位于阅读视口内',
    );
    assert.equal(await dialog.evaluate((d) => d.scrollTop), 0, '定位原句应只滚动阅读区');
    mkdirSync('artifacts', { recursive: true });
    await page.screenshot({ path: 'artifacts/text-reader-browser.png' });
    await dialog.getByRole('button', { name: '返回来源', exact: true }).click();
    await frame.locator('.source-popover').waitFor();
    await frame.getByRole('button', { name: '查看已保存材料', exact: true }).click();
    await dialog.getByRole('button', { name: '返回画布', exact: true }).click();
    assert.deepEqual((await api(path + '/state')).objects, baseline);
    // A mismatched response must not silently relocate or substitute the newer version.
    await page.route('**/materials/old', async (route) => {
      const response = await route.fetch(),
        body = await response.json();
      body.data.text = '被替换的内容';
      await route.fulfill({ response, json: body });
    });
    await open();
    await dialog.getByText('材料内容与保存的指纹不符', { exact: false }).waitFor();
    assert.equal(await dialog.locator('mark').count(), 0);
    await dialog.getByRole('button', { name: '返回画布', exact: true }).click();
    await page.unroute('**/materials/old');
    assert.deepEqual((await api(path + '/state')).objects, baseline);
    // An invalid anchor with an otherwise intact material is reported separately.
    await page.route('**/workspace', async (route) => {
      const response = await route.fetch(),
        body = await response.json();
      const target = body.data.state.objects.find((e) => e.id === 'claim');
      target.data.citations[0].start++;
      await route.fulfill({ response, json: body });
    });
    await page.reload();
    await page.locator('#object-list button[data-id="claim"]').click();
    await open();
    await dialog.getByText('引用位置与原句不符', { exact: false }).waitFor();
    assert.equal(await dialog.locator('mark').count(), 0);
    await dialog.getByRole('button', { name: '返回画布', exact: true }).click();
    await page.unroute('**/workspace');
    await page.reload();
    await page.locator('#object-list button[data-id="claim"]').click();
    // An in-flight read can be closed; a late response cannot reopen or replace another reading.
    let release, entered;
    const gate = new Promise((resolve) => {
        release = resolve;
      }),
      seen = new Promise((resolve) => {
        entered = resolve;
      });
    await page.route('**/materials/old', async (route) => {
      entered();
      await gate;
      await route.continue();
    });
    await open();
    await seen;
    await dialog.getByRole('button', { name: '返回画布', exact: true }).click();
    const complete = page.waitForResponse('**/materials/old');
    release();
    await complete;
    await page.unroute('**/materials/old');
    assert.equal(await dialog.isVisible(), false);
    await open();
    await dialog.locator('mark').waitFor();
    await page.setViewportSize({ width: 390, height: 900 });
    assert.ok((await dialog.boundingBox()).width <= 390);
    await page.screenshot({ path: 'artifacts/text-reader-narrow.png' });
    await dialog.getByRole('button', { name: '返回画布', exact: true }).click();
    await page.setViewportSize({ width: 1440, height: 1000 });
    assert.deepEqual((await api(path + '/state')).objects, baseline);
    await page.locator('#material').evaluate((f) => (f.closest('details').open = true));
    const form = page.locator('#material');
    assert.equal(await form.locator('select[name="coverage"]').inputValue(), 'excerpt');
    await form.locator('input[name="title"]').fill('粘贴摘录🙂');
    await form.locator('textarea').fill('<img src=x onerror="window.__readerInjected=true">');
    await form.getByRole('button', { name: '保存材料版本', exact: true }).click();
    await page.locator('#notice').getByText('已保存到本机数据库', { exact: true }).waitFor();
    const saved = (await api(path + '/state')).objects;
    const source = saved.find((e) => e.kind === 'source' && e.data.title === '粘贴摘录🙂');
    assert.equal(
      saved.find((e) => e.kind === 'source_version' && e.data.sourceId === source.id).data.coverage,
      'excerpt',
    );
    await page.locator('#list-materials').evaluate((b) => (b.closest('details').open = true));
    await page.locator('#list-materials').click();
    await page
      .locator('#material-list > div')
      .filter({ has: page.locator('p').filter({ hasText: '粘贴摘录🙂' }) })
      .getByRole('button', { name: '查看保存的文本', exact: true })
      .click();
    await dialog.getByText('当前保存的是摘录', { exact: false }).waitFor();
    await dialog
      .locator('[data-text]')
      .getByText('<img src=x onerror="window.__readerInjected=true">', { exact: true })
      .waitFor();
    assert.equal(await dialog.locator('img').count(), 0);
    assert.equal(await page.evaluate(() => window.__readerInjected), undefined);
    await dialog.getByRole('button', { name: '返回画布', exact: true }).click();
    assert.deepEqual(errors, []);
    console.log(
      'PASS 固定旧材料版本/原句高亮/有界分段/范围未知与摘录导入/放大还原/返回来源与画布/读取不改变研究对象/内容指纹与锚点错误拒绝/关闭后晚到结果丢弃/窄屏/材料文本不执行；临时合成材料，无外网调用',
    );
  } catch (error) {
    if (page) await page.screenshot({ path: 'artifacts/text-reader-failure.png' }).catch(() => {});
    throw error;
  } finally {
    if (browser) await browser.close();
    if (child.exitCode === null && child.signalCode === null) {
      const exit = new Promise((r) => child.once('exit', r));
      child.kill('SIGTERM');
      await exit;
    }
    rmSync(directory, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
