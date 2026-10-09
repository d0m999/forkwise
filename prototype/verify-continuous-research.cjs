#!/usr/bin/env node
'use strict';

// 独立验收：纯模型检查 + 隔离浏览器中的真实操作。
// 不复用个人浏览器配置，不访问外部服务，不调用真实 AI。
// 运行：node prototype/verify-continuous-research.cjs [--model-only|--layout-only]
// NODE_PATH 可指向已安装的 playwright；也自动发现 Codex bundled runtime。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const http = require('node:http');
const os = require('node:os');

const root = __dirname;
const html = fs.readFileSync(path.join(root, 'forkwise-step-prototype.html'), 'utf8');
const results = [];
const clone = value => JSON.parse(JSON.stringify(value));
const same = (actual, expected, message) => assert.deepEqual(clone(actual), clone(expected), message);
const sorted = values => [...values].sort();
function pass(name) { results.push(name); console.log(`PASS ${name}`); }

function verifyModel() {
  const match = html.match(/<script id="open-research-model">([\s\S]*?)<\/script>/);
  assert.ok(match, '研究模型脚本存在');
  const scope = vm.createContext({ URL });
  vm.runInContext(`${match[1]}\nthis.model = OpenStudy;`, scope);
  const model = scope.model;
  assert.equal(typeof model.adoptionPlan, 'function', '部分收录预览合同已接入');
  const apply = (state, action) => {
    const next = model.reduce(state, { at: '2026-10-04T12:00:00.000Z', ...action });
    assert.equal(next.error, '', `${action.type}: ${next.error}`);
    return next;
  };
  let candidate = apply(model.seed(), { type: 'reconstruct' });
  candidate = apply(candidate, { type: 'verify' });
  const joint = model.adoptionPlan(candidate, ['j1']);
  const ids = values => values.map(value => typeof value === 'string' ? value : value.id);
  same(sorted(ids(joint.nodes)), ['c1', 'p1', 'p2'], '联合推导补全全部直接前提与结论');
  same(ids(joint.edges), ['j1'], '不暗中收录独立支持');
  assert.equal(joint.error || '', '');
  pass('模型：联合推导的完整直接范围');

  const lone = apply(candidate, { type: 'adopt-selected', ids: ['p1'] });
  same(Object.keys(lone.mine.nodes), ['p1']);
  same(Object.keys(lone.mine.edges), []);
  const adopted = apply(candidate, { type: 'adopt-selected', ids: ['j1'] });
  same(sorted(Object.keys(adopted.mine.nodes)), ['c1', 'p1', 'p2']);
  same(Object.keys(adopted.mine.edges), ['j1']);
  assert.equal(adopted.mine.nodes.q4, undefined, '未选 AI 候选保留在候选区');
  assert.equal(adopted.mine.edges.s2, undefined, '无关独立支持未收录');
  same(sorted(Object.keys(adopted.baseline.nodes)), ['c1', 'p1', 'p2']);
  pass('模型：单主张与部分链条都只收录明确范围');

  let edited = apply(adopted, { type: 'select', id: 'p1' });
  edited = apply(edited, { type: 'edit', text: '按本人的观察窗口重新核对量产时间', reason: '测试局部收录不覆盖改写' });
  const oldBaseline = clone(edited.baseline);
  const oldPersonal = clone(edited.mine.nodes.p1);
  let appended = apply(edited, { type: 'mode', mode: 'author' });
  appended = apply(appended, { type: 'adopt-selected', ids: ['s3'] });
  same(appended.mine.nodes.p1, oldPersonal, '追加保留已有个人改写与版本');
  for (const [id, node] of Object.entries(oldBaseline.nodes)) same(appended.baseline.nodes[id], node);
  for (const [id, edge] of Object.entries(oldBaseline.edges)) same(appended.baseline.edges[id], edge);
  same(sorted(Object.keys(appended.mine.edges)), ['j1', 's3']);
  assert.ok(appended.mine.nodes.c2);
  assert.equal(appended.mine.nodes.p3, undefined);
  assert.equal(appended.mine.nodes.q4, undefined);
  pass('模型：追加下一步保留个人改写、旧基线及未选路径');

  const ai = apply(candidate, { type: 'adopt-selected', ids: ['q4'] });
  assert.equal(ai.mine.nodes.q4.originKind, 'ai');
  assert.equal(ai.mine.nodes.q4.stance, '待研究');
  same(Object.keys(ai.mine.edges), []);
  const invalid = model.reduce(candidate, { type: 'adopt-selected', ids: ['missing-object'] });
  assert.ok(invalid.error, '失效选区明确拒绝');
  assert.equal(invalid.mine, null);
  pass('模型：显式收录 AI 保留归属；失效范围不产生个人版');

  let reversed = apply(candidate, { type: 'adopt-selected', ids: ['p1', 'c1'] });
  reversed = apply(reversed, { type: 'select', id: 'c1' });
  reversed = apply(reversed, { type: 'start-link' });
  reversed = apply(reversed, { type: 'select', id: 'p1' });
  reversed = apply(reversed, { type: 'connect', text: '个人版本明确建立相反方向的待研究推导' });
  reversed = apply(reversed, { type: 'mode', mode: 'author' });
  const loopPlan = model.adoptionPlan(reversed, ['j1']);
  assert.match(loopPlan.error || '', /回环/, '合并后成环应在收录预览明确拒绝');
  const loopRejected = model.reduce(reversed, { type: 'adopt-selected', ids: ['j1'] });
  assert.match(loopRejected.error || '', /回环/);
  same(loopRejected.mine, reversed.mine, '拒绝整个收录操作，保留个人图');
  same(loopRejected.baseline, reversed.baseline, '拒绝操作不污染收录基线');
  const safeAppend = apply(reversed, { type: 'adopt-selected', ids: ['q4'] });
  assert.ok(safeAppend.mine.nodes.q4, '无关联 AI 候选仍可显式收录');
  same(safeAppend.mine.edges, reversed.mine.edges);
  pass('模型：与已有个人推导合并成环时原子拒绝，无关候选仍可收录');
}

function playwright() {
  try { return require('playwright'); } catch (error) {
    const bundled = path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
    if (fs.existsSync(bundled)) return require(bundled);
    throw new Error('未找到 playwright。请用带 Playwright 的 Node runtime，或设置 NODE_PATH。');
  }
}

async function localServer() {
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.woff2': 'font/woff2', '.png': 'image/png' };
  const server = http.createServer((request, response) => {
    const pathname = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname);
    let filename = path.resolve(root, `.${pathname}`);
    if (!filename.startsWith(`${root}${path.sep}`) && filename !== root) { response.writeHead(403).end(); return; }
    if (fs.existsSync(filename) && fs.statSync(filename).isDirectory()) filename = path.join(filename, 'index.html');
    if (!fs.existsSync(filename)) { response.writeHead(404).end(); return; }
    response.writeHead(200, { 'Content-Type': types[path.extname(filename)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    fs.createReadStream(filename).pipe(response);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { server, origin: `http://127.0.0.1:${server.address().port}` };
}

async function verifyBrowser() {
  const { server, origin } = await localServer();
  const screenshots = path.join(root, 'screenshots');
  fs.mkdirSync(screenshots, { recursive: true });
  const browser = await playwright().chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  context.setDefaultTimeout(10000);
  const external = [], errors = [];
  await context.route('**/*', route => {
    const url = route.request().url();
    if (url.startsWith(origin) || /^(data:|blob:)/.test(url)) return route.continue();
    external.push(url); return route.abort();
  });
  await context.addInitScript(() => {
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...args) {
      if (window.__failWorkspaceWrites && this.name === 'snapshots') throw new DOMException('验收模拟磁盘额度不足', 'QuotaExceededError');
      return put.apply(this, args);
    };
  });
  let page = await context.newPage();
  const observe = target => target.on('pageerror', error => errors.push(error.message));
  observe(page);
  const inspect = () => page.evaluate(() => window.ForkwisePrototype.inspect());
  const until = async (predicate, description) => {
    const deadline = Date.now() + 12000;
    while (Date.now() < deadline) {
      if (await predicate()) return;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error(`等待超时：${description}`);
  };
  const stateIs = condition => until(async () => condition(await inspect()), '研究状态断言');
  const saved = () => stateIs(value => value.saveStatus?.state === 'saved');
  const frame = () => page.frameLocator('#lab-sdk-frame');
  const select = async (id, shift = false) => {
    await frame().locator(`[data-details-card="${id}"]`).click(shift ? { modifiers: ['Shift'] } : {});
    await until(async () => (await frame().locator('.object-toolbar').getAttribute('data-selected-ids') || '').split(',').includes(id), `选中 ${id}`);
    await stateIs(s => Object.keys(s.canvasState?.scenes?.[s.study.mode]?.view?.selectedElementIds || {}).some(key => key.endsWith(`:card:${id}`)));
  };
  const history = async direction => {
    await frame().locator(`[data-history="${direction}"]`).click();
    await new Promise(resolve => setTimeout(resolve, 180));
  };
  const closeTour = async () => {
    const close = page.locator('[data-tour="skip"]');
    if (await close.isVisible()) await close.click();
  };
  const ready = async () => {
    await page.waitForFunction(() => window.ForkwisePrototype?.inspect().storageReady);
    await frame().locator('.canvas-extras').waitFor();
    await closeTour();
  };
  const adoption = async id => {
    await select(id);
    await frame().locator('[data-object-action="adopt"]').click();
    const confirm = page.locator('[data-lab="confirm-adoption"]');
    await confirm.waitFor();
    return confirm;
  };
  const layout = snapshot => Object.fromEntries(Object.entries(snapshot.study.mine.nodes).map(([id, n]) => [id, { x: n.x, y: n.y }]));
  const styles = snapshot => snapshot.canvasState?.scenes?.mine?.styles || {};
  const annotations = snapshot => (snapshot.canvasState?.annotations?.elements || []).filter(element => !element.isDeleted);
  const view = snapshot => snapshot.canvasState?.scenes?.mine?.view;
  try {
    await page.goto(`${origin}/forkwise-step-prototype.html`);
    await ready();
    await page.locator('[data-lab="load-example"]').click();
    await page.locator('[data-lab="submit-opinion"]').click();
    await stateIs(s => Boolean(s.study.author.edges.j1));
    const confirmation = await adoption('j1');
    const preview = await page.locator('#lab-dialog').innerText();
    assert.match(preview, /前提|主张/);
    assert.match(preview, /18A/);
    assert.equal((await inspect()).study.mine, null, '预览不会提前收录');
    await page.screenshot({ path: path.join(screenshots, 'continuous-research-adoption-preview.png') });
    await confirmation.click();
    await stateIs(s => s.study.mode === 'mine' && Boolean(s.study.mine?.edges.j1));
    let current = await inspect();
    same(sorted(Object.keys(current.study.mine.nodes)), ['c1', 'p1', 'p2']);
    same(Object.keys(current.study.mine.edges), ['j1']);
    await history('undo');
    await stateIs(s => s.study.mine === null);
    await history('redo');
    await stateIs(s => Boolean(s.study.mine?.edges.j1));
    pass('浏览器：预览后部分收录，一次撤销与重做');

    await select('p1');
    await frame().locator('[data-object-action="rewrite"]').click();
    const editor = frame().getByRole('dialog', { name: '改写当前对象' });
    await editor.locator('textarea').fill('本人改写：量产仍需核对交付窗口');
    await editor.getByRole('button', { name: '保存改写', exact: true }).click();
    await stateIs(s => s.study.mine.nodes.p1.version === 2);
    const edited = await inspect();
    const originalBaseline = clone(edited.study.baseline);

    const beforeDrawing = annotations(edited).length;
    await frame().getByRole('radio', { name: '矩形', exact: true }).locator('xpath=..').click();
    const box = await page.locator('#lab-sdk-frame').boundingBox();
    await page.mouse.move(box.x + box.width - 230, box.y + box.height - 260);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width - 130, box.y + box.height - 200, { steps: 8 });
    await page.mouse.up();
    await page.keyboard.press('Escape');
    await stateIs(s => annotations(s).length === beforeDrawing + 1);
    const drawn = await inspect();
    await select('p1');
    await frame().locator('[data-object-action="more"]').click();
    await frame().locator('[data-object-action="style"]').click();
    await frame().getByRole('combobox', { name: '线宽', exact: true }).selectOption('4');
    await frame().getByRole('button', { name: '完成', exact: true }).click();
    await stateIs(s => JSON.stringify(styles(s)) !== JSON.stringify(styles(drawn)));
    await history('undo');
    await stateIs(s => JSON.stringify(styles(s)) === JSON.stringify(styles(drawn)));
    assert.equal(annotations(await inspect()).length, beforeDrawing + 1, '撤销样式保留此前绘图');
    await history('undo');
    await stateIs(s => annotations(s).length === beforeDrawing);
    assert.equal((await inspect()).study.mine.nodes.p1.version, 2, '撤销绘图保留此前改写');
    await history('undo');
    await stateIs(s => s.study.mine.nodes.p1.version === 1);
    for (let i = 0; i < 3; i++) await history('redo');
    await stateIs(s => s.study.mine.nodes.p1.version === 2 && annotations(s).length === beforeDrawing + 1);
    pass('浏览器：改写 → 绘图 → 样式交错操作按一次序列撤销重做');

    await page.locator('[data-lab="mode"][data-mode="author"]').click();
    await page.locator('[data-lab="fit"]').click();
    await (await adoption('s3')).click();
    await stateIs(s => Boolean(s.study.mine?.edges.s3));
    current = await inspect();
    same(current.study.mine.nodes.p1, edited.study.mine.nodes.p1);
    for (const [id, item] of Object.entries(originalBaseline.nodes)) same(current.study.baseline.nodes[id], item);
    assert.equal(current.study.mine.edges.s2, undefined);
    assert.equal(current.study.mine.nodes.q4, undefined);
    pass('浏览器：后续追加保留个人改写、旧基线与未选内容');

    await page.locator('[data-lab="fit"]').click();
    await select('p1'); await select('c1', true);
    const beforeLayout = await inspect();
    await frame().locator('[data-object-action="arrange"]').click();
    await page.screenshot({ path: path.join(screenshots, 'continuous-research-local-layout.png') });
    await frame().locator('[data-layout="top"]').click();
    await stateIs(s => s.study.mine.nodes.p1.y === s.study.mine.nodes.c1.y);
    const afterLayout = await inspect();
    for (const id of ['p2', 'c2']) same(layout(afterLayout)[id], layout(beforeLayout)[id], '未选对象位置保持');
    same(afterLayout.study.mine.edges, beforeLayout.study.mine.edges, '排版不改推导');
    await history('undo');
    await stateIs(s => JSON.stringify(layout(s)) === JSON.stringify(layout(beforeLayout)));
    await history('redo');
    await stateIs(s => JSON.stringify(layout(s)) === JSON.stringify(layout(afterLayout)));
    pass('浏览器：局部对齐只移动所选对象，一次撤销恢复');
    await select('p1');
    await frame().locator('[data-object-action="structure"]').click();
    await page.locator('[data-lab="start-link"]').click();
    await stateIs(s => s.study.linkFrom === 'p1');
    const beforeCancel = (await inspect()).study.mine.edges;
    if (await page.locator('[data-lab="task-done"]').isVisible()) await page.locator('[data-lab="task-done"]').click();
    await page.locator('#lab-sdk-frame').focus();
    await page.keyboard.press('Escape');
    await stateIs(s => s.study.linkFrom === null);
    same((await inspect()).study.mine.edges, beforeCancel, '取消连线不改已有推导');
    pass('浏览器：画布焦点内 Esc 取消待建立推导');
    if (process.argv.includes('--layout-only')) { same(external, []); same(errors, []); return; }

    await select('p1');
    const beforeSource = await inspect();
    await frame().locator('[data-object-action="source"]').click();
    await frame().getByRole('button', { name: /查看原文并定位/ }).first().click();
    await page.locator('#lab-reader-window').waitFor({ state: 'visible' });
    assert.match(await page.locator('#lab-reader').innerText(), /v1|版本 1|版本：1/);
    await page.locator('[data-lab="expand-reader"]').click();
    await page.locator('[data-lab="return-canvas"]').click();
    await stateIs(s => s.study.selected === 'p1');
    const afterSource = await inspect();
    same(view(afterSource), view(beforeSource), '材料放大返回恢复所选与视口');
    pass('浏览器：来源版本回查、放大、返回保留选择和视口');

    await page.locator('[data-lab="open-reader"]').click();
    await page.locator('#lab-paste-details summary').click();
    await page.locator('#lab-source-title').fill('持续研究验收材料');
    await page.locator('#lab-source-author').fill('测试资料作者');
    await page.locator('#lab-source-url').fill('https://example.com/research-version-1');
    await page.locator('#lab-source-coverage').selectOption('excerpt');
    await page.locator('#lab-paste').fill('本材料只用于本机原型验收；交付窗口仍需观察。');
    await page.locator('[data-lab="add-source"]').click();
    await page.locator('[data-lab="return-canvas"]').click();
    await saved();
    const firstProject = await inspect();
    const firstProjectId = firstProject.projectId;
    await page.reload(); await ready();
    current = await inspect();
    same(current.study.sources, firstProject.study.sources, '刷新恢复材料及其版本');
    same(current.study.mine, firstProject.study.mine, '刷新恢复个人内容及引用');
    same(current.study.baseline, firstProject.study.baseline, '刷新恢复基线');
    same(annotations(current), annotations(firstProject), '刷新恢复批注');
    same(styles(current), styles(firstProject), '刷新恢复样式');
    same(view(current), view(firstProject), '刷新恢复视口');
    await page.screenshot({ path: path.join(screenshots, 'continuous-research-restored.png') });
    pass('浏览器：刷新恢复材料、引用版本、改写、基线、批注、样式与视口');

    await select('p1');
    await frame().locator('[data-object-action="rewrite"]').click();
    await frame().getByRole('dialog', { name: '改写当前对象' }).locator('textarea').fill('尚未提交的改写草稿仍可继续');
    await stateIs(s => s.canvasState?.drafts?.mine?.text === '尚未提交的改写草稿仍可继续');
    await saved();
    await page.reload(); await ready();
    const restoredDraft = frame().getByRole('dialog', { name: '改写当前对象' });
    assert.equal(await restoredDraft.locator('textarea').inputValue(), '尚未提交的改写草稿仍可继续');
    assert.equal((await inspect()).study.mine.nodes.p1.text, firstProject.study.mine.nodes.p1.text, '未提交草稿未写入主张版本');
    await restoredDraft.getByRole('button', { name: '取消', exact: true }).click();
    pass('浏览器：刷新恢复未提交改写草稿，正文版本保持');

    await page.locator('[data-lab="new-project"]').click();
    await stateIs(s => s.projectId !== firstProjectId);
    const secondId = (await inspect()).projectId;
    assert.equal((await inspect()).study.mine, null);
    assert.equal((await inspect()).study.sources.some(source => source.title === '持续研究验收材料'), false, '新项目不混入旧材料');
    await page.locator('#lab-research-question').fill('第二项独立研究');
    await page.locator('#lab-research-question').press('Tab');
    await saved();
    assert.equal(annotations(await inspect()).length, 0, '新项目不混入旧批注');
    const firstTab = page;
    page = await context.newPage(); observe(page);
    await page.goto(`${origin}/forkwise-step-prototype.html`); await ready();
    assert.equal((await inspect()).projectId, secondId, '同浏览器新标签恢复当前项目');
    await page.locator('[data-lab="toggle-projects"]').click();
    await page.locator(`[data-lab="switch-project"][data-project="${firstProjectId}"]`).click();
    await stateIs(s => s.projectId === firstProjectId);
    same((await inspect()).study.mine, firstProject.study.mine);
    same(annotations(await inspect()), annotations(firstProject));
    await firstTab.close();
    pass('浏览器：新标签恢复与项目材料／画布隔离');

    await page.evaluate(() => { window.__failWorkspaceWrites = true; });
    await page.locator('#lab-research-question').fill('保存失败时仍留在页面的研究问题');
    await page.locator('#lab-research-question').press('Tab');
    await stateIs(s => s.saveStatus?.state === 'error');
    assert.match(await page.locator('body').innerText(), /未保存|保存失败|无法保存/);
    assert.equal((await inspect()).study.question, '保存失败时仍留在页面的研究问题');
    await page.evaluate(() => { window.__failWorkspaceWrites = false; });
    await page.locator('#lab-research-question').fill('保存恢复后的研究问题');
    await page.locator('#lab-research-question').press('Tab');
    await saved();
    await page.reload(); await ready();
    assert.equal((await inspect()).study.question, '保存恢复后的研究问题');
    pass('浏览器：真实存储写入失败有未保存反馈，后续成功保存可恢复');

    same(external, [], '没有外部网络请求或真实 AI 请求');
    same(errors, [], '没有浏览器页面异常');
    pass('浏览器：全流程无外部请求、无页面异常');
  } catch (error) {
    const prefix = path.join(os.tmpdir(), 'forkwise-continuous-research-failure');
    await page.screenshot({ path: `${prefix}.png`, fullPage: true }).catch(() => {});
    const snapshot = await inspect().catch(() => null);
    fs.writeFileSync(`${prefix}.json`, JSON.stringify({ error: String(error), snapshot, errors, external }, null, 2));
    console.error(`失败现场：${prefix}.png / ${prefix}.json`);
    throw error;
  } finally {
    await context.close(); await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
}

(async () => {
  if (!process.argv.includes('--layout-only')) verifyModel();
  if (!process.argv.includes('--model-only')) await verifyBrowser();
  console.log(`\n${results.length} 组独立检查通过。`);
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
