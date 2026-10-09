#!/usr/bin/env node
'use strict';

// 直接画布独立浏览器检查。只使用新建的隔离 browser contexts，不碰用户标签或存储。
// node prototype/verify-direct-canvas.cjs [--object-ui-only|--selection-only|--ui-only|--migration-only|--review-only|--stance-history-only|--canvas-actions-only|--navigation-only|--project-delete-only]
// 默认访问 http://127.0.0.1:47865，可用 FORKWISE_TEST_ORIGIN 覆盖。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const origin = process.env.FORKWISE_TEST_ORIGIN || 'http://127.0.0.1:47865';
const entry = `${origin}/forkwise-step-prototype.html`;
const clone = value => JSON.parse(JSON.stringify(value));
const same = (actual, expected, label) => assert.deepEqual(clone(actual), clone(expected), label);
const count = graph => Object.keys(graph.nodes).length;
const passed = [];
const pass = text => { passed.push(text); console.log(`PASS ${text}`); };
function playwright() {
  try { return require('playwright'); } catch {
    return require(path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));
  }
}
function model() {
  const html = fs.readFileSync(path.join(__dirname, 'forkwise-step-prototype.html'), 'utf8');
  const body = html.match(/<script id="open-research-model">([\s\S]*?)<\/script>/)?.[1];
  assert.ok(body, '研究模型存在');
  const scope = vm.createContext({ URL });
  vm.runInContext(`${body}\nthis.model=OpenStudy;`, scope);
  return scope.model;
}
function legacyWorkspace() {
  const m = model();
  const apply = (s, action) => {
    const next = m.reduce(s, { at: '2026-10-04T12:00:00.000Z', ...action });
    assert.equal(next.error, '', `旧格式夹具构建：${next.error}`); return next;
  };
  const strip = s => {
    const result = clone(s); delete result.directCanvas; result.undo = [];
    for (const graph of [result.author, result.mine, result.baseline].filter(Boolean)) {
      for (const collection of ['nodes', 'edges']) for (const n of Object.values(graph[collection])) delete n.researchUse;
    }
    return result;
  };
  const reconstructed = apply(apply(m.seed(), { type: 'reconstruct' }), { type: 'verify' });
  const author = strip(reconstructed); author.mine = null; author.baseline = null; author.mode = 'author'; author.selected = 'p1';
  let partial = apply(author, { type: 'adopt-selected', ids: ['j1'] });
  partial = apply(partial, { type: 'select', id: 'p1' });
  const beforeEdit = strip(partial);
  partial = strip(apply(partial, { type: 'edit', text: 'D65 已有个人改写：量产时间仍待观察', reason: '旧研究保留' }));
  const empty = strip(m.seed()); empty.mode = 'author'; empty.mine = null;
  const canvas = (id, mode) => ({ scenes: { [mode]: { styles: { [`forkwise:${id}:${mode}:card:p1`]: { strokeWidth: 4, strokeColor: '#276e68' } }, view: { scrollX: 42, scrollY: 26, zoom: { value: 0.6 }, selectedElementIds: { [`forkwise:${id}:${mode}:card:p1`]: true }, selectedGroupIds: {}, viewBackgroundColor: '#ffffff', theme: 'light' } } }, annotations: { elements: [], files: {} }, drafts: {} });
  const record = (study, id, timeline) => ({ study: {...study,linkFrom:'p1'}, view: { x: 30, y: 20, scale: 1 }, formCache: {}, inspectorView: 'structure', composer: { text: '', title: '', status: '', sourceId: null }, readerDraft: { text: '', title: '', author: '', originalUrl: '', coverage: 'excerpt', open: false }, canvasState: canvas(id, study.mode), timeline });
  const snapshot = (study, id) => ({ study: clone(study), canvasState: canvas(id, study.mode), view: { x: 30, y: 20, scale: 1 } });
  const authorHistory = { past: [{ label: 'D65 梳理候选', before: snapshot(empty, 'project-1'), after: snapshot(author, 'project-1') }], future: [] };
  const partialHistory = { past: [{ label: 'D65 个人改写', before: snapshot(beforeEdit, 'project-2'), after: snapshot(partial, 'project-2') }], future: [] };
  return { payload: { format: 'forkwise-prototype-workspace', version: 1, activeProjectId: 'project-2', projectSerial: 2, navPinned: false, projects: [['project-1', record(author, 'project-1', authorHistory)], ['project-2', record(partial, 'project-2', partialHistory)]], aiThreads: [] }, author, partial, beforeEdit };
}
async function session(browser) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  context.setDefaultTimeout(10000);
  const errors = [], external = [];
  await context.route('**/*', route => {
    const url = route.request().url();
    if (url.startsWith(origin) || /^(data:|blob:)/.test(url)) return route.continue();
    external.push(url); return route.abort();
  });
  await context.addInitScript(() => {
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...args) {
      if (window.__failWorkspaceWrites && this.name === 'snapshots') throw new DOMException('D66 验收：存储额度不足', 'QuotaExceededError');
      return put.apply(this, args);
    };
  });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  const inspect = () => page.evaluate(() => window.ForkwisePrototype.inspect());
  const until = async (predicate, label = '状态变化') => {
    const deadline = Date.now() + 12000;
    while (Date.now() < deadline) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 40)); }
    throw new Error(`等待超时：${label}`);
  };
  const state = fn => until(async () => fn(await inspect()), '研究状态');
  const saved = () => state(s => s.saveStatus.state === 'saved');
  const frame = () => page.frameLocator('#lab-sdk-frame');
  const ready = async () => {
    await page.waitForFunction(() => window.ForkwisePrototype?.inspect().storageReady);
    await frame().locator('.canvas-extras').waitFor();
    const skip = page.locator('[data-tour="skip"]'); if (await skip.isVisible()) await skip.click();
  };
  const select = async (id, shift = false) => {
    const item = frame().locator(`[data-details-card="${id}"]`);
    if (!await item.isVisible()) await page.locator('[data-lab="fit"]').click();
    await item.click(shift ? { modifiers: ['Shift'] } : {});
    await until(async () => (await frame().locator('.object-toolbar').getAttribute('data-selected-ids') || '').split(',').includes(id), `选中 ${id}`);
    await state(s => s.study.mine?.edges[id] ? !Object.keys(s.canvasState?.scenes?.mine?.view?.selectedElementIds || {}).some(key => key.endsWith(`:card:${id}`) || key.includes(`:link:${id}:`)) : Object.keys(s.canvasState?.scenes?.mine?.view?.selectedElementIds || {}).some(key => key.endsWith(`:card:${id}`)));
  };
  const objectAction = async name => {
    const target=frame().locator(`[data-object-action="${name}"]`);
    if(!await target.isVisible())await frame().locator('[data-object-action="more"]').click();
    await target.click();
  };
  const history = async direction => { await frame().locator(`[data-history="${direction}"]`).click(); await new Promise(resolve => setTimeout(resolve, 180)); };
  const endTask = async () => { const done = page.locator('[data-lab="task-done"]'); if (await done.isVisible()) await done.click(); };
  const edit = async id => { await select(id); await frame().locator('[data-object-action="rewrite"]').click(); return frame().getByRole('dialog', { name: '改写当前对象' }); };
  const screenshot = async name => { const filename = path.join(os.tmpdir(), `forkwise-d66-${name}.png`); await page.screenshot({ path: filename }); console.log(`截图 ${filename}`); };
  return { context, page, inspect, until, state, saved, frame, ready, select, history, endTask, edit, objectAction, screenshot, errors, external };
}
const annotations = s => (s.canvasState?.annotations?.elements || []).filter(e => !e.isDeleted);
const styles = s => s.canvasState?.scenes?.mine?.styles || {};
const view = s => s.canvasState?.scenes?.mine?.view;
async function verifyObjectUI(s, fallback=false) {
  const {page,inspect,state,frame,ready,select,objectAction,endTask,saved}=s;
  await page.goto(entry);await ready();
  await page.locator('[data-lab="load-example"]').click();await page.locator('[data-lab="submit-opinion"]').click();
  await state(x=>Boolean(x.study.mine?.edges.j1));
  if(fallback)await page.locator('#lab-engine').evaluate(el=>{el.value='research';el.dispatchEvent(new Event('change'));});
  const original=await inspect(),chrome=[];
  const screens=path.join(os.homedir(),'.codex/visualizations/2026/10/05/unified-object-ui');fs.mkdirSync(screens,{recursive:true});
  for(const id of ['p1','j1']){
    const line=id==='j1';
    if(fallback){await page.locator('[data-lab="fit"]').click();await page.locator(`[data-object="${id}"]`).click({position:{x:35,y:12}});}else await select(id);
    const bar=fallback?page.locator('#lab-fallback-actions'):frame().locator('.object-toolbar');
    const primary=fallback?bar.locator(':scope > button'):bar.locator('.object-toolbar-actions > button');
    same(await primary.allTextContents(),[line?'说明':'改写','查证与立场',...(fallback?[]:['更多'])]);
    if(fallback)await bar.locator('summary').click();else await frame().locator('[data-object-action="more"]').click();
    const menu=bar.locator('.object-menu-flat');assert.equal(await menu.evaluate(el=>getComputedStyle(el).flexDirection),'column');
    same(await menu.locator('button').allTextContents(),['材料','随动批注','来源','AI 讨论','待查问题',...(line?[]:['试一个假设']),'修改记录',...(fallback?[]:[line?'线条样式':'卡片样式',line?'聚焦这步推导':'聚焦相关推导']),line?'删除这步推导':'删除卡片']);
    await page.screenshot({path:path.join(screens,`d76-${fallback?'fallback':'native'}-${line?'line':'card'}-menu.png`)});
    await bar.screenshot({path:path.join(screens,`d76-${fallback?'fallback':'native'}-${line?'line':'card'}-menu-detail.png`)});
    if(!fallback)assert.ok(!await page.locator('#lab-result').isVisible(),'菜单展开时收起画布反馈，避免遮挡');
    same((await inspect()).study.mine,original.study.mine);
    if(fallback){await menu.locator('[data-task="source"]').click();await page.locator('#lab-inspector-window:not(.hidden)').waitFor();assert.match(await page.locator('#lab-inspector').innerText(),/来源|原句|原文/);await endTask();await bar.locator('[data-task="edit"]').click();}
    else {await objectAction('source');assert.equal(await frame().locator('.source-popover header strong').innerText(),'来源');await frame().locator('.source-popover [aria-label="关闭来源"]').click();await frame().locator('[data-object-action="rewrite"]').click();}
    const editor=fallback?page.locator('#lab-inspector-window'):frame().locator('.inline-claim');
    const title=fallback?editor.locator('#lab-inspector-title'):editor.locator('header strong');assert.equal(await title.innerText(),line?'推导说明':'改写正文');
    chrome.push(await editor.evaluate(el=>{const s=getComputedStyle(el);return {border:s.borderRadius,font:s.fontSize,color:s.color}}));
    await page.screenshot({path:path.join(screens,`d76-${fallback?'fallback':'native'}-${line?'line':'card'}-edit.png`)});
    if(fallback)await endTask();else await editor.getByRole('button',{name:'取消',exact:true}).click();
    same((await inspect()).study.mine,original.study.mine);
    if(fallback){await bar.locator('summary').click();await bar.locator('[data-task="question"]').click();}
    else await objectAction('question');
    await page.locator('#lab-inspector-window:not(.hidden)').waitFor();assert.equal(await page.locator('#lab-inspector-title').innerText(),'待查问题');await endTask();
    if(!fallback){await select(id);await objectAction('ai');await page.locator('[data-ai-scope]').waitFor();assert.ok((await page.locator('[data-ai-scope]').innerText()).length>0);await endTask();}
  }
  same(chrome[0],chrome[1],'卡与推导编辑窗口采用相同视觉参数');
  assert.equal((await inspect()).timeline.past.length,original.timeline.past.length);
  if(!fallback){
    await page.setViewportSize({width:390,height:844});await frame().locator('[data-object-action="more"]').click();
    const bar=await frame().locator('.object-toolbar').boundingBox();assert.ok(bar.x>=0&&bar.x+bar.width<=391,'窄窗菜单不横向溢出');await frame().locator('[data-object-action="delete"]').scrollIntoViewIfNeeded();assert.ok(await frame().locator('[data-object-action="delete"]').isVisible());
    await page.screenshot({path:path.join(screens,'d76-narrow-line-menu.png')});
    await frame().locator('[data-object-action="more"]').click();await saved();const persistent=await inspect();await page.reload();await ready();same((await inspect()).study.mine,persistent.study.mine);
  }
  pass(`D76${fallback?' HTML兼容回退':' 完整画布'}：卡与推导三按钮/同序单列菜单、来源/编辑/待查/AI入口、编辑窗口视觉一致、查看与取消不改正文和历史${fallback?'':'、窄窗与刷新保持'}`);
}
async function verifySelection(s) {
  const { page, inspect, state, frame, ready, select } = s;
  await page.goto(entry); await ready();
  await page.locator('[data-lab="load-example"]').click();
  await page.locator('[data-lab="submit-opinion"]').click();
  await state(x => Boolean(x.study.mine?.edges.j1));
  await select('p1');
  const before = await inspect();
  await frame().locator('[data-object-action="more"]').click();
  assert.equal(await frame().locator('[data-object-action="organize"]').count(), 0);
  await researchTool(page,'#lab-tools summary');
  assert.equal(await page.locator('[data-lab="organize"]').count(), 0);
  await researchTool(page,'#lab-tools summary');
  await select('p1'); await select('p2', true);
  assert.equal(await frame().locator('.object-toolbar').getAttribute('data-toolbar-count'), '2');
  assert.equal(await frame().locator('[data-object-action="organize"]').count(), 0);
  const multi = await inspect();
  await frame().locator('[data-object-action="focus"]').click();
  await frame().locator('.focus-scope').waitFor();
  same((await inspect()).study.mine, before.study.mine);
  assert.equal((await inspect()).timeline.past.length, before.timeline.past.length);
  await frame().locator('[data-object-action="return-view"]').click();
  await state(x => JSON.stringify(view(x)) === JSON.stringify(view(multi)));
  assert.equal(await frame().locator('.object-toolbar').getAttribute('data-toolbar-count'), '2');
  await select('j1');
  await frame().locator('[data-object-action="more"]').click();
  await frame().locator('[data-object-action="focus"]').click();
  await frame().locator('.focus-scope').waitFor();
  same((await inspect()).study.mine, before.study.mine);
  await frame().locator('[data-object-action="return-view"]').click();
  pass('D75：单选/多选/全局整理入口移除，Shift 多选、聚焦返回及整步推导聚焦保持，内容与历史不变');
}
async function verifyUI(s) {
  const { page, inspect, state, saved, frame, ready, select, history, endTask, edit, screenshot } = s;
  await page.goto(entry); await ready();
  await page.locator('[data-lab="load-example"]').click();
  await page.locator('[data-lab="submit-opinion"]').click();
  await state(x => x.study.mode === 'mine' && Boolean(x.study.mine.edges.j1));
  const initial = await inspect(), original = clone(initial.study.author), baseline = clone(initial.study.baseline), sources = clone(initial.study.sources);
  assert.equal(initial.study.directCanvas, true);
  assert.equal(await page.locator('[data-lab="adopt"]:visible').count(), 0);
  assert.equal(await page.locator('[data-lab="mode"]:visible').count(), 0);
  for (const n of [...Object.values(initial.study.mine.nodes), ...Object.values(initial.study.mine.edges)]) assert.equal(n.researchUse, 'reference');
  const firstEditor = await edit('p1');
  assert.equal(await firstEditor.getByRole('button', { name: '保存改写', exact: true }).isDisabled(), true);
  await firstEditor.locator('textarea').fill('D66 本人判断：量产仍需核对实际交付窗口');
  await firstEditor.getByRole('button', { name: '保存改写', exact: true }).click();
  await state(x => x.study.mine.nodes.p1.version === 2);
  let current = await inspect();
  assert.equal(current.study.mine.nodes.p1.researchUse, 'research');
  assert.equal(current.study.mine.nodes.p3.researchUse, 'reference');
  same(current.study.author, original); same(current.study.baseline, baseline); same(current.study.sources, sources);
  pass('直接画布：梳理后立即改写；未操作参考、原文与初始整理保持');
  await screenshot('direct-edit');

  const afterEdit = await inspect(), freeBefore = annotations(afterEdit).length;
  await frame().getByRole('radio', { name: '矩形', exact: true }).locator('xpath=..').click();
  const box = await page.locator('#lab-sdk-frame').boundingBox();
  await page.mouse.move(box.x + box.width - 220, box.y + box.height - 245); await page.mouse.down();
  await page.mouse.move(box.x + box.width - 135, box.y + box.height - 205, { steps: 8 }); await page.mouse.up(); await page.keyboard.press('Escape');
  await state(x => annotations(x).length === freeBefore + 1);
  const drawn = await inspect();
  await select('p1'); await frame().locator('[data-object-action="more"]').click(); await frame().locator('[data-object-action="style"]').click();
  await frame().getByRole('combobox', { name: '线宽', exact: true }).selectOption('4'); await frame().getByRole('button', { name: '完成', exact: true }).click();
  await state(x => JSON.stringify(styles(x)) !== JSON.stringify(styles(drawn)));
  await history('undo'); await state(x => JSON.stringify(styles(x)) === JSON.stringify(styles(drawn)));
  assert.equal(annotations(await inspect()).length, freeBefore + 1);
  await history('undo'); await state(x => annotations(x).length === freeBefore);
  assert.equal((await inspect()).study.mine.nodes.p1.version, 2);
  await history('undo'); await state(x => x.study.mine.nodes.p1.version === 1);
  assert.equal((await inspect()).study.mine.nodes.p1.researchUse, 'reference');
  for (let i = 0; i < 3; i++) await history('redo');
  await state(x => x.study.mine.nodes.p1.version === 2 && annotations(x).length === freeBefore + 1);
  pass('统一撤销：直接改写、绘图、样式按同一顺序恢复');

  await select('p1'); const beforeSource = await inspect();
  await s.objectAction('source');
  assert.match(await frame().locator('.source-popover .source-meta').first().innerText(), /我已编辑/);
  await frame().getByRole('button', { name: /查看原文并定位/ }).first().click();
  assert.match(await page.locator('#lab-reader').innerText(), /v1|版本 1|版本：1/);
  await page.locator('[data-lab="expand-reader"]').click(); await page.locator('[data-lab="reader-back"]').click();
  await state(x => x.study.selected === 'p1'); same(view(await inspect()), view(beforeSource));
  pass('来源回查：编辑后仍定位原材料版本，放大返回保留选择与视口');

  await select('j1'); const beforeFocus = await inspect();
  await frame().locator('[data-object-action="more"]').click();
  assert.equal(await frame().locator('[data-object-action="organize"]').count(), 0);
  await frame().locator('[data-object-action="focus"]').click(); await frame().locator('.focus-scope').waitFor();
  same((await inspect()).study.mine, beforeFocus.study.mine);
  await frame().locator('[data-object-action="return-view"]').click();
  await state(x => JSON.stringify(view(x)) === JSON.stringify(view(beforeFocus)));
  assert.equal((await inspect()).timeline.past.length, beforeFocus.timeline.past.length);
  pass('直接聚焦：范围清单入口已移除，相关推导聚焦可返回且不改研究内容');

  await select('p1'); await s.objectAction('ai');
  const beforeAI = await inspect();
  await page.locator('#lab-ai-question').fill('这个量产判断还需要核查什么条件？');
  await page.locator('[data-lab="ai-generate"]').click();
  await page.locator('[data-ai-answer]').waitFor();
  assert.equal(count((await inspect()).study.mine), count(beforeAI.study.mine));
  await page.locator('[data-lab="ai-accept"]').click();
  await state(x => count(x.study.mine) === count(beforeAI.study.mine) + 1);
  const afterAI = await inspect(), ai = Object.values(afterAI.study.mine.nodes).find(n => !beforeAI.study.mine.nodes[n.id]);
  assert.equal(ai.originKind, 'ai'); assert.equal(ai.researchUse, 'research'); assert.equal(ai.stance, '待研究');
  same(afterAI.study.mine.edges, beforeAI.study.mine.edges); assert.equal(afterAI.study.mine.nodes.q4.researchUse, 'reference');
  await endTask(); pass('AI：本地回答需显式添加，保留AI归属且不自动连线');

  await select('j1');
  assert.equal(await frame().locator('[data-object-action="structure"]').count(), 0);
  assert.equal(await page.locator('#lab-inspector-window').isVisible(), false);
  assert.equal(await frame().locator('[data-relation-highlight="j1"]').count(), 3);
  same((await frame().locator('[data-neighborhood-card]').evaluateAll(xs=>xs.map(x=>x.dataset.neighborhoodCard))).sort(), ['c1','p1','p2']);
  await screenshot('canvas-selected-relation');
  await page.locator('[data-lab="fit"]').click();
  await state(x => Boolean(view(x)));
  const beforeLink = await inspect(), currentView = view(beforeLink), frameBox = await page.locator('#lab-sdk-frame').boundingBox();
  const point = id => ({ x: frameBox.x + (beforeLink.study.mine.nodes[id].x + currentView.scrollX + 160) * currentView.zoom.value, y: frameBox.y + (beforeLink.study.mine.nodes[id].y + currentView.scrollY + 55) * currentView.zoom.value });
  const childPoint = point('c2'), parentPoint = point('p1');
  await page.mouse.move(childPoint.x, childPoint.y); await page.mouse.down();
  await page.mouse.move(parentPoint.x, parentPoint.y, { steps: 16 });
  await screenshot('parent-child-drag'); await page.mouse.up();
  await state(x => Object.keys(x.study.mine.edges).length === Object.keys(beforeLink.study.mine.edges).length + 1);
  const linked = await inspect(), newRelation = Object.values(linked.study.mine.edges).find(e => !beforeLink.study.mine.edges[e.id]);
  same(newRelation.premises, ['p1']); assert.equal(newRelation.conclusion, 'c2'); assert.equal(newRelation.originKind, 'user');
  assert.equal(newRelation.researchUse, 'research'); assert.equal(newRelation.stance, '待研究');
  for (const [id, edge] of Object.entries(beforeLink.study.mine.edges)) same(linked.study.mine.edges[id], edge);
  await endTask();
  assert.equal(linked.timeline.past.length, beforeLink.timeline.past.length + 1);
  await history('undo'); await state(x => !x.study.mine.edges[newRelation.id]);
  same((await inspect()).study.mine, beforeLink.study.mine);
  await history('redo'); await state(x => Boolean(x.study.mine.edges[newRelation.id]));
  same((await inspect()).study.mine, linked.study.mine);
  pass('画布拖放：选中推导直接高亮；子卡拖到父卡建立父→子，已有推导保留且一次撤销重做');

  let sharedEditor = await edit('p1');
  await sharedEditor.locator('textarea').fill('仅用于共同依赖推导的局部量产判断');
  const scope = sharedEditor.getByRole('combobox', { name: '本次修改范围' });
  assert.equal(await scope.inputValue(), ''); assert.equal(await sharedEditor.getByRole('button', { name: '保存改写', exact: true }).isDisabled(), true);
  const beforeLocal = await inspect(); await scope.selectOption('j1'); await screenshot('shared-scope');
  await sharedEditor.getByRole('button', { name: '保存改写', exact: true }).click();
  await state(x => Object.values(x.study.mine.nodes).some(n => n.localOf === 'p1'));
  current = await inspect(); const local = Object.values(current.study.mine.nodes).find(n => n.localOf === 'p1');
  assert.equal(local.localFor, 'j1'); assert.equal(local.researchUse, 'research');
  same(current.study.mine.nodes.p1, beforeLocal.study.mine.nodes.p1);
  assert.ok(current.study.mine.edges.j1.premises.includes(local.id)); assert.ok(!current.study.mine.edges.j1.premises.includes('p1'));
  same(current.study.mine.edges[newRelation.id], beforeLocal.study.mine.edges[newRelation.id]); same(current.study.baseline, baseline);
  await history('undo'); await state(x => !Object.values(x.study.mine.nodes).some(n => n.localOf === 'p1'));
  same((await inspect()).study.mine, beforeLocal.study.mine);
  await history('redo'); await state(x => Object.values(x.study.mine.nodes).some(n => n.localOf === 'p1'));
  await history('undo'); await state(x => !Object.values(x.study.mine.nodes).some(n => n.localOf === 'p1'));
  sharedEditor = await edit('p1'); await sharedEditor.locator('textarea').fill('明确更新全部引用的量产观察条件');
  await sharedEditor.getByRole('combobox', { name: '本次修改范围' }).selectOption('all');
  await sharedEditor.getByRole('button', { name: '保存改写', exact: true }).click();
  await state(x => x.study.mine.nodes.p1.text === '明确更新全部引用的量产观察条件');
  current = await inspect(); assert.ok(current.study.mine.edges.j1.premises.includes('p1')); assert.ok(current.study.mine.edges[newRelation.id].premises.includes('p1'));
  assert.equal(Object.values(current.study.mine.nodes).filter(n => n.localOf === 'p1').length, 0); same(current.study.baseline, baseline);
  pass('共享前提：缺省禁提交，局部只替换所选推导，all显式更新全部引用');

  await select('p2'); await s.objectAction('source');
  assert.match(await frame().locator('.source-popover .source-meta').first().innerText(), /参考内容/);
  await frame().locator('[data-object-action="correct"]').click();
  await page.locator('#lab-edit-text').fill('来源整理校正：18A 的良率会接近可比水平');
  await page.locator('[data-lab="correct-reconstruction"]').click();
  await state(x => x.study.mine.nodes.p2.correctionHistory?.length === 1);
  current = await inspect(); assert.equal(current.study.mine.nodes.p2.researchUse, 'reference'); assert.equal(current.study.mine.nodes.p2.edit, undefined);
  assert.equal(current.study.mine.nodes.p2.checked, '待核对'); same(current.study.baseline, baseline); same(current.study.author, original); same(current.study.sources, sources);
  await endTask(); await select('p2'); await s.objectAction('source');
  const correctionLabel = await frame().locator('.source-popover .source-meta').first().innerText(); assert.match(correctionLabel, /整理已校正/); assert.doesNotMatch(correctionLabel, /我已编辑/);
  await frame().getByRole('button', { name: '关闭来源', exact: true }).click();
  pass('来源校正：独立记录和标签，不冒充个人改写或认可');

  await researchTool(page,'[data-lab="open-reader"]'); await page.locator('#lab-paste-details summary').click();
  await page.locator('#lab-source-title').fill('D66 项目私有验收材料'); await page.locator('#lab-paste').fill('本机验收材料：不访问任何真实外部服务。');
  await page.locator('[data-lab="add-source"]').click(); await page.locator('[data-lab="reader-back"]').click();
  await saved(); const persistent = await inspect();
  await page.reload(); await ready(); current = await inspect();
  same(current.study.mine, persistent.study.mine); same(current.study.baseline, persistent.study.baseline); same(current.study.sources, persistent.study.sources);
  same(annotations(current), annotations(persistent)); same(styles(current), styles(persistent)); same(view(current), view(persistent));
  assert.equal(current.study.mine.nodes.p3.researchUse, 'reference'); assert.equal(current.study.mine.nodes.q4.researchUse, 'reference');
  await screenshot('restored'); pass('刷新恢复：直接研究内容、来源版本、状态、校正、批注和视口保留');

  const firstId = current.projectId; await page.locator('[data-lab="toggle-projects"]').click();await page.locator('[data-lab="new-project"]').click(); await state(x => x.projectId !== firstId);
  current = await inspect(); assert.equal(count(current.study.mine), 0); assert.equal(annotations(current).length, 0);
  assert.equal(current.study.sources.some(m => m.title === 'D66 项目私有验收材料'), false);
  if(!await page.locator('#lab-question-window').isVisible())await researchTool(page,'[data-lab="open-question"]');await page.locator('#lab-research-question').fill('D66 第二个独立研究'); await page.locator('#lab-research-question').press('Tab'); await saved();
  await page.locator('[data-lab="toggle-projects"]').click(); await page.locator(`[data-lab="switch-project"][data-project="${firstId}"]`).click(); await state(x => x.projectId === firstId);
  same((await inspect()).study.mine, persistent.study.mine); same(annotations(await inspect()), annotations(persistent)); pass('项目隔离：新研究独立，返回保留原研究与批注');

  await page.evaluate(() => { window.__failWorkspaceWrites = true; });
  if(!await page.locator('#lab-question-window').isVisible())await researchTool(page,'[data-lab="open-question"]');await page.locator('#lab-research-question').fill('D66 失败写入仍保留在页面'); await page.locator('#lab-research-question').press('Tab');
  await state(x => x.saveStatus.state === 'error'); assert.match(await page.locator('body').innerText(), /保存失败|未保存/);
  await page.evaluate(() => { window.__failWorkspaceWrites = false; });
  if(!await page.locator('#lab-question-window').isVisible())await researchTool(page,'[data-lab="open-question"]');await page.locator('#lab-research-question').fill('D66 已恢复保存'); await page.locator('#lab-research-question').press('Tab'); await saved();
  await page.reload(); await ready(); assert.equal((await inspect()).study.question, 'D66 已恢复保存');
  pass('保存失败：真实IndexedDB写入异常有反馈，后续保存可恢复');
  await verifyStances(s);
}
async function verifyStances(s) {
  const {page,inspect,state,saved,frame,ready,history,screenshot,select}=s;
  const panel=page.locator('#lab-inspector');
  const choice=value=>panel.locator(`[data-lab="stance-choice"][data-value="${value}"]`);
  const save=panel.locator('[data-lab="stance"]');
  const reason=panel.locator('#lab-stance-reason');
  const open=async id=>{await page.locator('[data-lab="fit"]').click();if((await inspect()).study.mine.edges[id]){await select(id);await frame().locator('[data-object-action="judgment"]').click();}else await frame().locator(`[data-stance-card="${id}"]`).click();await panel.locator('[data-lab="stance-choice"]').first().waitFor();};
  const tag=async(id,token)=>{
    await state(x=>(x.study.mine.nodes[id]||x.study.mine.edges[id]).stance===({pending:'待研究',accepted:'认可',questioned:'质疑',rejected:'不认可'})[token]);
    if((await inspect()).study.mine.edges[id]&&['pending','accepted'].includes(token))assert.equal(await frame().locator(`[data-stance-card="${id}"]`).count(),0,'简单连线隐藏常规立场');else assert.equal(await frame().locator(`[data-stance-card="${id}"]`).getAttribute('data-stance-token'),token);
  };
  const original=await inspect(),before=original.study.mine.nodes.p1,other=original.study.mine.nodes.p2,step=original.study.mine.edges.j1;
  await open('p1');await choice('质疑').click();
  same((await inspect()).study.mine.nodes.p1,before);assert.equal((await inspect()).timeline.past.length,original.timeline.past.length);
  assert.equal(await save.isDisabled(),true);await reason.fill('   ');assert.equal(await save.isDisabled(),true);
  await reason.fill('尚无正式披露确认这个量产时间');assert.equal(await save.isEnabled(),true);
  await choice('认可').click();assert.equal(await reason.inputValue(),'');assert.equal(await reason.isVisible(),false);
  await choice('质疑').click();assert.equal(await reason.inputValue(),'尚无正式披露确认这个量产时间');
  await saved();await page.reload();await ready();await open('p1');
  assert.equal(await choice('质疑').getAttribute('aria-pressed'),'true');assert.equal(await reason.inputValue(),'尚无正式披露确认这个量产时间');
  same((await inspect()).study.mine.nodes.p1,before);
  await save.click();await tag('p1','questioned');assert.equal(await page.locator('#lab-inspector-window').isHidden(),true);
  assert.equal((await inspect()).study.mine.nodes.p1.reason,'尚无正式披露确认这个量产时间');
  same((await inspect()).study.mine.nodes.p2,other);same((await inspect()).study.mine.edges.j1,step);
  same((await inspect()).study.baseline,original.study.baseline);same((await inspect()).study.sources,original.study.sources);
  await open('p1');assert.equal(await reason.inputValue(),'尚无正式披露确认这个量产时间');
  await reason.fill('资料口径还需要核对');await save.click();await open('p1');assert.equal(await reason.inputValue(),'资料口径还需要核对');
  await choice('不认可').click();assert.equal(await save.isDisabled(),true);
  await reason.fill('当前披露的时间与主张不符');await panel.locator('[data-lab="stance-cancel"]').click();
  await tag('p1','questioned');await open('p1');assert.equal(await choice('质疑').getAttribute('aria-pressed'),'true');assert.equal(await reason.inputValue(),'资料口径还需要核对');
  await choice('认可').click();assert.equal(await save.isEnabled(),true);await save.click();await tag('p1','accepted');
  await open('p1');await choice('不认可').click();await reason.fill('正式披露的量产时间更晚');await save.click();await tag('p1','rejected');
  await history('undo');await tag('p1','accepted');await history('redo');await tag('p1','rejected');
  await open('p1');await choice('待研究').click();assert.equal(await reason.count(),0);await save.click();await tag('p1','pending');assert.equal((await inspect()).study.mine.nodes.p1.reason,'');
  await open('j1');await choice('质疑').click();await reason.fill('仅凭量产与良率尚不能推出订单承诺');await save.click();await tag('j1','questioned');
  await tag('p1','pending');same((await inspect()).study.mine.nodes.p2,other);
  await saved();const persistent=await inspect();await page.reload();await ready();same((await inspect()).study.mine,persistent.study.mine);
  await open('j1');assert.equal(await reason.inputValue(),'仅凭量产与良率尚不能推出订单承诺');
  const colors=await panel.locator('.fw-stance-tag').evaluateAll(tags=>tags.map(t=>getComputedStyle(t).backgroundColor));assert.equal(new Set(colors).size,4);
  await screenshot('d69-stance');await panel.locator('[data-lab="stance-cancel"]').click();
  pass('立场标签：四态颜色、草稿不提交、理由按立场切换、显式保存与取消、独立对象、撤销重做和刷新恢复');
}
async function verifyReview(s) {
  const {page,inspect,state,saved,frame,ready,select,endTask,edit,screenshot}=s;
  await page.goto(entry);await ready();await page.locator('[data-lab="load-example"]').click();await page.locator('[data-lab="submit-opinion"]').click();
  await state(x=>Boolean(x.study.mine.nodes.c1?.verification));
  const panel=page.locator('#lab-inspector'),window=page.locator('#lab-inspector-window');
  const choice=value=>panel.locator(`[data-lab="stance-choice"][data-value="${value}"]`);
  const reason=panel.locator('#lab-stance-reason'),save=panel.locator('[data-lab="stance"]');
  const open=async(id,entry='judgment')=>{
    await endTask();await page.locator('[data-lab="fit"]').click();
    if(entry==='judgment'){await select(id);await frame().locator('[data-object-action="judgment"]').click();}
    else await frame().locator(`[data-${entry==='stance'?'stance':'check'}-card="${id}"]`).click();
    await panel.locator('.fw-review-layout').waitFor();
    assert.equal(await page.locator('#lab-inspector-title').innerText(),'查证与立场');
  };
  const initial=await inspect();
  await open('c1');
  assert.equal(await frame().locator('[data-object-action="stance"],[data-object-action="results"]').count(),0);
  assert.equal(await panel.locator('[data-review-detail="basis-0"]').evaluate(el=>el.open),true);
  const left=await panel.locator('.fw-review-evidence').boundingBox(),right=await panel.locator('.fw-review-stance').boundingBox();
  assert.ok(left.x+left.width<=right.x,'桌面两区并列');
  await choice('质疑').click();await reason.fill('还没有正式订单承诺，继续观察客户公告');
  same((await inspect()).study.mine.nodes.c1,initial.study.mine.nodes.c1,'草稿不改变个人判断');
  await panel.locator('[data-review-detail="basis-0"] [data-lab="anchor"]').click();
  await page.locator('#lab-reader-window:visible').waitFor();assert.equal(await window.isHidden(),true);
  assert.ok(await page.locator('#lab-reader .is-anchor mark').count(),'回查原句锚点');
  assert.equal(await page.locator('[data-lab="reader-back"]').innerText(),'返回查证与立场');
  await page.locator('[data-lab="reader-back"]').click();
  assert.equal(await panel.locator('[data-review-detail="basis-0"]').evaluate(el=>el.open),true);
  assert.equal(await reason.inputValue(),'还没有正式订单承诺，继续观察客户公告');
  assert.equal(await choice('质疑').getAttribute('aria-pressed'),'true');
  await open('p1','stance');assert.equal(await choice('待研究').getAttribute('aria-pressed'),'true');
  await open('c1','stance');assert.equal(await reason.inputValue(),'还没有正式订单承诺，继续观察客户公告');
  const beforeVerify=await inspect();
  await panel.locator('[data-lab="verify"]').click();await state(x=>x.study.mine.nodes.c1.verificationHistory?.length===1);
  assert.equal(await reason.inputValue(),'还没有正式订单承诺，继续观察客户公告');
  assert.equal(await choice('质疑').getAttribute('aria-pressed'),'true');
  assert.equal((await inspect()).study.mine.nodes.c1.stance,beforeVerify.study.mine.nodes.c1.stance);
  const firstBasis=panel.locator('[data-review-detail="basis-0"]');if(!await firstBasis.evaluate(el=>el.open))await firstBasis.locator('summary').click();
  await screenshot('d70-review');
  for(let i=0;i<2;i++)await panel.locator('[data-lab="verify"]').click();
  await panel.locator('.fw-review-evidence details').evaluateAll(details=>details.forEach(d=>d.open=true));
  const saveBefore=await save.boundingBox();
  const scroll=await panel.locator('.fw-review-evidence').evaluate(el=>{el.scrollTop=el.scrollHeight;return {top:el.scrollTop,height:el.clientHeight,scrollHeight:el.scrollHeight};});
  assert.ok(scroll.top>0,'长依据区域实际可滚动');
  same(await save.boundingBox(),saveBefore,'查看长依据时保存区保持位置');
  await screenshot('d70-review-scroll');
  const currentCheck=(await inspect()).study.mine.nodes.c1.verification;
  await save.click();await state(x=>x.study.mine.nodes.c1.stance==='质疑');
  const committed=await inspect();same(committed.study.mine.nodes.c1.verification,currentCheck,'保存立场不修改查证');
  same(committed.study.mine.nodes.c1.evidence,initial.study.mine.nodes.c1.evidence,'保存立场不自动采用依据');
  same(committed.study.mine.nodes.p1,initial.study.mine.nodes.p1);same(committed.study.baseline,initial.study.baseline);same(committed.study.sources,initial.study.sources);
  const editor=await edit('c1');await editor.locator('textarea').fill('D70 改写：外部订单仍需等待正式公告');await editor.getByRole('button',{name:'保存改写',exact:true}).click();
  await state(x=>x.study.mine.nodes.c1.version===2);await open('c1','results');
  assert.match(await panel.locator('.fw-review-evidence').innerText(),/当前版本需重新查证/);
  assert.equal(await panel.locator('[data-review-detail="stale"]').evaluate(el=>el.open),false);
  await choice('质疑').click();await reason.fill('改写后仍需确认正式订单');await panel.locator('[data-lab="verify"]').click();
  assert.equal(await reason.inputValue(),'改写后仍需确认正式订单');assert.equal((await inspect()).study.mine.nodes.c1.verification.targetVersion,2);
  await saved();await page.reload();await ready();await open('c1','results');
  assert.equal(await reason.inputValue(),'改写后仍需确认正式订单');
  await panel.locator('[data-lab="stance-cancel"]').click();await open('c1','stance');
  assert.equal(await choice('待研究').getAttribute('aria-pressed'),'true');assert.equal(await reason.count(),0);await endTask();
  await frame().locator('.new-claim').click();const create=frame().getByRole('dialog',{name:'写下主张'});
  await create.locator('textarea').fill('D70 尚未查证的个人主张');await create.getByRole('button',{name:'放到画布',exact:true}).click();
  await state(x=>Object.values(x.study.mine.nodes).some(n=>n.text==='D70 尚未查证的个人主张'));
  const newId=(await inspect()).study.selected;await open(newId);
  assert.match(await panel.locator('.fw-review-evidence').innerText(),/尚未查证/);
  await choice('认可').click();await save.click();await state(x=>x.study.mine.nodes[newId].stance==='认可');
  assert.equal((await inspect()).study.mine.nodes[newId].verification,undefined,'无查证也可保存个人立场');
  await open('c1');await page.setViewportSize({width:820,height:900});
  await s.until(async()=>{const left=await panel.locator('.fw-review-evidence').boundingBox(),right=await panel.locator('.fw-review-stance').boundingBox();return left&&right&&right.y>=left.y+left.height},'窄窗上下排列');
  const narrowLeft=await panel.locator('.fw-review-evidence').boundingBox(),narrowRight=await panel.locator('.fw-review-stance').boundingBox();
  assert.ok(narrowRight.y>=narrowLeft.y+narrowLeft.height,'窄窗上下排列');
  await choice('质疑').click();await reason.fill('窄窗口中的未保存草稿');await save.scrollIntoViewIfNeeded();
  assert.ok(await save.isVisible());await screenshot('d70-review-narrow');
  await page.setViewportSize({width:390,height:844});await save.scrollIntoViewIfNeeded();
  assert.ok(await save.isVisible());
  const bounds=await window.boundingBox();assert.ok(bounds.x>=0&&bounds.x+bounds.width<=391,'390宽度无横向越界');
  await screenshot('d70-review-390');await panel.locator('[data-lab="stance-cancel"]').click();
  pass('查证与立场：统一入口与跨入口草稿、原文回查、重查不覆盖、明确保存、旧结果版本、无查证判断、对象隔离、刷新恢复及窄窗布局');
}
async function verifyStanceHistory(s) {
  const {page,inspect,state,saved,frame,ready,history,endTask,edit,screenshot,select}=s;
  await page.goto(entry);await ready();await page.locator('[data-lab="load-example"]').click();await page.locator('[data-lab="submit-opinion"]').click();
  await state(x=>Boolean(x.study.mine.nodes.c1));
  const panel=page.locator('#lab-inspector'),fold=panel.locator('[data-review-detail="stance-history"]');
  const choice=value=>panel.locator(`[data-lab="stance-choice"][data-value="${value}"]`),reason=panel.locator('#lab-stance-reason'),save=panel.locator('[data-lab="stance"]');
  const open=async id=>{await endTask();await page.locator('[data-lab="fit"]').click();if((await inspect()).study.mine.edges[id]){await select(id);await frame().locator('[data-object-action="judgment"]').click();}else await frame().locator(`[data-stance-card="${id}"]`).click();await fold.waitFor();};
  const initial=await inspect(),before=clone(initial.study.mine.nodes.c1);
  await open('c1');assert.equal(await fold.evaluate(el=>el.open),false);
  for(const [value,text] of [['质疑','尚无正式订单承诺'],['质疑','合作意向仍需区分正式订单'],['不认可','模拟披露与当前表述不一致']]){
    await choice(value).click();await reason.fill(text);await save.click();await open('c1');
  }
  let current=await inspect(),records=clone(current.study.mine.nodes.c1.stanceHistory);
  assert.equal(records.length,3);same(current.study.mine.nodes.p1,initial.study.mine.nodes.p1);same(current.study.mine.edges.j1,initial.study.mine.edges.j1);
  same(current.study.mine.nodes.c1.verification,before.verification);same(current.study.mine.nodes.c1.evidence,before.evidence);same(current.study.baseline,initial.study.baseline);same(current.study.sources,initial.study.sources);
  assert.equal(await frame().locator('[data-stance-card="c1"]').innerText(),'不认可');
  assert.equal(await fold.evaluate(el=>el.open),false);await fold.locator(':scope > summary').click();
  assert.equal(await fold.locator('.fw-stance-history-row:visible').count(),1);
  assert.match(await fold.innerText(),/合作意向仍需区分正式订单/);assert.match(await fold.innerText(),/模拟披露与当前表述不一致/);
  const earlier=fold.locator('[data-review-detail="stance-earlier"]');assert.equal(await earlier.evaluate(el=>el.open),false);await earlier.locator(':scope > summary').click();
  assert.equal(await fold.locator('.fw-stance-history-row:visible').count(),3);assert.match(await earlier.innerText(),/立场未变，理由已更新/);
  await screenshot('d71-stance-history');
  await page.setViewportSize({width:390,height:900});await save.scrollIntoViewIfNeeded();
  assert.ok(await panel.evaluate(el=>el.scrollWidth<=el.clientWidth+1),'窄窗历史无横向溢出');assert.equal(await save.isVisible(),true);
  await screenshot('d71-stance-history-390');await page.setViewportSize({width:1440,height:1000});
  const unchanged=await inspect();await save.click();current=await inspect();same(current.study.mine.nodes.c1,unchanged.study.mine.nodes.c1);same(current.timeline,unchanged.timeline);same(current.study.log,unchanged.study.log);
  await history('undo');await state(x=>x.study.mine.nodes.c1.stanceHistory.length===2);await history('redo');await state(x=>x.study.mine.nodes.c1.stanceHistory.length===3);
  const editor=await edit('c1');await editor.locator('textarea').fill('D71 当前新表述：订单仍需确认');await editor.getByRole('button',{name:'保存改写',exact:true}).click();
  await state(x=>x.study.mine.nodes.c1.version===2);same((await inspect()).study.mine.nodes.c1.stanceHistory,records);
  await open('c1');if(!await fold.evaluate(el=>el.open))await fold.locator(':scope > summary').click();
  const target=fold.locator('.fw-stance-history-row').first().locator('.fw-stance-history-target');await target.locator('summary').click();
  assert.match(await target.innerText(),/当前内容已变化/);assert.ok((await target.innerText()).includes(before.text));assert.ok(!(await target.innerText()).includes('D71 当前新表述'));
  await panel.locator('[data-lab="verify"]').click();same((await inspect()).study.mine.nodes.c1.stanceHistory,records);
  await open('j1');await choice('质疑').click();await reason.fill('模拟：整步推导还需要订单条件');await save.click();await open('j1');
  await fold.locator(':scope > summary').click();await fold.locator('.fw-stance-history-target > summary').click();
  assert.match(await fold.innerText(),/前提：/);assert.match(await fold.innerText(),/结论：/);assert.match(await fold.innerText(),/共同依赖/);
  await saved();const persistent=await inspect();await page.reload();await ready();same((await inspect()).study.mine,persistent.study.mine);
  await open('c1');await choice('质疑').click();await reason.fill('这句尚未保存');same((await inspect()).study.mine.nodes.c1.stanceHistory,records);await panel.locator('[data-lab="stance-cancel"]').click();
  await page.locator('#fw-save-status').click();const downloadEvent=page.waitForEvent('download');await page.locator('[data-lab="export-workspace"]').click();const download=await downloadEvent;
  const payload=JSON.parse(fs.readFileSync(await download.path(),'utf8')),oldId=(await inspect()).projectId;
  await page.locator('#fw-import-workspace').setInputFiles({name:'d71-roundtrip.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(payload))});
  await state(x=>x.projectId!==oldId);same((await inspect()).study.mine,persistent.study.mine);await saved();
  const projectCount=(await inspect()).projects.length;
  const invalid=clone(payload);invalid.projects[0][1].study.mine.nodes.c1.stanceHistory=[{}];
  await page.locator('#fw-save-status').click();await page.locator('#fw-import-workspace').setInputFiles({name:'d71-invalid.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(invalid))});
  await page.getByText(/副本未能恢复：立场变化记录不完整/).waitFor();assert.equal((await inspect()).projects.length,projectCount);
  const legacy=clone(payload);for(const [,p] of legacy.projects){for(const graph of [p.study.author,p.study.mine,p.study.baseline].filter(Boolean))for(const n of [...Object.values(graph.nodes),...Object.values(graph.edges)])delete n.stanceHistory;for(const e of [...p.timeline.past,...p.timeline.future])for(const snap of [e.before,e.after])for(const graph of [snap.study.author,snap.study.mine,snap.study.baseline].filter(Boolean))for(const n of [...Object.values(graph.nodes),...Object.values(graph.edges)])delete n.stanceHistory;}
  const importedId=(await inspect()).projectId;await page.locator('#fw-import-workspace').setInputFiles({name:'d71-legacy.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(legacy))});
  await state(x=>x.projectId!==importedId);await open('j1');assert.equal((await inspect()).study.mine.edges.j1.stance,'质疑');assert.equal((await inspect()).study.mine.edges.j1.reason,'模拟：整步推导还需要订单条件');
  await fold.locator(':scope > summary').click();assert.match(await fold.innerText(),/尚无已记录的立场变化/);assert.equal(await fold.locator('.fw-stance-history-row').count(),0);
  pass('立场变化：按对象折叠、真实变更与无变化保存、前后理由、当时内容及推导端点、重查隔离、撤销重做、刷新、导入导出与旧存档兼容');
}
async function verifyMigration(s) {
  const { page, inspect, ready, state, saved, history } = s, fixture = legacyWorkspace();
  await page.goto(`${origin}/__forkwise_prototype_health`);
  await page.addScriptTag({ url: `${origin}/workspace-storage.js` });
  await page.evaluate(async payload => { const store = window.ForkwiseWorkspaceStorage.open(); await store.load(); await store.save(payload); store.close(); }, fixture.payload);
  await page.goto(entry); await ready();
  let current = await inspect(); assert.equal(current.projectId, 'project-2'); assert.equal(current.study.mode, 'mine'); assert.equal(current.study.directCanvas, true);
  same(Object.keys(current.study.mine.nodes).sort(), ['c1', 'p1', 'p2']); same(Object.keys(current.study.mine.edges), ['j1']);
  assert.equal(current.study.mine.nodes.p1.text, fixture.partial.mine.nodes.p1.text);
  for (const n of [...Object.values(current.study.mine.nodes), ...Object.values(current.study.mine.edges)]) assert.equal(n.researchUse, 'research');
  same(current.study.author, fixture.partial.author); same(current.study.baseline, fixture.partial.baseline);
  for (const step of [...current.timeline.past, ...current.timeline.future]) for (const snapshot of [step.before, step.after]) { assert.equal(snapshot.study.mode, 'mine'); assert.equal(snapshot.study.directCanvas, true); }
  await history('undo'); await state(x => x.study.mine.nodes.p1.version === 1); same(Object.keys((await inspect()).study.mine.nodes).sort(), ['c1', 'p1', 'p2']);
  await history('redo'); await state(x => x.study.mine.nodes.p1.version === 2);
  same((await inspect()).study.baseline, fixture.partial.baseline);
  pass('D65迁移：部分个人范围、已有改写、原版与历史保持，不补入遗漏候选');

  await page.locator('[data-lab="toggle-projects"]').click(); await page.locator('[data-lab="switch-project"][data-project="project-1"]').click(); await state(x => x.projectId === 'project-1');
  current = await inspect(); assert.equal(current.study.directCanvas, true); assert.equal(current.study.mode, 'mine');
  same(Object.keys(current.study.mine.nodes).sort(), Object.keys(fixture.author.author.nodes).sort());
  for (const n of [...Object.values(current.study.mine.nodes), ...Object.values(current.study.mine.edges)]) assert.equal(n.researchUse, 'reference');
  same(current.study.author, fixture.author.author); assert.ok(current.study.baseline);
  assert.equal(current.canvasState.scenes.mine.view.scrollX, 42); assert.equal(current.canvasState.scenes.mine.view.scrollY, 26);
  assert.equal(current.canvasState.scenes.mine.styles['forkwise:project-1:mine:card:p1'].strokeWidth, 4);
  await history('undo'); await state(x => count(x.study.mine) === 0); assert.equal((await inspect()).study.mode, 'mine');
  await history('redo'); await state(x => count(x.study.mine) === count(fixture.author.author));
  assert.equal((await inspect()).study.mine.nodes.p1.researchUse, 'reference');
  await saved(); const priorReload = await inspect(); await page.reload(); await ready();
  same((await inspect()).study.mine, priorReload.study.mine); same((await inspect()).study.baseline, priorReload.study.baseline);
  pass('D65迁移：author-only变可编辑参考，旧视口样式及撤销重做均迁移');
}
async function verifyCanvasActions(s) {
  const {page,inspect,state,saved,frame,ready,select,history,endTask,edit,screenshot}=s;
  await page.goto(entry);await ready();
  await page.locator('[data-lab="load-example"]').click();
  await page.locator('[data-lab="submit-opinion"]').click();
  await state(x=>Boolean(x.study.mine.edges.j1));
  await page.locator('[data-lab="fit"]').click();
  const before=await inspect();
  const highlights=async()=>[...new Set(await frame().locator('[data-relation-highlight]').evaluateAll(xs=>xs.map(x=>x.dataset.relationHighlight)))].sort();
  await select('c1');same(await highlights(),['j1','s2','s3']);
  assert.equal(await frame().locator('[data-neighborhood-card="q4"]').count(),0);
  await select('j1');same(await highlights(),['j1']);
  same((await frame().locator('[data-neighborhood-card]').evaluateAll(xs=>xs.map(x=>x.dataset.neighborhoodCard))).sort(),['c1','p1','p2']);
  const afterSelect=await inspect();same(afterSelect.study.mine,before.study.mine);
  same(afterSelect.study.author,before.study.author);same(afterSelect.study.baseline,before.study.baseline);
  same(afterSelect.study.sources,before.study.sources);same(afterSelect.study.log,before.study.log);
  assert.equal(afterSelect.timeline.past.length,before.timeline.past.length);
  const beforeView=view(before),afterView=view(afterSelect);
  assert.equal(afterView.scrollX,beforeView.scrollX);assert.equal(afterView.scrollY,beforeView.scrollY);same(afterView.zoom,beforeView.zoom);
  assert.equal(await frame().locator('[data-object-action="structure"]').count(),0);
  assert.equal(await page.locator('#lab-inspector-window').isVisible(),false);
  await frame().locator('[data-object-action="more"]').click();
  assert.equal(await frame().locator('[data-object-action="preview"]').count(),0);
  await frame().locator('[data-object-action="question"]').click();
  await page.locator('#lab-question').waitFor();
  await page.locator('#lab-question').fill('这一步还需要哪项交付证据？');
  await page.locator('[data-lab="question"]').click();
  await state(x=>x.study.mine.edges.j1.notes.length===1);await endTask();
  const editor=await edit('j1');
  await editor.locator('textarea').fill('两项条件齐备才有接单基础，订单承诺仍待观察');
  await editor.getByRole('button',{name:'保存改写',exact:true}).click();
  await state(x=>x.study.mine.edges.j1.version===2);
  await select('j1');await frame().locator('[data-object-action="more"]').click();
  await frame().locator('[data-object-action="history"]').click();
  await page.locator('.fw-edit-history').waitFor();
  assert.match(await page.locator('.fw-edit-history').innerText(),/两项条件齐备才有接单基础/);await endTask();
  await select('p1');await frame().locator('[data-object-action="more"]').click();
  await frame().locator('[data-object-action="preview"]').click();
  const beforePreview=await inspect();
  await page.locator('[data-lab="preview"]').click();await state(x=>x.study.preview==='p1');await endTask();
  const afterPreview=await inspect();same(afterPreview.study.mine,beforePreview.study.mine);
  same(afterPreview.study.author,beforePreview.study.author);same(afterPreview.study.sources,beforePreview.study.sources);
  assert.equal(afterPreview.timeline.past.length,beforePreview.timeline.past.length);
  await screenshot('canvas-hypothesis');
  await page.locator('[data-lab="exit-preview"]').click();await state(x=>!x.study.preview);
  await select('j1');const beforeDelete=await inspect();
  await frame().locator('[data-object-action="more"]').click();
  assert.equal(await frame().locator('[data-object-action="delete"]').innerText(),'删除这步推导');
  await frame().locator('[data-object-action="delete"]').click();await state(x=>!x.study.mine.edges.j1);
  const deleted=await inspect();same(deleted.study.mine.nodes,beforeDelete.study.mine.nodes);
  same(deleted.study.mine.edges.s2,beforeDelete.study.mine.edges.s2);same(deleted.study.mine.edges.s3,beforeDelete.study.mine.edges.s3);
  assert.equal(deleted.timeline.past.length,beforeDelete.timeline.past.length+1);
  await history('undo');await state(x=>Boolean(x.study.mine.edges.j1));same((await inspect()).study.mine,beforeDelete.study.mine);
  await history('redo');await state(x=>!x.study.mine.edges.j1);same((await inspect()).study.mine,deleted.study.mine);
  await history('undo');await state(x=>Boolean(x.study.mine.edges.j1));
  await saved();const beforeReload=await inspect();await page.reload();await ready();same((await inspect()).study.mine,beforeReload.study.mine);
  await select('j1');await screenshot('canvas-relations');
  for(const width of [820,390]){
    await page.setViewportSize({width,height:900});
    if(await page.locator('[data-lab="fit"]').isVisible())await page.locator('[data-lab="fit"]').click();
    await select('p1');
    await frame().locator('[data-object-action="more"]').click();
    const preview=frame().locator('[data-object-action="preview"]');assert.equal(await preview.isVisible(),true);
    const box=await preview.boundingBox(),host=await page.locator('#lab-sdk-frame').boundingBox();
    assert.ok(box.x>=host.x&&box.x+box.width<=host.x+host.width+1,'窄窗假设入口在可见画布内');
    await preview.click();await page.locator('[data-lab="preview"]').waitFor();await endTask();
  }
  pass('画布工具：一跳高亮只读、无关系窗口、理由改写与记录、待查、假设、删除联合推导及撤销恢复，820/390宽度入口可达');
}
async function verifyNavigation(s,fallback=false) {
  const {page,inspect,state,saved,ready}=s,fixture=legacyWorkspace();
  const question='这位作者关于 Intel 代工的核心判断依赖哪些前提，我认可哪些、质疑哪些？';
  for(const [,p] of fixture.payload.projects){p.study.question=question;p.composer.title='';delete p.name;}
  await page.goto(`${origin}/__forkwise_prototype_health`);
  await page.addScriptTag({url:`${origin}/workspace-storage.js`});
  await page.evaluate(async payload=>{const store=window.ForkwiseWorkspaceStorage.open();await store.load();await store.save(payload);store.close();},fixture.payload);
  await page.goto(entry);await ready();await saved();
  if(fallback)await page.locator('#lab-engine').evaluate(el=>{el.value='research';el.dispatchEvent(new Event('change'));});
  const prior=await inspect();assert.equal(prior.study.question,question);assert.ok(prior.projectName.length<=48);
  assert.equal(await page.locator('#fw-project-nav').isVisible(),false);
  await page.locator('[data-lab="toggle-projects"]').click();
  assert.equal(await page.locator('.fw-project').count(),2);
  assert.match(await page.locator('#fw-project-list').innerText(),/项目 1/);assert.match(await page.locator('#fw-project-list').innerText(),/项目 2/);
  const rename=async(id,name)=>{
    await page.locator(`[data-lab="switch-project"][data-project="${id}"]`).locator('..').locator('summary').click();
    await page.locator(`[data-lab="rename-project"][data-project="${id}"]`).click();await page.locator('#fw-rename-input').fill(name);
    await page.locator('#fw-rename-form button[type=submit]').click();await saved();
  };
  // Non-current rename does not activate or alter the target graph; metadata persists independently.
  await rename('project-1','Intel 资本开支');assert.equal((await inspect()).projectId,prior.projectId);
  same((await inspect()).study,prior.study);same((await inspect()).timeline,prior.timeline);same((await inspect()).canvasState,prior.canvasState);
  await page.locator('[data-lab="toggle-projects"]').click();
  if(!await page.locator('#lab-question-window').isVisible())await researchTool(page,'[data-lab="open-question"]');await page.locator('#fw-current-project-name').click();await page.locator('#fw-rename-input').fill('不应保存');await page.locator('#fw-rename-form [data-lab="close-summary"]').click();assert.equal((await inspect()).projectName,prior.projectName);
  if(!await page.locator('#lab-question-window').isVisible())await researchTool(page,'[data-lab="open-question"]');await page.locator('#fw-current-project-name').click();await page.locator('#fw-rename-input').fill('   ');await page.locator('#fw-rename-form button[type=submit]').click();assert.equal(await page.locator('#lab-dialog').evaluate(el=>el.open),true);
  await page.locator('#fw-rename-input').fill('Intel 代工');await page.locator('#fw-rename-input').press('Enter');await saved();assert.equal((await inspect()).projectName,'Intel 代工');same((await inspect()).study,prior.study);
  await page.locator('[data-lab="toggle-projects"]').click();
  await page.locator('#fw-project-search').fill('资本');assert.equal(await page.locator('.fw-project').count(),1);assert.equal(await page.locator('.fw-project').getAttribute('data-project'),'project-1');
  await page.locator('#fw-project-search').fill('我认可哪些');assert.equal(await page.locator('.fw-project').count(),2);
  await page.locator('#fw-project-search').fill('完全不存在的项目');assert.equal(await page.locator('.fw-project').count(),0);assert.match(await page.locator('.fw-project-empty').innerText(),/没有匹配/);
  await page.locator('#fw-project-search').fill('');await page.locator('[data-lab="pin-projects"]').click();await saved();
  await page.locator('[data-lab="switch-project"][data-project="project-1"]').click();await state(x=>x.projectId==='project-1');assert.equal((await inspect()).projectName,'Intel 资本开支');assert.equal(await page.locator('#fw-project-nav').isVisible(),true);
  if(!await page.locator('#lab-question-window').isVisible())await researchTool(page,'[data-lab="open-question"]');await page.locator('#lab-research-question').fill('测试：资本开支约束与回款条件');await page.locator('#lab-research-question').press('Tab');await saved();assert.equal((await inspect()).projectName,'Intel 资本开支');
  const changed=await inspect();await page.reload();await ready();assert.equal((await inspect()).projectName,changed.projectName);assert.equal((await inspect()).study.question,changed.study.question);same((await inspect()).study.mine,changed.study.mine);assert.equal(await page.locator('#fw-project-nav').isVisible(),true);
  await page.locator('#fw-save-status').click();const downloadEvent=page.waitForEvent('download');await page.locator('[data-lab="export-workspace"]').click();const download=await downloadEvent,payload=JSON.parse(fs.readFileSync(await download.path(),'utf8'));
  assert.equal(payload.projects.find(([id])=>id==='project-1')[1].name,'Intel 资本开支');
  await page.locator('#fw-import-workspace').setInputFiles({name:'d73-projects.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(payload))});await state(x=>x.projects.length===4);await saved();
  assert.match((await inspect()).projectName,/恢复副本/);assert.equal((await inspect()).study.question,payload.projects[0][1].study.question);
  same((await inspect()).study.mine,payload.projects[0][1].study.mine);
  await page.locator('#fw-save-status').click();const invalid=clone(payload);invalid.projects[0][1].name={bad:true};await page.locator('#fw-import-workspace').setInputFiles({name:'d73-invalid.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(invalid))});await page.getByText(/副本未能恢复：项目名称无效/).waitFor();assert.equal((await inspect()).projects.length,4);
  await page.locator('[data-lab="close-summary"]').click();await page.locator('[data-lab="close-projects"]').click();await saved();await page.reload();await ready();assert.equal(await page.locator('#fw-project-nav').isVisible(),false);
  for(const width of [1440,820,390]){
    await page.setViewportSize({width,height:900});await page.locator('[data-lab="toggle-projects"]').click();
    assert.equal(await page.locator('#fw-save-status').isVisible(),true);assert.equal(await page.locator('[data-lab="new-project"]').isVisible(),true);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    await page.locator('[data-lab="close-projects"]').click();
  }
  if(!fallback){await page.setViewportSize({width:1440,height:1000});await page.locator('[data-lab="toggle-projects"]').click();await page.locator('[data-lab="switch-project"][data-project="project-2"]').click();await state(x=>x.projectId==='project-2');await page.locator('[data-lab="toggle-projects"]').click();await page.locator('[data-lab="pin-projects"]').click();await saved();await page.screenshot({path:path.join(os.tmpdir(),'forkwise-d73-navigation.png')});}
  pass(`D73${fallback?' HTML兼容回退':' 完整画布'}：旧项目命名迁移、同名编号、当前/其他项目改名与取消、名称/问题独立、搜索、固定、切换、刷新、导入导出及窄窗口`);
}
async function verifyProjectDelete(s,fallback=false){
  const {page,inspect,state,saved,ready}=s,fixture=legacyWorkspace();
  for(const [,p] of fixture.payload.projects)p.name='同名研究';
  fixture.payload.aiThreads=[['project-1:discussion',{question:'第一项的讨论草稿',context:[]}],['project-2:discussion',{question:'第二项的讨论草稿',context:[]}]];
  await page.goto(`${origin}/__forkwise_prototype_health`);await page.addScriptTag({url:`${origin}/workspace-storage.js`});
  await page.evaluate(async payload=>{const store=window.ForkwiseWorkspaceStorage.open();await store.load();await store.save(payload);store.close();},fixture.payload);
  await page.goto(entry);await ready();await saved();
  if(fallback)await page.locator('#lab-engine').evaluate(el=>{el.value='research';el.dispatchEvent(new Event('change'));});
  const openNav=async()=>{if(!await page.locator('#fw-project-nav').isVisible())await page.locator('[data-lab="toggle-projects"]').click();};
  const ask=async id=>{await openNav();await page.locator(`[data-lab="switch-project"][data-project="${id}"]`).locator('..').locator('summary').click();await page.locator(`[data-lab="delete-project"][data-project="${id}"]`).click();};
  const exportData=async()=>{await page.locator('#fw-save-status').click();const event=page.waitForEvent('download');await page.locator('[data-lab="export-workspace"]').click();const download=await event,data=JSON.parse(fs.readFileSync(await download.path(),'utf8'));await page.locator('[data-lab="close-summary"]').click();return data;};
  const prior=await inspect();await ask('project-1');assert.match(await page.locator('#lab-dialog').innerText(),/同名研究/);assert.match(await page.locator('#lab-dialog').innerText(),/项目 1/);assert.equal(await page.locator('#lab-dialog').evaluate(el=>document.activeElement.textContent),'取消');
  await page.locator('#lab-dialog footer [data-lab="close-summary"]').click();same((await inspect()).study,prior.study);assert.equal((await inspect()).projects.length,2);
  await ask('project-1');await page.keyboard.press('Escape');assert.equal((await inspect()).projects.length,2);
  await page.setViewportSize({width:390,height:900});await ask('project-1');assert.equal(await page.locator('[data-lab="confirm-delete-project"]').isVisible(),true);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  await page.locator('#lab-dialog [data-lab="close-summary"]').first().click();
  await page.setViewportSize({width:1440,height:1000});await ask('project-1');await page.screenshot({path:path.join(os.tmpdir(),`forkwise-d74-delete-${fallback?'fallback':'native'}.png`)});
  await page.evaluate(()=>window.__failWorkspaceWrites=true);await page.locator('[data-lab="confirm-delete-project"]').click();await state(x=>x.projects.length===1&&x.saveStatus.state==='error');
  let after=await inspect();assert.equal(after.projectId,prior.projectId);same(after.study,prior.study);same(after.timeline,prior.timeline);same(after.canvasState,prior.canvasState);
  await page.evaluate(()=>window.__failWorkspaceWrites=false);await page.locator('#fw-save-status').click();await page.locator('[data-lab="retry-save"]').click();await saved();
  let data=await exportData();assert.deepEqual(data.projects.map(([id])=>id),['project-2']);assert.deepEqual(data.aiThreads.map(([key])=>key),['project-2:discussion']);
  await page.reload();await ready();assert.equal((await inspect()).projects.length,1);assert.equal((await inspect()).projectId,'project-2');same((await inspect()).study.mine,prior.study.mine);
  await openNav();await page.locator('[data-lab="new-project"]').click();await state(x=>x.projectId!=='project-2');const extra=(await inspect()).projectId;await saved();
  // Current project selects its previous neighbour; other-project graph, drafts and history survive.
  await ask(extra);await page.locator('[data-lab="confirm-delete-project"]').click();await state(x=>x.projectId==='project-2'&&x.projects.length===1);await saved();
  same((await inspect()).study.mine,prior.study.mine);same((await inspect()).timeline,prior.timeline);
  await ask('project-2');await page.locator('[data-lab="confirm-delete-project"]').click();await state(x=>x.projectId!=='project-2'&&x.projects.length===1);await saved();
  after=await inspect();assert.equal(after.projectName,'未命名研究');assert.equal(Object.keys(after.study.mine.nodes).length,0);assert.equal(after.timeline.past.length,0);assert.equal(await page.locator('#fw-input').isVisible(),true);
  data=await exportData();assert.deepEqual(data.aiThreads,[]);assert.equal(data.projects.length,1);assert.ok(!data.projects.some(([id])=>['project-1','project-2',extra].includes(id)));
  await page.reload();await ready();assert.equal((await inspect()).projectId,after.projectId);assert.equal((await inspect()).projects.length,1);assert.equal(Object.keys((await inspect()).study.mine.nodes).length,0);
  pass(`D74${fallback?' HTML兼容回退':' 完整画布'}：同名确认、取消/Escape、非当前/当前/最后项目删除、存储失败重试、保留其他内容历史、AI草稿清理及刷新/导出/窄窗`);
}
async function researchTool(page,selector){
  if(!await page.locator('#fw-research-tools-panel').isVisible())await page.locator('#fw-research-tools-toggle').click();
  await page.locator(selector).click();
}

async function run(browser, name, test) {
  const s = await session(browser);
  try { await test(s); same(s.external, [], '没有外部请求'); same(s.errors, [], '没有页面异常'); }
  catch (error) {
    const prefix = path.join(os.tmpdir(), `forkwise-d66-${name}-failure`);
    await s.page.screenshot({ path: `${prefix}.png`, fullPage: true }).catch(() => {});
    fs.writeFileSync(`${prefix}.json`, JSON.stringify({ error: String(error), state: await s.inspect().catch(() => null), errors: s.errors, external: s.external }, null, 2));
    console.error(`失败现场 ${prefix}.{png,json}`); throw error;
  } finally { await s.context.close(); }
}
(async () => {
  const browser = await playwright().chromium.launch({ headless: true });
  try {
    if(process.argv.includes('--object-ui-only')){await run(browser,'object-ui',verifyObjectUI);await run(browser,'object-ui-fallback',s=>verifyObjectUI(s,true));}
    else if(process.argv.includes('--selection-only'))await run(browser,'selection',verifySelection);
    else if(process.argv.includes('--project-delete-only')){await run(browser,'project-delete',verifyProjectDelete);await run(browser,'project-delete-fallback',s=>verifyProjectDelete(s,true));}
    else if(process.argv.includes('--navigation-only')){await run(browser,'navigation',verifyNavigation);await run(browser,'navigation-fallback',s=>verifyNavigation(s,true));}
    else if(process.argv.includes('--canvas-actions-only'))await run(browser,'canvas-actions',verifyCanvasActions);
    else if(process.argv.includes('--stance-history-only'))await run(browser,'stance-history',verifyStanceHistory);
    else if(process.argv.includes('--review-only'))await run(browser,'review',verifyReview);
    else{
      if (!process.argv.includes('--migration-only')) {await run(browser, 'ui', verifyUI);await run(browser,'review',verifyReview);await run(browser,'stance-history',verifyStanceHistory);await run(browser,'canvas-actions',verifyCanvasActions);await run(browser,'navigation',verifyNavigation);await run(browser,'navigation-fallback',s=>verifyNavigation(s,true));await run(browser,'project-delete',verifyProjectDelete);await run(browser,'project-delete-fallback',s=>verifyProjectDelete(s,true));}
      if (!process.argv.includes('--ui-only')) await run(browser, 'migration', verifyMigration);
    }
    console.log(`\n${passed.length} 组直接画布浏览器检查通过；无外部请求或真实AI调用。`);
  } finally { await browser.close(); }
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
