const vm = require('vm');
const fs = require('fs');
const assert = require('assert');
let project, serial = 0, passed = 0;
const context = { console, window: {}, document: {}, Set, Map, Math, JSON };
vm.createContext(context);
const state = { selected: [], tool: 'select', viewport: { x: 0, y: 0, zoom: 1 } };
context.window.FW = {
  state, project: () => project, uid: () => `new-${++serial}`,
  select: ids => state.selected = ids, transact: (_, fn) => fn(),
  commit() {}, escape: s => s, toast() {}
};
const source = fs.readFileSync(require('path').join(__dirname, '../canvas.js'), 'utf8');
vm.runInContext(source.replace('window.FWCanvas={', 'window.FWCanvas={cardPreviewLayout,reflowNode,descendants,syncGroups,'), context);
const C = context.window.FWCanvas;
const obj = (id, x = 0, y = 0, type = 'card', w = 100, h = 80) => ({ id, x, y, type, w, h });
function setup(nodes, selected = []) { project = { nodes, edges: [], tags: [] }; state.selected = selected; state.suppressRaise = false; }
function test(name, run) { run(); passed++; console.log(`PASS ${name}`); }
const order = () => project.nodes.map(n => n.id).join(',');
test('D318 independent overlapping targets are crossed together', () => {
  setup([obj('a'), obj('x'), obj('b', 300), obj('y', 300)], ['a', 'b']);
  C.setLayer('forward'); assert.equal(order(), 'x,a,y,b'); assert(state.suppressRaise);
});
test('D319 forward conflict moves necessary selected followers', () => {
  setup([obj('a'), obj('b', 300), obj('x')], ['a', 'b']);
  C.setLayer('forward'); assert.equal(order(), 'x,a,b');
});
test('D319 backward conflict moves necessary selected predecessors', () => {
  setup([obj('x'), obj('a', 300), obj('b')], ['a', 'b']);
  C.setLayer('backward'); assert.equal(order(), 'a,b,x');
});
test('D314 non-overlapping objects are skipped', () => {
  setup([obj('a'), obj('far', 900), obj('x')], ['a']);
  C.setLayer('forward'); assert.equal(order(), 'far,x,a');
  assert.equal(C.canSetLayer('forward'), false);
});
test('group layer operation includes member persistent order', () => {
  setup([obj('g', 0, 0, 'group'), {...obj('a'),groupId:'g'}, {...obj('b', 300),groupId:'g'},obj('x')], ['g']);
  C.setLayer('forward'); assert.equal(order(), 'x,g,a,b');
});
test('front and back keep selected order despite selection order', () => {
  setup([obj('a'),obj('x'),obj('b'),obj('y')], ['b','a']);
  C.setLayer('front');assert.equal(order(),'x,y,a,b');
  C.setLayer('back');assert.equal(order(),'a,b,x,y');
});
test('frame enclosure preserves group membership and captures whole group', () => {
  setup([obj('f',0,0,'frame',500,500),obj('g',20,20,'group',180,180),{...obj('a',60,60),groupId:'g'},{...obj('b',100,100),groupId:'g'}]);
  C.encloseFrame('f');assert.equal(project.nodes[1].parentId,'f');assert(!project.nodes[2].parentId);assert.equal(project.nodes[2].groupId,'g');
});
test('frame enclosure never captures a partly enclosed group via its member', () => {
  setup([obj('f',0,0,'frame',200,200),obj('g',0,0,'group'),{...obj('a',40,40),groupId:'g'},{...obj('b',400,400),groupId:'g'}]);
  C.encloseFrame('f');assert(!project.nodes[1].parentId);assert(!project.nodes[2].parentId);
});
test('frame resizing retains intersections and releases wholly outside members', () => {
  setup([obj('f',0,0,'frame',200,200),{...obj('a',180,180),parentId:'f'},{...obj('b',300,300),parentId:'f'},obj('new',20,20)]);
  C.encloseFrame('f',true);assert.equal(project.nodes[1].parentId,'f');assert.equal(project.nodes[2].parentId,null);assert.equal(project.nodes[3].parentId,'f');
});
test('nested candidate wins over parent, unrelated branch uses foreground', () => {
  setup([obj('outer',0,0,'frame',500,500),{...obj('inner',20,20,'frame',200,200),parentId:'outer'}]);
  assert.equal(C.frameAt({x:50,y:50}).id,'inner');
  project.nodes.push(obj('front',0,0,'frame',300,300));assert.equal(C.frameAt({x:50,y:50}).id,'front');
});
test('drop uses pointer rather than full enclosure, and prevents cycles', () => {
  setup([obj('f',0,0,'frame',200,200),obj('a',180,180)]);
  C.updateFrames(['a'],{x:190,y:190});assert.equal(project.nodes[1].parentId,'f');
  C.updateFrames(['a'],{x:220,y:220});assert.equal(project.nodes[1].parentId,null);
  project.nodes.push({...obj('child',20,20,'frame',100,100),parentId:'f'});
  C.updateFrames(['f'],{x:40,y:40});assert.equal(project.nodes[0].parentId,null);
});
test('moving a group member cannot change frame or group membership', () => {
  setup([obj('f',0,0,'frame',300,300),obj('g',0,0,'group'),{...obj('a',10,10),groupId:'g'}]);
  C.updateFrames(['a'],{x:20,y:20});assert.equal(project.nodes[2].groupId,'g');assert(!project.nodes[2].parentId);
});
test('moving frame preserves descendant memberships', () => {
  setup([obj('f',0,0,'frame',300,300),{...obj('child',10,10,'frame'),parentId:'f'},{...obj('a',20,20),parentId:'child'}]);
  C.updateFrames(['f','child','a'],{x:1000,y:1000});assert.equal(project.nodes[1].parentId,'f');assert.equal(project.nodes[2].parentId,'child');
});
test('selection frame creation requires a common direct parent', () => {
  setup([obj('a'),{...obj('b',200),parentId:'elsewhere'}],['a','b']);assert.equal(C.frameFromSelection(),false);
  project.nodes[1].parentId=null;assert.equal(C.frameFromSelection(),true);const frame=project.nodes.find(n=>n.type==='frame');assert(frame);assert.equal(project.nodes[0].parentId,frame.id);
});
test('grouping assigns only one direct container and ungroup restores frame', () => {
  setup([{...obj('a'),parentId:'f'},{...obj('b',200),parentId:'f'}],['a','b']);C.group();const group=project.nodes.find(n=>n.type==='group');assert.equal(group.parentId,'f');assert.equal(project.nodes.find(n=>n.id==='a').parentId,null);
  C.ungroup();assert.equal(project.nodes[0].parentId,'f');assert.equal(state.selected.length,2);
});
test('remove member preserves geometry and persistent order', () => {
  setup([{...obj('g',0,0,'group'),parentId:'f'},{...obj('a',23,41),groupId:'g'},{...obj('b',200),groupId:'g'}],['a']);C.removeFromGroup();assert.equal(order(),'g,a,b');assert.equal(project.nodes[1].x,23);assert.equal(project.nodes[1].parentId,'f');assert.equal(project.nodes[1].groupId,null);
});
test('card grows only for title/tags and shrinks to manual floor', () => {
  const card=obj('a');let titleHeight=200;const body={style:{}},el={style:{},querySelector:q=>q==='h3'?{offsetHeight:titleHeight}:q==='.fw-card-tags'?{offsetHeight:20}:body};
  C.reflowNode(card,el);assert.equal(card.manualHeight,80);assert.equal(card.h,257);titleHeight=20;C.reflowNode(card,el);assert.equal(card.h,80);assert.equal(card.w,100);assert.equal(card.x,0);
});
test('manual text width stays fixed while content height changes', () => {
  const text={...obj('t',0,0,'text',500,30),manualWidth:true,fontSize:18};const body={scrollHeight:108,getBoundingClientRect:()=>({width:100})},el={style:{},querySelector:()=>body};C.reflowNode(text,el);assert.equal(text.w,500);assert.equal(text.h,108);assert.equal(text.fontSize,18);
});
test('automatic text width caps at320 independent of viewport zoom', () => {
  const text={...obj('t',0,0,'text'),fontSize:18};state.viewport.zoom=2;const body={scrollHeight:54,getBoundingClientRect:()=>({width:900})},el={style:{},querySelector:()=>body};C.reflowNode(text,el);assert.equal(text.w,320);state.viewport.zoom=1;
});
test('alignment uses edge and center guides rather than grid coordinates', () => {
  setup([obj('a',0,0),obj('b',205,200)]);
  const aligned=C.alignmentMove([project.nodes[0]],103,0);
  assert.equal(aligned.dx,105);assert(aligned.guides.some(g=>g.axis==='x'&&g.position===205));
});
test('elbow label uses path distance, curve label follows cubic', () => {
  setup([]);const elbow={start:{x:0,y:0},end:{x:200,y:100},style:'elbow'};
  const p=C.edgePoint(elbow,.25);assert.equal(p.x,75);assert.equal(p.y,0);
  const curved=C.edgePoint({...elbow,style:'curve'},.25);assert.equal(curved.y,15.625);
  assert(Math.abs(C.nearestEdgePosition(elbow,{x:100,y:75})-175/300)<.01);
});
test('removing final group member frees container-bound endpoint', () => {
  setup([obj('g',0,0,'group'),{...obj('a'),groupId:'g'},obj('b',300)],['a']);
  project.edges=[{id:'e',from:'g',to:'b'}];C.removeFromGroup();
  assert(!project.nodes.some(n=>n.id==='g'));assert.equal(project.edges[0].from,null);assert(project.edges[0].start);
});
test('annotations follow target center and target deletion preserves them', () => {
  setup([obj('card'),obj('note',130,20,'text')],['note']);
  assert.equal(C.attachTo('card'),true);project.nodes[0].x=50;project.nodes[0].h=160;C.syncAttachments();
  assert.equal(project.nodes[1].x,180);assert.equal(project.nodes[1].y,60);
  state.selected=['card'];C.remove();assert.equal(project.nodes.length,1);assert.equal(project.nodes[0].id,'note');assert(!project.nodes[0].attachment);assert.equal(project.nodes[0].x,180);
});
test('annotation frame release requires explicit flag and copies are free', () => {
  setup([obj('card'),{...obj('note',130,20,'text'),parentId:'f'}],['note']);
  assert.equal(C.attachTo('card').requiresRelease,true);assert(!project.nodes[1].attachment);
  assert.equal(C.attachTo('card',['note'],true),true);assert.equal(project.nodes[1].parentId,null);
  C.duplicate();assert(!project.nodes[2].attachment);assert(project.nodes[1].attachment);
});
test('card preview only shows complete line boxes with measured footer reserve', () => {
  const preview=C.cardPreviewLayout(192,68,45,23.4);
  assert.equal(preview.lines,3);assert(Math.abs(preview.height-70.2)<.001);
  assert(preview.height<=192-68-45);
  assert.equal(C.cardPreviewLayout(149,92,45,23.4).lines,0);
});
test('card preview reflow uses actual body offset, line height and tag location', () => {
  const card={...obj('a',0,0,'card',300,192),body:'Long source is retained'};
  const body={offsetTop:68,style:{},dataset:{}},title={offsetHeight:54},tags={offsetHeight:20,offsetTop:156};
  const el={style:{},querySelector:q=>q==='h3'?title:q==='.fw-card-tags'?tags:body};
  context.window.getComputedStyle=element=>element===body?{lineHeight:'23.4px'}:{paddingBottom:'24px',borderBottomWidth:'1px'};
  C.reflowNode(card,el);assert.equal(body.dataset.previewLines,'3');assert.equal(body.style.webkitLineClamp,'3');assert.equal(card.h,192);assert.equal(card.body,'Long source is retained');
  delete context.window.getComputedStyle;
});
console.log(`\n${passed} R2 engine tests passed`);
