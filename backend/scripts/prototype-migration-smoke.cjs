const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { mkdtempSync, existsSync, readFileSync, rmSync, mkdirSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir, homedir } = require('node:os');
const { createServer } = require('node:net');
const { randomUUID } = require('node:crypto');
const { fixture } = require('./prototype-fixture.cjs');
const { chromium } = require(
  join(
    homedir(),
    '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright',
  ),
);
(async () => {
  const directory = mkdtempSync(join(tmpdir(), 'forkwise-legacy-browser-')),
    listener = createServer();
  await new Promise((r) => listener.listen(0, '127.0.0.1', r));
  const port = listener.address().port;
  await new Promise((r) => listener.close(r));
  const child = spawn(process.execPath, ['dist/src/server.js'], {
    cwd: process.cwd(),
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
  child.stderr.on('data', (value) => {
    logs += value;
  });
  const delay = () => new Promise((r) => setTimeout(r, 100)),
    errors = [],
    requests = [];
  try {
    const access = join(directory, 'local-access.json');
    for (let i = 0; !existsSync(access) && i < 100; i++) await delay();
    assert.ok(existsSync(access), logs);
    const config = JSON.parse(readFileSync(access, 'utf8'));
    for (let i = 0; i < 100; i++) {
      try {
        assert.equal((await fetch(config.origin + '/prototype-migration.js')).status, 200);
        break;
      } catch (e) {
        if (e.cause?.code !== 'ECONNREFUSED' || i === 99) throw e;
        await delay();
      }
    }
    const api = async (path, method = 'GET', body) => {
      const res = await fetch(config.origin + '/api/v1' + path, {
        method,
        headers: {
          Authorization: 'Bearer ' + config.token,
          'Content-Type': 'application/json',
          'Idempotency-Key': randomUUID(),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      const value = await res.json();
      assert.equal(res.ok, true, value.message);
      return value.data;
    };
    const existing = await api('/projects', 'POST', { name: '原有项目保持' });
    const { createCanvas } = require('@napi-rs/canvas'),
      raster = createCanvas(240, 120);
    raster.getContext('2d').fillStyle = '#246a91';
    raster.getContext('2d').fillRect(0, 0, 240, 120);
    const workspace = fixture(({ act, getStudy }) => {
        act({
          type: 'material-add',
          id: 'p1',
          material: {
            kind: 'image',
            title: '迁移区域原图',
            text: '',
            data: raster.toDataURL('image/png'),
            width: 240,
            height: 120,
          },
        });
        const image = getStudy().sources.at(-1);
        act({
          type: 'material-evidence',
          id: 'p1',
          effect: '尚待判断',
          reason: '',
          ref: {
            kind: 'image',
            source: image.id,
            version: 1,
            width: 240,
            height: 120,
            region: { x: 24, y: 24, width: 48, height: 36 },
            quote: '原图区域（人工框选，未进行 OCR）',
          },
        });
        act({ type: 'material-attach', id: 'p2', source: image.id, version: 1 });
        act({ type: 'material-remove', id: 'p1', source: image.id });
      }),
      other = structuredClone(workspace.projects[0][1]);
    other.name = '另一个私有项目';
    other.composer.text = '不应上传的其他项目私密草稿';
    workspace.projects.push(['project-2', other]);
    workspace.projectSerial = 2;
    workspace.aiThreads.push(['project-2:p1', { question: '其他项目的私密讨论', context: [] }]);
    browser = await chromium.launch({
      headless: true,
      executablePath:
        process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    });
    page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const slowCanvas = process.env.FORKWISE_TEST_SLOW_CANVAS === '1';
    let releaseCanvas;
    if (slowCanvas) {
      const canvasGate = new Promise((resolve) => {
        releaseCanvas = resolve;
      });
      await page.route('**/canvas/index.html', async (route) => {
        await canvasGate;
        await route.continue();
      });
    }
    await page.addInitScript(() => {
      window.__migrationMessages = [];
      window.addEventListener('message', (event) => {
        if (event.data?.channel?.startsWith('forkwise'))
          window.__migrationMessages.push({
            channel: event.data.channel,
            ready: event.data.ready,
            type: event.data.type,
            cards: event.data.snapshot?.cards?.length,
            project: event.data.snapshot?.projectId,
            eventProject: event.data.projectId,
            action: event.data.event,
          });
      });
    });
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('request', (req) => {
      if (req.url().includes('/api/v1/prototype-migrations')) requests.push(req.postData());
    });
    await page.goto(config.url, { waitUntil: slowCanvas ? 'domcontentloaded' : 'load' });
    await page
      .locator('#project option')
      .filter({ hasText: existing.name })
      .waitFor({ state: 'attached' });
    await page.locator('#import-prototype').setInputFiles({
      name: 'synthetic-workspace.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify(workspace)),
    });
    const dialog = page.getByRole('dialog', { name: '旧版研究迁移' });
    await dialog.getByRole('button', { name: '预览转换结果' }).click();
    const confirm = dialog.getByRole('button', { name: '确认迁移为新项目' });
    await confirm.waitFor();
    assert.equal((await api('/projects')).length, 1);
    assert.ok(
      (await dialog.textContent()).includes('9') ||
        (await dialog.textContent()).includes('6 项主张'),
    );
    await dialog.getByText('1 处原图区域证据', { exact: false }).waitFor();
    assert.equal(
      requests.some((r) => r.includes('不应上传') || r.includes('其他项目的私密讨论')),
      false,
    );
    await dialog.getByText('查看与复制旧草稿', { exact: true }).click();
    assert.equal(
      await dialog.getByLabel('mine 正文', { exact: true }).inputValue(),
      '未提交的合成草稿',
    );
    let interrupted = false;
    await page.route('**/api/v1/prototype-migrations', async (route) => {
      if (!interrupted) {
        interrupted = true;
        assert.equal((await route.fetch()).status(), 200);
        await route.abort('failed');
      } else if (slowCanvas) {
        const response = await route.fetch();
        releaseCanvas();
        const frame = page.frameLocator('#native-canvas');
        await frame.locator('.excalidraw canvas').first().waitFor();
        await frame.locator('body').evaluate(
          () =>
            new Promise((resolve) => {
              // Include the editor's 320 ms idle commit after native initialization.
              let frames = 36;
              const next = () => (--frames ? requestAnimationFrame(next) : resolve());
              requestAnimationFrame(next);
            }),
        );
        await route.fulfill({ response });
      } else await route.continue();
    });
    await confirm.click();
    await dialog
      .locator('.migration-feedback')
      .getByText('迁移结果暂未确认。', { exact: false })
      .waitFor();
    assert.equal((await api('/projects')).length, 2);
    await confirm.click();
    await dialog.waitFor({ state: 'hidden' });
    const projects = await api('/projects');
    assert.equal(projects.length, 2);
    const imported = projects.find((p) => p.id !== existing.id),
      path = '/projects/' + imported.id;
    const state = await api(path + '/state');
    const p1 = state.objects.find(
      (e) => e.kind === 'statement' && e.data.text.includes('合成迁移案例'),
    );
    assert.equal(p1.data.stance.value, 'questioned');
    const card = page.frameLocator('#native-canvas').locator(`[data-details-card="${p1.id}"]`);
    await card.waitFor({ state: 'attached' });
    await page.getByRole('button', { name: '查看旧版迁移记录', exact: true }).click();
    await dialog.getByText('作者整理原版（9 项）', { exact: true }).click();
    await dialog.getByText('查看与复制旧草稿', { exact: true }).click();
    assert.equal(await dialog.getByLabel('输入材料', { exact: true }).inputValue(), '输入中的材料');
    const downloadPromise = page.waitForEvent('download');
    await dialog.getByRole('button', { name: '下载旧原型恢复副本', exact: true }).click();
    const download = await downloadPromise,
      saved = JSON.parse(readFileSync(await download.path(), 'utf8'));
    assert.equal(saved.projects.length, 1);
    assert.deepEqual(saved.projects[0][1], workspace.projects[0][1]);
    assert.equal(JSON.stringify(saved).includes('不应上传'), false);
    mkdirSync('artifacts', { recursive: true });
    await page.screenshot({ path: 'artifacts/prototype-migration-browser.png' });
    await dialog.getByRole('button', { name: '关闭迁移窗口' }).click();
    await page.locator(`#object-list button[data-id="${p1.id}"]`).click();
    const frame = page.frameLocator('#native-canvas');
    await frame.locator('[data-object-action="more"]').click();
    await frame.locator(`[data-object-action="materials"][data-object-id="${p1.id}"]`).click();
    await page.locator('#material-list h3').filter({ hasText: '当前对象材料' }).waitFor();
    assert.equal(
      await page.locator('#material-list').getByText('迁移区域原图', { exact: false }).count(),
      0,
    );
    await page.getByRole('button', { name: '从项目材料中复用', exact: true }).click();
    const imageRow = page
      .locator('#material-list > div')
      .filter({ has: page.locator('p').filter({ hasText: '迁移区域原图' }) });
    await imageRow.getByRole('button', { name: '原图框选证据', exact: true }).click();
    const imageDialog = page.getByRole('dialog', { name: '原图区域证据' });
    await imageDialog.getByRole('button', { name: '暂不判断 · 当前内容', exact: true }).click();
    for (const [name, value] of Object.entries({ x: '0.1', y: '0.2', width: '0.2', height: '0.3' }))
      assert.equal(await imageDialog.locator(`input[name="${name}"]`).inputValue(), value);
    assert.deepEqual(
      await imageDialog
        .locator('canvas')
        .evaluate((c) => Array.from(c.getContext('2d').getImageData(120, 90, 1, 1).data)),
      [36, 106, 145, 255],
    );
    await page.screenshot({ path: 'artifacts/prototype-migration-image-browser.png' });
    const recoveries = await page.evaluate(() =>
      Object.fromEntries(
        Object.keys(localStorage)
          .filter((k) => k.startsWith('forkwise-canvas-recovery:'))
          .map((k) => [k, JSON.parse(localStorage.getItem(k))]),
      ),
    );
    console.log('迁移期间画布恢复记录：', JSON.stringify(recoveries));
    assert.deepEqual(recoveries, {}, '没有研究编辑的迁移不应产生旧项目恢复草稿');
    await imageDialog.getByRole('button', { name: '关闭', exact: true }).click();
    await page.reload();
    await page.locator(`#project option[value="${imported.id}"]`).waitFor({ state: 'attached' });
    await page.locator('#project').selectOption(imported.id);
    await page.getByRole('button', { name: '查看旧版迁移记录', exact: true }).click();
    await dialog.getByRole('heading', { name: '旧版迁移记录', exact: true }).waitFor();
    await dialog.getByRole('button', { name: '关闭迁移窗口' }).click();
    const malformed = fixture();
    malformed.projects[0][1].study.mine.nodes.p1.sourceRef.quote = '被篡改的原文';
    await page.locator('#import-prototype').setInputFiles({
      name: 'invalid-workspace.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify(malformed)),
    });
    await dialog.getByRole('button', { name: '预览转换结果' }).click();
    await dialog
      .locator('.migration-feedback')
      .getByText('旧版引用与原文不符', { exact: false })
      .waitFor();
    assert.equal(await dialog.getByRole('button', { name: '确认迁移为新项目' }).count(), 0);
    assert.equal((await api('/projects')).length, 2);
    assert.equal((await api('/projects/' + existing.id + '/state')).objects.length, 0);
    assert.deepEqual(errors, []);
    console.log(
      'PASS 原型副本选择/只读预览/确认后响应丢失原键重试/画布接通/材料隐藏/原图像素与区域证据读取/旧原版与草稿/项目隔离/恢复副本下载/刷新保留/损坏引用窗口内拒绝',
    );
  } catch (error) {
    console.error('浏览器异常：', errors);
    if (page)
      for (const f of page.frames())
        console.error(
          '画布消息：',
          await f.evaluate(() => window.__migrationMessages).catch(() => []),
        );
    if (page) {
      console.error(
        '页面提示：',
        await page
          .locator('#notice')
          .textContent()
          .catch(() => ''),
      );
      await page.screenshot({ path: 'artifacts/prototype-migration-failure.png' }).catch(() => {});
    }
    throw error;
  } finally {
    if (browser) await browser.close();
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise((r) => child.once('exit', r));
      child.kill('SIGTERM');
      await exited;
    }
    rmSync(directory, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
