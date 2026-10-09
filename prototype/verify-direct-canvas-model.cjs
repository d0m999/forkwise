#!/usr/bin/env node
// Run with Node.js. No browser, network, or user workspace storage is touched.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const html = fs.readFileSync(path.join(__dirname, 'forkwise-step-prototype.html'), 'utf8');
const source = html.match(/<script id="open-research-model">([\s\S]*?)<\/script>/)?.[1];
assert.ok(source, 'Research model script exists');
const context = vm.createContext({ URL });
vm.runInContext(source + '\nglobalThis.model = OpenStudy;', context);
const M = context.model;
const copy = x => JSON.parse(JSON.stringify(x));
const same = (a, b) => assert.deepEqual(copy(a), copy(b));
const act = (state, action) => {
  const next = M.reduce(state, action);
  assert.equal(next.error, '', `${action.type}: ${next.error}`);
  return next;
};
const fresh = () => act(M.seed(), { type: 'reconstruct' });
const selected = (state, id) => act(state, { type: 'select', id });
let count = 0;
function test(name, run) {
  run(); count += 1; process.stdout.write(`PASS ${name}\n`);
}

test('重建直接进入工作图，显示来源/AI候选不表示采用', () => {
  const original = M.seed(), state = fresh();
  assert.equal(state.mode, 'mine');
  assert.equal(state.directCanvas, true);
  same(state.sources, original.sources);
  assert.notEqual(state.mine, state.author);
  for (const item of [...Object.values(state.mine.nodes), ...Object.values(state.mine.edges)]) {
    assert.equal(M.researchUse(item), 'reference');
    assert.equal(item.stance, '待研究');
    assert.equal(item.checked, '待核对');
    assert.equal(M.isEdited(item), false);
    assert.equal(item.base.id, item.id);
  }
  assert.equal(state.mine.nodes.q4.originKind, 'ai');
  assert.equal(state.mine.edges.j1.premises.includes('q4'), false);
  state.mine.nodes.p1.text = '本地变化';
  assert.notEqual(state.author.nodes.p1.text, '本地变化');
  assert.notEqual(state.baseline.nodes.p1.text, '本地变化');
});

test('无需收录直接改写，起点、原材料及初始对照保留', () => {
  let state = fresh();
  const author = copy(state.author), baseline = copy(state.baseline), sources = copy(state.sources);
  state = act(selected(state, 'p1'), { type: 'edit', text: '2026 年内进入量产，仍需公司披露', reason: '增加时间边界' });
  assert.equal(M.researchUse(state.mine.nodes.p1), 'research');
  assert.equal(state.mine.nodes.p1.originKind, 'source');
  assert.equal(M.isEdited(state.mine.nodes.p1), true);
  assert.equal(state.mine.nodes.p1.version, 2);
  assert.equal(state.mine.edges.j1.needsReview, true);
  assert.equal(M.researchUse(state.mine.edges.j1), 'reference');
  same(state.author, author); same(state.baseline, baseline); same(state.sources, sources);
  state = act(selected(state, 'q4'), { type: 'edit', text: '至少一个客户已完成产能认证', reason: '' });
  assert.equal(state.mine.nodes.q4.originKind, 'ai');
  assert.equal(M.researchUse(state.mine.nodes.q4), 'research');
});

test('位移、浏览、核对与查证不变成个人采用，笔记和立场才记录研究', () => {
  let state = selected(fresh(), 'p1');
  state = act(state, { type: 'move', id: 'p1', x: 55, y: 75 });
  state = act(state, { type: 'checked' });
  state = act(state, { type: 'verify', id: 'p1' });
  assert.equal(M.researchUse(state.mine.nodes.p1), 'reference');
  assert.equal(M.isEdited(state.mine.nodes.p1), false);
  state = act(state, { type: 'question', text: '是否已有量产正式披露？' });
  assert.equal(M.researchUse(state.mine.nodes.p1), 'research');
  assert.equal(state.mine.nodes.p1.stance, '待研究');
  state = act(selected(state, 'p2'), { type: 'stance', value: '质疑', reason: '没有良率口径' });
  assert.equal(M.researchUse(state.mine.nodes.p2), 'research');
  assert.equal(M.isEdited(state.mine.nodes.p2), false);
  state = selected(state, 'p3');
  const material = state.sources[0], end = material.text.indexOf('\n');
  state = act(state, { type: 'quote', source: 'm1', start: 0, end });
  state = act(state, { type: 'evidence', effect: '背景', reason: '记录相关材料' });
  assert.equal(M.researchUse(state.mine.nodes.p3), 'research');
});

test('本人新建与显式加入AI候选，保留独立起点', () => {
  let state = fresh();
  state = act(state, { type: 'canvas-create', text: '外部客户合同需要另查', x: 20, y: 50 });
  assert.equal(state.mine.nodes[state.selected].originKind, 'user');
  assert.equal(M.researchUse(state.mine.nodes[state.selected]), 'research');
  const reference = { id: 'j1', signature: M.signature(state.mine, state.mine.edges.j1) };
  state = act(state, { type: 'ai-add-candidate', text: '客户是否有替代供应商？', context: [reference] });
  assert.equal(state.mine.nodes[state.selected].originKind, 'ai');
  assert.equal(state.mine.nodes[state.selected].stance, '待研究');
  assert.equal(M.researchUse(state.mine.nodes[state.selected]), 'research');
  assert.equal(state.mine.edges.j1.premises.includes(state.selected), false);
  const rejected = M.reduce(state, { type: 'ai-add-candidate', text: '旧讨论', context: [{ id: 'j1', signature: 'stale' }] });
  assert.ok(rejected.error); same(rejected.mine, state.mine);
});

test('旧作者-only存档转参考工作图，已有个人图不扩张或覆盖', () => {
  const oldAuthor = fresh(); delete oldAuthor.directCanvas; oldAuthor.mine = null; oldAuthor.baseline = null; oldAuthor.mode = 'author';
  const immutable = copy(oldAuthor), upgraded = M.upgradeStudy(oldAuthor);
  same(oldAuthor, immutable); assert.equal(upgraded.mode, 'mine');
  assert.equal(M.researchUse(upgraded.mine.nodes.p1), 'reference');
  same(upgraded.author, oldAuthor.author); same(upgraded.sources, oldAuthor.sources);
  same(M.upgradeStudy(upgraded), upgraded);
  const oldPartial = fresh(); delete oldPartial.directCanvas; oldPartial.mode = 'author';
  oldPartial.mine = { nodes: { p1: copy(oldPartial.mine.nodes.p1) }, edges: {} };
  delete oldPartial.mine.nodes.p1.researchUse; oldPartial.mine.nodes.p1.text = '保留我的改写'; oldPartial.mine.nodes.p1.stance = '质疑';
  oldPartial.baseline = { nodes: { p1: copy(oldPartial.baseline.nodes.p1) }, edges: {} };
  const prior = copy(oldPartial), result = M.upgradeStudy(oldPartial);
  same(Object.keys(result.mine.nodes), ['p1']); same(result.mine.edges, {});
  assert.equal(result.mine.nodes.p1.text, '保留我的改写'); assert.equal(result.mine.nodes.p1.stance, '质疑');
  assert.equal(M.researchUse(result.mine.nodes.p1), 'research');
  same(result.baseline, prior.baseline); same(result.author, prior.author); same(oldPartial, prior);
  const deleted = copy(oldPartial); deleted.mine = { nodes: {}, edges: {} };
  same(M.upgradeStudy(deleted).mine, { nodes: {}, edges: {} });
});

function withSharedPremise() {
  let state = fresh();
  state = act(state, { type: 'drop-connect', parent: 'p1', child: 'c2' });
  return selected(state, 'p1');
}
test('共享前提必须明确范围，局部版本只改指定关系且可一次撤销', () => {
  let state = withSharedPremise();
  assert.equal(M.sharedPremises(state, 'p1').length, 2);
  const original = copy(state), extra = Object.values(state.mine.edges).find(e => e.id !== 'j1' && e.premises.includes('p1'));
  const missing = M.reduce(state, { type: 'edit', text: '仅这条推导采用较晚量产时间', reason: '' });
  assert.match(missing.error, /选择/); same(missing.mine, original.mine); same(missing.undo, original.undo);
  const bad = M.reduce(state, { type: 'edit', text: '不应写入', scope: 's2', reason: '' });
  assert.ok(bad.error); same(bad.mine, original.mine);
  state = act(state, { type: 'edit', text: '仅这条推导采用较晚量产时间', scope: 'j1', reason: '局部分支' });
  const local = state.mine.nodes[state.selected];
  assert.notEqual(local.id, 'p1'); assert.equal(local.localOf, 'p1'); assert.equal(local.localFor, 'j1');
  assert.equal(local.originKind, 'source'); same(local.sourceRef, original.mine.nodes.p1.sourceRef);
  same(state.mine.nodes.p1, original.mine.nodes.p1);
  same(state.mine.edges[extra.id], original.mine.edges[extra.id]);
  assert.equal(state.mine.edges.j1.premises.includes(local.id), true);
  assert.equal(state.mine.edges.j1.premises.includes('p1'), false);
  assert.equal(state.mine.edges.j1.version, original.mine.edges.j1.version + 1);
  assert.equal(state.undo.length, original.undo.length + 1);
  same(state.baseline, original.baseline); same(state.author, original.author);
  state = act(state, { type: 'undo' }); same(state.mine, original.mine);
});

test('明确更新所有引用保持共享身份，旧查证仍对应旧签名', () => {
  let state = act(withSharedPremise(), { type: 'verify' }); state = selected(state, 'p1');
  const prior = copy(state), ids = M.sharedPremises(state, 'p1').map(e => e.id);
  state = act(state, { type: 'edit', text: '所有引用采用新的量产条件', scope: 'all', reason: '' });
  assert.equal(state.selected, 'p1'); same(Object.keys(state.mine.nodes), Object.keys(prior.mine.nodes));
  for (const id of ids) { assert.equal(state.mine.edges[id].premises.includes('p1'), true); assert.equal(state.mine.edges[id].needsReview, true); }
  assert.equal(state.mine.nodes.p1.verification.targetVersion, 1);
  assert.notEqual(state.mine.nodes.p1.verification.signature, M.signature(state.mine, state.mine.nodes.p1));
});

test('来源整理校正有独立记录，不标个人改写或改动原版', () => {
  let state = act(selected(fresh(), 'p1'), { type: 'verify', id: 'p1' });
  const prior = copy(state);
  assert.equal(M.canCorrect(state.mine.nodes.p1), true);
  state = act(state, { type: 'correct-reconstruction', text: '18A 将在 2026 上半年按期进入量产', reason: '补回原句时间', at: '2026-10-04T10:00:00Z' });
  const item = state.mine.nodes.p1;
  assert.equal(item.version, 2); assert.equal(M.isEdited(item), false); assert.equal(M.researchUse(item), 'reference');
  assert.equal(item.correctionHistory.length, 1); assert.equal(item.correctionHistory[0].kind, 'reconstruction-correction');
  assert.equal(item.correctionHistory[0].before, prior.mine.nodes.p1.text); assert.equal(item.correctionHistory[0].after, item.text);
  same(item.sourceRef, prior.mine.nodes.p1.sourceRef); same(state.author, prior.author); same(state.baseline, prior.baseline);
  assert.equal(item.verification.targetVersion, 1); assert.equal(item.checked, '待核对'); assert.equal(item.stance, '待研究');
  state = act(state, { type: 'edit', text: '我认为量产时间仍需观察', reason: '' });
  assert.equal(M.isEdited(state.mine.nodes.p1), true); assert.equal(M.canCorrect(state.mine.nodes.p1), false);
  const rejected = M.reduce(state, { type: 'correct-reconstruction', text: '不能伪装成整理校正' });
  assert.ok(rejected.error); same(rejected.mine, state.mine);
  assert.equal(M.canCorrect(state.mine.nodes.q4), false);
});

test('校正受来源与共享范围保护，局部校正保持其他引用原样', () => {
  let state = withSharedPremise(), prior = copy(state);
  const rejected = M.reduce(state, { type: 'correct-reconstruction', text: '补回原文中的时间' });
  assert.ok(rejected.error); same(rejected.mine, state.mine);
  state = act(state, { type: 'correct-reconstruction', text: '补回原文中的时间', scope: 'j1', reason: '对照原句' });
  const local = state.mine.nodes[state.selected]; assert.equal(M.isEdited(local), false);
  same(state.mine.nodes.p1, prior.mine.nodes.p1); assert.equal(state.mine.edges.j1.premises.includes(local.id), true);
  let missing = selected(fresh(), 'p1'); missing.mine.nodes.p1.sourceRef.start += 1;
  const invalid = M.reduce(missing, { type: 'correct-reconstruction', text: '缺失可核验来源' });
  assert.ok(invalid.error); same(invalid.mine, missing.mine);
});

test('共享局部校正的关系端点替换独立记录，不冒充个人研究或改写', () => {
  let state = act(selected(withSharedPremise(), 'j1'), { type: 'verify', id: 'j1' });
  state = selected(state, 'p1');
  const prior = copy(state), before = prior.mine.edges.j1;
  assert.equal(M.researchUse(before), 'reference'); assert.equal(M.isEdited(before), false);
  state = act(state, { type: 'correct-reconstruction', text: '18A 将在 2026 上半年按期进入量产', scope: 'j1', reason: '补回原句时间' });
  const relation = state.mine.edges.j1, correction = relation.correctionHistory[0];
  assert.equal(M.researchUse(relation), 'reference'); assert.equal(M.isEdited(relation), false);
  assert.equal(relation.edit, undefined); assert.equal(relation.version, before.version + 1);
  assert.equal(correction.fromVersion, before.version); assert.equal(correction.toVersion, relation.version);
  same(correction.beforeContent.premises, before.premises); same(correction.afterContent.premises, relation.premises);
  assert.equal(correction.correctedPremise.before, 'p1'); assert.equal(correction.correctedPremise.after, state.selected);
  same(correction.sourceRef, prior.mine.nodes.p1.sourceRef);
  assert.equal(relation.verification.targetVersion, before.version);
  assert.notEqual(relation.verification.signature, M.signature(state.mine, relation));
  same(state.author, prior.author); same(state.baseline, prior.baseline);
  assert.equal(state.undo.length, prior.undo.length + 1);
  state = act(state, { type: 'undo' }); same(state.mine, prior.mine);
});

test('局部校正保留关系既有个人正文/结构修改及其理由，不新增个人编辑', () => {
  for (const preparation of ['text', 'structure', 'restored']) {
    let state = selected(withSharedPremise(), 'j1');
    if (preparation === 'structure') state = act(state, { type: 'premise', id: 'q4' });
    else {
      const originalText = state.mine.edges.j1.text;
      state = act(state, { type: 'edit', text: '这一步还需要客户合同', reason: '我补充的机制' });
      if (preparation === 'restored') state = act(state, { type: 'edit', text: originalText, reason: '恢复初始正文' });
    }
    state = selected(state, 'p1');
    const prior = copy(state), before = prior.mine.edges.j1, wasEdited = M.isEdited(before);
    state = act(state, { type: 'correct-reconstruction', text: '对照原文补全量产时间', scope: 'j1', reason: '来源校正' });
    const relation = state.mine.edges.j1;
    assert.equal(M.isEdited(relation), wasEdited, preparation);
    assert.equal(M.researchUse(relation), M.researchUse(before));
    same(relation.edit, before.edit); assert.equal(relation.changeReason, before.changeReason);
    assert.equal(relation.text, before.text); assert.equal(relation.combination, before.combination);
    assert.equal(relation.correctionHistory.length, 1);
    same(state.mine.nodes.p1, prior.mine.nodes.p1);
  }
});

test('推导编辑与新增连线记录本人参与，不改来源或AI归属', () => {
  let state = selected(fresh(), 'j1');
  state = act(state, { type: 'premise', id: 'q4' });
  assert.equal(M.researchUse(state.mine.edges.j1), 'research'); assert.equal(M.isEdited(state.mine.edges.j1), true);
  assert.equal(M.researchUse(state.mine.nodes.q4), 'research'); assert.equal(state.mine.nodes.q4.originKind, 'ai');
  assert.equal(state.author.edges.j1.premises.includes('q4'), false);
  state = act(state, { type: 'combination', value: '共同依赖' });
  state = act(state, { type: 'drop-connect', parent: 'q4', child: 'c2' });
  const relation = Object.values(state.mine.edges).find(e => e.premises.includes('q4') && e.conclusion === 'c2');
  assert.ok(relation); assert.equal(relation.originKind, 'user'); assert.equal(M.researchUse(relation), 'research');
  assert.equal(M.researchUse(state.mine.nodes.c2), 'research');
});

test('可选补入参考只追加缺失项，不覆盖已有编辑与基线', () => {
  let state = fresh();
  const baseline = copy(state.baseline);
  state = act(selected(state, 'p1'), { type: 'edit', text: '我的量产条件', reason: '' });
  const changed = copy(state.mine.nodes.p1);
  state = act(state, { type: 'canvas-delete', id: 's3' });
  assert.equal(M.adoptionPlan(state, ['s3']).newIds.includes('s3'), true);
  state = act(state, { type: 'adopt-selected', ids: ['s3'] });
  assert.equal(M.researchUse(state.mine.edges.s3), 'reference');
  same(state.mine.nodes.p1, changed); same(state.baseline, baseline);
});

test('立场变化只记录真实变更，理由单独改变也记录，旧对象兼容', () => {
  let state=selected(fresh(),'c1');
  const initial=copy(state.mine.nodes.c1),baseline=copy(state.baseline),sources=copy(state.sources);
  state=act(state,{type:'stance',value:'质疑',reason:'尚无正式订单承诺',at:'2026-10-05T01:10:00.000Z'});
  const first=copy(state.mine.nodes.c1.stanceHistory[0]);
  same(first.before,{value:'待研究',reason:''});same(first.after,{value:'质疑',reason:'尚无正式订单承诺'});
  assert.equal(first.target.version,1);assert.equal(first.target.text,initial.text);
  const unchanged=copy(state);state=act(state,{type:'stance',value:'质疑',reason:'  尚无正式订单承诺  ',at:'2026-10-05T01:20:00.000Z'});same(state.mine,unchanged.mine);same(state.undo,unchanged.undo);same(state.log,unchanged.log);
  state=act(state,{type:'stance',value:'质疑',reason:'需确认是否正式订单',at:'2026-10-05T01:30:00.000Z'});
  assert.equal(state.mine.nodes.c1.stanceHistory.length,2);same(state.mine.nodes.c1.stanceHistory[0],first);
  state=act(state,{type:'stance',value:'待研究',reason:'此文字不作为待研究理由',at:'2026-10-05T01:40:00.000Z'});
  assert.equal(state.mine.nodes.c1.stanceHistory.length,3);assert.equal(state.mine.nodes.c1.reason,'');
  const rejected=M.reduce(state,{type:'stance',value:'不认可',reason:' '});assert.ok(rejected.error);same(rejected.mine,state.mine);
  same(state.baseline,baseline);same(state.sources,sources);assert.equal(state.mine.nodes.c1.history.length,0);
  const legacy=copy(state);delete legacy.mine.nodes.c1.stanceHistory;legacy.mine.nodes.c1.stance='认可';legacy.mine.nodes.c1.reason='以前保存的依据';
  state=act(legacy,{type:'stance',value:'认可',reason:'新的依据',at:'2026-10-05T02:00:00.000Z'});
  assert.equal(state.mine.nodes.c1.stanceHistory.length,1);assert.equal(state.mine.nodes.c1.stanceHistory[0].before.reason,'以前保存的依据');
});

test('主张与整步推导分别保留当时内容，改写与重查不污染旧立场记录', () => {
  let state=selected(fresh(),'j1');
  state=act(state,{type:'stance',value:'质疑',reason:'这些前提尚不能推出订单',at:'2026-10-05T02:00:00.000Z'});
  const original=copy(state.mine.edges.j1.stanceHistory),target=original[0].target;
  assert.equal(target.premises.length,2);assert.equal(target.conclusion.id,'c1');
  state=act(selected(state,'p1'),{type:'edit',text:'本人改写：量产时间待确认',scope:'all',reason:''});
  same(state.mine.edges.j1.stanceHistory,original);assert.notEqual(target.premises[0].text,state.mine.nodes.p1.text);
  state=act(selected(state,'j1'),{type:'edit',text:'当前推导另需订单条件',reason:''});
  assert.equal(state.mine.edges.j1.stance,'待研究');same(state.mine.edges.j1.stanceHistory,original);
  state=act(state,{type:'verify'});same(state.mine.edges.j1.stanceHistory,original);
  state=act(state,{type:'stance',value:'不认可',reason:'仍缺订单条件',at:'2026-10-05T03:00:00.000Z'});
  assert.equal(state.mine.edges.j1.stanceHistory.length,2);assert.equal(state.mine.edges.j1.stanceHistory[1].target.version,2);
  same(state.mine.edges.j1.stanceHistory[0],original[0]);assert.equal(state.mine.nodes.c1.stanceHistory,undefined);
});

test('批量删除去重、关联整步一并删除且一次撤销，来源与基线保持', () => {
  const initial=fresh(),before=copy(initial),undoCount=initial.undo.length;
  const removed=act(initial,{type:'canvas-delete',ids:['p1','p2','p1','j1']});
  assert.equal(removed.undo.length,undoCount+1);
  assert.equal(removed.mine.nodes.p1,undefined);assert.equal(removed.mine.nodes.p2,undefined);assert.equal(removed.mine.edges.j1,undefined);
  same(removed.mine.nodes.c1,before.mine.nodes.c1);same(removed.mine.edges.s2,before.mine.edges.s2);same(removed.mine.edges.s3,before.mine.edges.s3);
  same(removed.sources,before.sources);same(removed.author,before.author);same(removed.baseline,before.baseline);
  same(act(removed,{type:'undo'}).mine,before.mine);
});

test('失效或空删除范围整体拒绝，不部分删除有效卡片', () => {
  const initial=fresh();
  for(const ids of [[],['p1','missing']]){
    const rejected=M.reduce(initial,{type:'canvas-delete',ids});assert.ok(rejected.error);same(rejected.mine,initial.mine);same(rejected.undo,initial.undo);
  }
});

process.stdout.write(`\n${count} 组直接研究模型验证通过。\n`);
