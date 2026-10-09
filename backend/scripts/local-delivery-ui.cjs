const {
  chromium,
} = require('/Users/d0m999/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const { readFileSync, writeFileSync, existsSync } = require('node:fs');
const { join } = require('node:path');
const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');
(async () => {
  const recovery = JSON.parse(readFileSync('artifacts/codex-live-recovery.json', 'utf8')),
    directory = recovery.restoredDirectory;
  const child = spawn(process.execPath, ['dist/src/server.js'], {
    env: {
      ...process.env,
      FORKWISE_PORT: '8897',
      FORKWISE_DATA_DIR: directory,
      FORKWISE_OLLAMA_MODEL: '',
      FORKWISE_OLLAMA_VISION_MODEL: '',
      SEC_USER_AGENT: '',
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let errors = [],
    browser,
    logs = '';
  child.stderr.on('data', (b) => {
    logs += String(b);
  });
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  try {
    for (let i = 0; i < 100; i++) {
      if (existsSync(join(directory, 'local-access.json'))) {
        try {
          if ((await fetch('http://127.0.0.1:8897/health')).ok) break;
        } catch {}
      }
      await wait(100);
    }
    if (child.exitCode !== null) throw new Error(logs || '服务启动失败');
    const credentials = JSON.parse(readFileSync(join(directory, 'local-access.json'), 'utf8'));
    const api = async (path) => {
      const response = await fetch(
        credentials.origin + '/api/v1/projects/' + recovery.projectId + path,
        { headers: { Authorization: `Bearer ${credentials.token}` } },
      );
      assert.equal(response.status, 200);
      return (await response.json()).data;
    };
    browser = await chromium.launch({ channel: 'chrome', headless: true });
    const page = await browser.newPage({ viewport: { width: 1680, height: 1080 } });
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(credentials.url);
    await page.locator('#connection').filter({ hasText: '已连接' }).waitFor();
    const frame = page.frameLocator('#native-canvas');
    await frame.getByRole('button', { name: '＋ 新建卡', exact: true }).waitFor();
    const state = await api('/state'),
      layout = await api('/layout');
    const statement = state.objects.find((e) => e.kind === 'statement');
    assert.ok(statement);
    await page.locator(`#object-list button[data-id="${statement.id}"]`).click();
    await frame.locator('[data-object-action="more"]').waitFor();
    await page.screenshot({ path: 'artifacts/local-delivery-desktop.png', fullPage: true });
    // Native drawing is persisted to the same canonical annotation collection.
    const tool = frame.locator('label').filter({ has: frame.getByTestId('toolbar-rectangle') });
    await tool.click();
    const bounds = await page.locator('#native-canvas').boundingBox();
    const x = bounds.x + bounds.width - 150,
      y = bounds.y + 180;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + 80, y + 70, { steps: 12 });
    await page.mouse.up();
    let edited;
    for (let i = 0; i < 100; i++) {
      edited = await api('/layout');
      if (
        edited.version > layout.version &&
        edited.data.canvas.annotations.elements.length >
          layout.data.canvas.annotations.elements.length
      )
        break;
      await wait(100);
    }
    assert.ok(edited.version > layout.version, '原生绘图没有保存');
    const newId = edited.data.canvas.annotations.elements.find(
      (e) => !layout.data.canvas.annotations.elements.some((p) => p.id === e.id),
    ).id;
    await page.reload();
    await frame.getByRole('button', { name: '＋ 新建卡', exact: true }).waitFor();
    assert.ok((await api('/layout')).data.canvas.annotations.elements.some((e) => e.id === newId));
    await page.locator('#list-grants').click();
    assert.equal(
      await page.locator('#grant-list button').count(),
      0,
      '恢复后不应重授旧 Agent 权限',
    );
    await page.screenshot({ path: 'artifacts/local-delivery-restored-ui.png', fullPage: true });
    assert.deepEqual(errors, []);
    writeFileSync(
      'artifacts/local-delivery-ui.json',
      JSON.stringify(
        {
          tier: '真实 Codex 写入／SQLite 恢复后的工作台与原生绘图回写',
          projectId: recovery.projectId,
          restoredDirectory: directory,
          objectCount: state.objects.length,
          drawingIds: layout.data.canvas.annotations.elements.map((e) => e.id),
          nativeDrawingId: newId,
          nativeDrawingPersisted: true,
          restoredGrants: 0,
          pageErrors: errors,
        },
        null,
        2,
      ),
    );
    console.log(
      'PASS 真实 Codex 结果在恢复后的原生画布显示；原生绘图回写与刷新保留；旧授权未恢复。',
    );
  } finally {
    await browser?.close();
    child.kill('SIGTERM');
    await new Promise((r) => (child.exitCode !== null ? r() : child.once('exit', r)));
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
