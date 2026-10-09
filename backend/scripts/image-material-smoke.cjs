const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const {
  mkdtempSync,
  existsSync,
  readFileSync,
  rmSync,
  mkdirSync,
  writeFileSync,
} = require('node:fs');
const { join } = require('node:path');
const { tmpdir, homedir } = require('node:os');
const { createServer } = require('node:net');
const { randomUUID } = require('node:crypto');
const { fixture } = require('./prototype-fixture.cjs');
const { createCanvas } = require('@napi-rs/canvas');
const { chromium } = require(
  join(
    homedir(),
    '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright',
  ),
);
(async () => {
  const directory = mkdtempSync(join(tmpdir(), 'forkwise-image-browser-')),
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
    const project = await api('/projects', 'POST', { name: '原图区域证据测试' }),
      path = '/projects/' + project.id;
    const original = createCanvas(800, 400),
      ctx = original.getContext('2d');
    ctx.fillStyle = '#fff7ec';
    ctx.fillRect(0, 0, 800, 400);
    ctx.fillStyle = '#175c88';
    ctx.fillRect(80, 60, 320, 160);
    ctx.fillStyle = '#253a36';
    ctx.font = '36px sans-serif';
    ctx.fillText('Original image · 800 × 400', 80, 330);
    const image = structuredClone(
      fixture().projects[0][1].canvasState.annotations.elements.find((e) => e.type === 'image'),
    );
    Object.assign(image, { id: 'image', fileId: 'file', x: 440, y: 100, width: 240, height: 120 });
    const stmt = (id) => ({
      op: 'statement.create',
      id,
      data: {
        text: id === 'a' ? '图片用于记录研究材料' : '另一项主张',
        origin: 'user',
        participation: 'personal',
        stance: { value: 'pending', reason: '' },
        citations: [],
      },
    });
    await api(path + '/operations', 'POST', {
      expected: {},
      commands: [stmt('a'), stmt('b')],
      layout: {
        expectedVersion: 0,
        data: {
          positions: { a: { x: 50, y: 80 }, b: { x: 50, y: 330 } },
          drawings: [],
          canvas: {
            scenes: {
              mine: {
                styles: {},
                view: {
                  scrollX: 0,
                  scrollY: 0,
                  zoom: { value: 1 },
                  selectedElementIds: { image: true },
                  selectedGroupIds: {},
                },
              },
            },
            annotations: {
              elements: [image],
              files: {
                file: {
                  id: 'file',
                  dataURL: original.toDataURL('image/png'),
                  mimeType: 'image/png',
                  created: Date.now(),
                },
              },
            },
          },
        },
      },
    });
    browser = await chromium.launch({
      headless: true,
      executablePath:
        process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    });
    page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
    page.on('pageerror', (e) => errors.push(e.message));
    await page.addInitScript(() => {
      window.__canvasTrace = [];
      window.addEventListener('message', (e) => {
        if (!e.data?.channel?.startsWith('forkwise')) return;
        window.__canvasTrace.push({
          at: Date.now(),
          channel: e.data.channel,
          kind: e.data.event?.type ?? e.data.type,
          project: e.data.projectId ?? e.data.snapshot?.projectId,
          session: e.data.session ?? e.data.snapshot?.session,
          restore: e.data.snapshot?.canvasRestoreRevision,
        });
      });
    });
    page.on('response', async (response) => {
      if (!response.url().includes('/api/v1/')) return;
      try {
        const body = await response.json();
        requests.push({
          at: Date.now(),
          path: new URL(response.url()).pathname,
          method: response.request().method(),
          request: response.request().postData(),
          status: response.status(),
          layoutVersion: body.data?.layout?.version,
          before: body.data?.revisionBefore,
          after: body.data?.revisionAfter,
        });
      } catch {}
    });

    await page.goto(config.url);
    await page.locator(`#project option[value="${project.id}"]`).waitFor({ state: 'attached' });
    await page.locator('#project').selectOption(project.id);
    const frame = page.frameLocator('#native-canvas');
    await frame.getByRole('button', { name: '加入卡内材料', exact: true }).click();
    let lost = false;
    const keys = [];
    await page.route('**/api/v1/projects/*/canvas-materials', async (route) => {
      keys.push(route.request().headers()['idempotency-key']);
      if (!lost) {
        lost = true;
        assert.equal((await route.fetch()).status(), 200);
        await route.abort('failed');
      } else await route.continue();
    });
    await frame
      .getByRole('button', { name: '图片加入材料：图片用于记录研究材料', exact: true })
      .click();
    await page.getByRole('button', { name: '恢复图片加入材料操作', exact: true }).click();
    await page.getByRole('button', { name: '原图框选证据', exact: true }).click();
    assert.equal(keys.length, 2);
    assert.equal(keys[0], keys[1]);
    const dialog = page.getByRole('dialog', { name: '原图区域证据' }),
      canvas = dialog.locator('canvas');
    await dialog.getByText('原图 800 × 400 像素。', { exact: false }).waitFor();
    const bounds = await canvas.boundingBox();
    await page.mouse.move(bounds.x + bounds.width * 0.1, bounds.y + bounds.height * 0.15);
    await page.mouse.down();
    await page.mouse.move(bounds.x + bounds.width * 0.5, bounds.y + bounds.height * 0.55, {
      steps: 10,
    });
    await page.mouse.up();
    await dialog.getByRole('button', { name: '保存区域证据', exact: true }).click();
    await dialog.locator('[data-feedback]').getByText('区域证据已保存', { exact: false }).waitFor();
    let state = await api(path + '/state'),
      evidence = state.objects.find((e) => e.kind === 'evidence');
    assert.equal(evidence.data.citation.kind, 'image');
    assert.equal(evidence.data.citation.imageWidth, 800);
    assert.ok(Math.abs(evidence.data.citation.region.x - 0.1) < 0.02);
    assert.equal(state.objects.find((e) => e.kind === 'evidence_link').data.relation, 'unjudged');
    await dialog.locator('select[name="relation"]').selectOption('supports');
    await dialog.locator('textarea').fill('选定区域提供这一步的依据');
    await dialog.getByRole('button', { name: '保存区域证据', exact: true }).click();
    await dialog.getByRole('button', { name: '支持 · 当前内容', exact: true }).waitFor();
    state = await api(path + '/state');
    assert.equal(state.objects.filter((e) => e.kind === 'evidence').length, 1);
    assert.equal(state.objects.filter((e) => e.kind === 'evidence_link').length, 1);
    assert.equal(state.objects.find((e) => e.id === 'a').data.stance.value, 'pending');
    assert.deepEqual(
      await canvas.evaluate((c) =>
        Array.from(c.getContext('2d').getImageData(150, 100, 1, 1).data),
      ),
      [23, 92, 136, 255],
    );
    mkdirSync('artifacts', { recursive: true });
    await page.screenshot({ path: 'artifacts/image-material-browser.png' });
    await dialog.getByRole('button', { name: '关闭', exact: true }).click();
    await page.getByRole('button', { name: '从此对象材料列表移除', exact: true }).click();
    state = await api(path + '/state');
    assert.equal(
      state.objects.find((e) => e.kind === 'material_membership').data.visibility,
      'excluded',
    );
    assert.equal(state.objects.filter((e) => e.kind === 'evidence_link').length, 1);
    await page.reload();
    await page.locator(`#project option[value="${project.id}"]`).waitFor({ state: 'attached' });
    await page.locator('#project').selectOption(project.id);
    await page.locator('#object-list button[data-id="b"]').click();
    await page
      .locator('details')
      .filter({ has: page.locator('#list-materials') })
      .evaluate((d) => (d.open = true));
    await page.locator('#list-materials').click();
    await page.getByRole('button', { name: '加入当前对象材料', exact: true }).click();
    state = await api(path + '/state');
    assert.equal(state.objects.filter((e) => e.kind === 'material_membership').length, 2);
    assert.equal(
      state.objects.find((e) => e.kind === 'material_membership' && e.data.targetId === 'a').data
        .visibility,
      'excluded',
    );
    const layout = await api(path + '/workspace');
    assert.equal(
      layout.layout.data.canvas.annotations.files.file.dataURL,
      original.toDataURL('image/png'),
    );
    assert.equal(
      layout.layout.data.canvas.annotations.elements.find((e) => e.id === 'image').isDeleted,
      false,
    );
    const recoveries = await page.evaluate(() =>
      Object.keys(localStorage)
        .filter((k) => k.startsWith('forkwise-canvas-recovery:'))
        .map((k) => JSON.parse(localStorage.getItem(k))),
    );
    writeFileSync(
      'artifacts/image-material-browser-trace.json',
      JSON.stringify(
        { requests, recoveries, events: await page.evaluate(() => window.__canvasTrace) },
        null,
        2,
      ),
    );
    assert.deepEqual(
      recoveries.map((r) => ({ error: r.error, action: r.action.type, layout: r.layout.version })),
      [],
    );
    assert.deepEqual(errors, []);
    console.log(
      'PASS：画布原图加入材料、丢失响应同键恢复、原图像素/区域引用、关系改判去重、隐藏保留引用、刷新跨对象复用',
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
      await page.screenshot({ path: 'artifacts/image-material-failure.png' }).catch(() => {});
    }
    throw error;
  } finally {
    if (browser) await browser.close();
    child.kill('SIGTERM');
    await new Promise((r) => child.once('exit', r));
    rmSync(directory, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
