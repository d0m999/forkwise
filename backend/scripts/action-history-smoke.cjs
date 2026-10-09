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
  const directory = mkdtempSync(join(tmpdir(), 'forkwise-action-history-')),
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
    const project = await api('/projects', 'POST', { name: '统一撤销浏览器测试' }),
      path = '/projects/' + project.id;
    await api(path + '/operations', 'POST', {
      expected: {},
      commands: [
        {
          op: 'source.create',
          id: 's',
          data: { title: '撤销后保留的材料', publisher: '合成作者', rights: 'public' },
        },
        {
          op: 'source.import',
          id: 'v',
          sourceId: 's',
          text: '材料不随研究编辑撤销',
          retrievedAt: '2026-10-01T00:00:00Z',
          publishedAt: null,
        },
      ],
    });
    browser = await chromium.launch({ channel: 'chrome', headless: true });
    page = await browser.newPage({ viewport: { width: 1450, height: 980 } });
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('dialog', (d) => d.accept());
    await page.goto(config.url);
    await page.locator('#connection').filter({ hasText: '已连接' }).waitFor();
    const frame = page.frameLocator('#native-canvas');
    await frame.getByRole('button', { name: '＋ 新建卡', exact: true }).click();
    await frame.getByRole('dialog', { name: '写下主张' }).locator('textarea').fill('需求增长');
    await frame.getByRole('button', { name: '放到画布', exact: true }).click();
    await page.locator('#object-list button').filter({ hasText: '需求增长' }).waitFor();
    const undo = () => frame.locator('[data-history=undo]'),
      redo = () => frame.locator('[data-history=redo]');
    const waitHistory = async (direction, label) => {
      await frame
        .locator(
          `[data-history=${direction}][title="${direction === 'undo' ? '撤销' : '重做'}：${label}"]`,
        )
        .waitFor();
    };
    await waitHistory('undo', '新建主张');
    const state = await api(path + '/state'),
      card = state.objects.find((e) => e.kind === 'statement');
    await page.locator(`#object-list button[data-id="${card.id}"]`).click();
    await page.locator('#edit select[name=stance]').selectOption('accepted');
    await page.locator('#edit textarea[name=reason]').fill('明确的本人判断');
    await page.locator('#save-stance').click();
    await waitHistory('undo', '保存个人立场');
    await undo().click();
    await waitHistory('redo', '保存个人立场');
    assert.equal(
      (await api(path + '/state')).objects.find((e) => e.id === card.id).data.stance.value,
      'pending',
    );
    await undo().click();
    await waitHistory('redo', '新建主张');
    assert.equal(
      (await api(path + '/state')).objects.some((e) => e.id === card.id),
      false,
    );
    assert.equal((await api(path + '/materials/v')).text, '材料不随研究编辑撤销');
    await page.reload();
    await waitHistory('redo', '新建主张');
    await redo().click();
    await waitHistory('redo', '保存个人立场');
    await redo().click();
    await waitHistory('undo', '保存个人立场');
    assert.equal(
      (await api(path + '/state')).objects.find((e) => e.id === card.id).data.stance.value,
      'accepted',
    );
    // A real pointer drag emits many native updates but creates one history step.
    const beforeDrag = await api(path + '/workspace'),
      position = beforeDrag.layout.data.positions[card.id];
    const view = beforeDrag.layout.data.canvas.scenes.mine.view,
      bounds = await page.locator('#native-canvas').boundingBox();
    const x = bounds.x + (position.x + view.scrollX + 150) * view.zoom.value;
    const y = bounds.y + (position.y + view.scrollY + 48) * view.zoom.value;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + 75, y + 55, { steps: 12 });
    await page.mouse.up();
    let moved;
    for (let i = 0; i < 80; i++) {
      moved = await api(path + '/workspace');
      if (moved.layout.data.positions[card.id].x !== position.x) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.notEqual(moved.layout.data.positions[card.id].x, position.x);
    await waitHistory('undo', '调整画布布局、批注或样式');
    assert.equal(moved.history.version, beforeDrag.history.version + 1);
    await undo().focus();
    await page.keyboard.press('Meta+z');
    await waitHistory('redo', '调整画布布局、批注或样式');
    assert.deepEqual((await api(path + '/workspace')).layout.data.positions[card.id], position);
    // Import a native drawing through the real canvas input; one undo removes it.
    const drawing = {
      type: 'excalidraw',
      version: 2,
      source: 'synthetic',
      elements: [
        {
          id: 'rectangle_history',
          type: 'rectangle',
          x: 450,
          y: 100,
          width: 150,
          height: 100,
          angle: 0,
          strokeColor: '#1e1e1e',
          backgroundColor: 'transparent',
          fillStyle: 'solid',
          strokeWidth: 2,
          strokeStyle: 'solid',
          roughness: 1,
          opacity: 100,
          groupIds: [],
          frameId: null,
          index: 'a0',
          roundness: null,
          seed: 1,
          version: 1,
          versionNonce: 1,
          isDeleted: false,
          boundElements: null,
          updated: 1,
          link: null,
          locked: false,
        },
      ],
      appState: {},
      files: {},
    };
    await frame.locator('.import-canvas input').setInputFiles({
      name: 'history.excalidraw',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify(drawing)),
    });
    await waitHistory('undo', '调整画布布局、批注或样式');
    const drawn = await api(path + '/workspace');
    assert.equal(
      drawn.layout.data.canvas.annotations.elements.filter((e) => !e.isDeleted).length,
      1,
    );
    await undo().click();
    await waitHistory('redo', '调整画布布局、批注或样式');
    assert.equal(
      (await api(path + '/workspace')).layout.data.canvas.annotations.elements.filter(
        (e) => !e.isDeleted,
      ).length,
      0,
    );
    await redo().click();
    await waitHistory('undo', '调整画布布局、批注或样式');
    assert.equal(
      (await api(path + '/workspace')).layout.data.canvas.annotations.elements.filter(
        (e) => !e.isDeleted,
      ).length,
      1,
    );
    // Unknown outcome: server executes undo but its response is lost. Recover the
    // original receipt, never undo the previous action accidentally on retry.
    let lost = false;
    await page.route('**/action-history/travel', async (route) => {
      if (!lost) {
        lost = true;
        await route.fetch();
        await route.abort('failed');
      } else await route.continue();
    });
    await undo().click();
    await page.locator('#recover-operation:not([hidden])').waitFor();
    await page.locator('#recover-operation').click();
    await page.locator('#recover-operation').waitFor({ state: 'hidden' });
    await waitHistory('redo', '调整画布布局、批注或样式');
    assert.equal(
      (await api(path + '/state')).objects.find((e) => e.id === card.id).data.stance.value,
      'accepted',
    );
    await page.unroute('**/action-history/travel');
    const keys = await page.evaluate(() =>
      Object.keys(localStorage).filter((k) => k.startsWith('forkwise-canvas-recovery:')),
    );
    assert.deepEqual(keys, []);
    assert.deepEqual(errors, []);
    mkdirSync('artifacts', { recursive: true });
    await page.screenshot({ path: 'artifacts/action-history-browser.png', fullPage: true });
    console.log(
      'PASS 原画布新增/个人立场的跨对象历史、连续撤销重做、刷新保留、原生拖动/绘图一步撤销与快捷键、导入材料保持、响应丢失同键恢复、无异常恢复草稿；临时合成数据',
    );
  } catch (error) {
    if (page)
      await page.screenshot({ path: 'artifacts/action-history-failure.png' }).catch(() => {});
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
