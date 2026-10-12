/* DOM/model regressions, not a browser-rendering or assistive-technology claim. */
'use strict';
const {JSDOM}=require(process.env.FW_JSDOM||'jsdom');
const fs=require('node:fs');
const path=require('node:path');
const assert=require('node:assert/strict');
const ROOT=path.resolve(__dirname,'..');
const KEY='forkwise.onboarding.open-canvas.r2.v1';
const PROJECT_KEY='forkwise.open-canvas.20261011.v1';
const source=fs.readFileSync(path.join(ROOT,'onboarding.js'),'utf8');
const fixture=`<!doctype html><html><body><header class="app-header"><button id="search">搜索</button></header><main><section id="canvas" tabindex="0"><div id="canvasEngine" tabindex="0"><div class="fw-card" data-node="existing"><h3>原卡片</h3></div></div></section><aside id="editorHost" hidden></aside></main><nav id="toolDock"><button data-tool="card">新建卡</button><button data-tool="line">连线</button></nav><div class="zoom-tools"><button id="help">说明</button></div><div id="popoverHost"></div><div id="modalHost"></div></body></html>`;
function setup({stored,isolated=false,storageError=false,full=false,width=1100,height=760}={}) {
  const html=full?fs.readFileSync(path.join(ROOT,'index.html'),'utf8').replace(/<script\b[^>]*>[\s\S]*?<\/script>/g,''):fixture;
  const dom=new JSDOM(html,{url:'https://forkwise.test/'+(isolated?'?isolated=1':''),runScripts:'outside-only',pretendToBeVisual:true});
  const w=dom.window,d=w.document;
  Object.defineProperty(w,'innerWidth',{value:width,writable:true});Object.defineProperty(w,'innerHeight',{value:height,writable:true});
  w.CSS={escape:s=>String(s).replace(/[^a-z0-9_-]/gi,'\\$&')};
  const rect=(x,y,width,height)=>({x,y,left:x,top:y,right:x+width,bottom:y+height,width,height,toJSON(){return this}});
  w.HTMLElement.prototype.getBoundingClientRect=function(){
    if(this.classList.contains('app-header'))return rect(0,0,w.innerWidth,72);
    if(this.id==='canvas'||this.id==='canvasEngine')return rect(0,72,w.innerWidth,w.innerHeight-72);
    if(this.id==='toolDock')return rect(Math.max(10,w.innerWidth/2-250),w.innerHeight-80,500,54);
    if(this.dataset.tool)return rect(Math.max(18,w.innerWidth/2+(this.dataset.tool==='card'?-120:80)),w.innerHeight-72,this.dataset.tool==='card'?88:38,38);
    if(this.id==='search')return rect(w.innerWidth-130,18,92,36);
    if(this.id==='editorHost')return rect(w.innerWidth-440,72,440,w.innerHeight-72);
    if(this.id==='fp-body')return rect(w.innerWidth-400,230,340,w.innerHeight-260);
    if(this.classList.contains('fwo-card'))return rect(parseFloat(this.style.left)||0,parseFloat(this.style.top)||0,Math.min(w.innerWidth-28,326),this.classList.contains('fwo-compact')?46:340);
    if(this.classList.contains('fw-card'))return rect(parseFloat(this.style.left)||90,(parseFloat(this.style.top)||170)+72,parseFloat(this.style.width)||280,parseFloat(this.style.height)||170);
    return rect(16,90,44,34);
  };
  w.HTMLElement.prototype.getClientRects=function(){return this.closest('[hidden]')?[]:[this.getBoundingClientRect()]};
  w.HTMLElement.prototype.scrollIntoView=function(){};
  w.Range.prototype.getBoundingClientRect=()=>rect(0,0,0,0);
  const frames=new Map();let frameId=0;
  w.requestAnimationFrame=fn=>{frames.set(++frameId,fn);return frameId};w.cancelAnimationFrame=id=>frames.delete(id);
  w.localStorage.setItem('unrelated.preference','keep');
  w.localStorage.setItem(PROJECT_KEY,JSON.stringify({version:1,current:'p',projects:[{id:'p',name:'我的项目',nodes:[{id:'existing',type:'card',title:'原卡片',body:'不能被引导改写',x:90,y:170,w:280,h:170,tags:[]}],edges:[],tags:[]}]}));
  if(stored!==undefined)w.localStorage.setItem(KEY,typeof stored==='string'?stored:JSON.stringify(stored));
  const writes=[];const nativeSet=w.Storage.prototype.setItem;
  w.Storage.prototype.setItem=function(key,value){writes.push(key);if(storageError)throw new Error('QuotaExceededError');return nativeSet.call(this,key,value)};
  if(full){
    for(const file of ['app.js','canvas.js','panels.js','objects.js','clipboard.js'])w.eval(fs.readFileSync(path.join(ROOT,file),'utf8'));
    w.FW.boot();w.FWObjects.init();w.FWClipboard.init();
  }else{
    w.FW=new Proxy({}, {get(){throw new Error('Onboarding must not access application state')}});
  }
  w.eval(source);
  const click=action=>{const b=d.querySelector(`[data-fwo-action="${action}"]`);assert(b,`button ${action} exists`);b.focus();b.click()};
  const key=(key,options={})=>{const e=new w.KeyboardEvent('keydown',{key,bubbles:true,cancelable:true,...options});d.activeElement.dispatchEvent(e);return e};
  const flush=async()=>{for(let n=0;n<6;n++){await Promise.resolve();const batch=[...frames.values()];frames.clear();for(const fn of batch)fn();if(!frames.size){await Promise.resolve();if(!frames.size)return;}}throw new Error('Unbounded render/mutation loop')};
  return {dom,w,d,api:w.FWOnboarding,writes,click,key,flush,close:()=>dom.window.close()};
}
const cases=[];
const test=(name,fn)=>cases.push([name,fn]);

test('First invitation is idempotent, non-modal, focus-preserving, and data-free',async()=>{
  const e=setup();try{
    e.d.querySelector('#help').focus();const before=e.w.localStorage.getItem(PROJECT_KEY);
    e.api.mount();e.api.mount();await e.flush();
    assert.equal(e.d.querySelectorAll('#fwOnboarding').length,1);
    assert.equal(e.api.getState().view,'invite');assert.equal(e.d.activeElement.id,'help');
    assert(!e.d.querySelector('#fwOnboarding [role="dialog"]'));assert(!e.d.querySelector('#fwOnboarding [aria-modal]'));
    assert.equal(e.w.localStorage.getItem(PROJECT_KEY),before);assert.deepEqual(e.writes,[]);
  }finally{e.close()}
});

test('Skip survives refresh; explicit restart always begins at step one',()=>{
  let e=setup();let record;try{e.api.mount();e.click('dismiss');record=e.w.localStorage.getItem(KEY);assert.equal(JSON.parse(record).status,'skipped');assert.equal(e.api.getState().view,'hidden')}finally{e.close()}
  e=setup({stored:record});try{e.api.mount();assert.equal(e.api.getState().view,'hidden');e.api.start();assert.equal(e.api.getState().step,0);assert.equal(e.api.getState().status,'active');assert(e.d.querySelector('[data-fwo-heading]').contains(e.d.activeElement))}finally{e.close()}
});

test('Navigation, completion, refresh and reopening never edit project storage',()=>{
  let e=setup(),record;try{
    const before=e.w.localStorage.getItem(PROJECT_KEY);e.api.mount();e.click('start');
    for(let i=1;i<4;i++){e.click('next');assert.equal(e.api.getState().step,i)}
    e.click('back');assert.equal(e.api.getState().step,2);e.click('next');e.click('next');
    assert.equal(e.api.getState().view,'complete');assert.equal(e.api.getState().status,'completed');e.click('dismiss');
    record=e.w.localStorage.getItem(KEY);assert.equal(JSON.parse(record).status,'completed');assert.equal(e.w.localStorage.getItem(PROJECT_KEY),before);
    assert.equal(e.w.localStorage.getItem('unrelated.preference'),'keep');assert(e.writes.every(key=>key===KEY));
  }finally{e.close()}
  e=setup({stored:record});try{e.api.mount();assert.equal(e.api.getState().view,'hidden');e.api.start();assert.equal(e.api.getState().step,0)}finally{e.close()}
});

test('Refreshing an interrupted tour offers resume without opening it or stealing focus',()=>{
  const e=setup({stored:{version:1,status:'active',step:2}});try{
    e.d.querySelector('#help').focus();e.api.mount();assert.equal(e.api.getState().view,'invite');assert.equal(e.d.activeElement.id,'help');
    e.click('resume');assert.equal(e.api.getState().step,2);assert.match(e.d.querySelector('.fwo-card').textContent,/普通连线/);
    e.api.dismiss();e.api.start();assert.equal(e.api.getState().step,0);
  }finally{e.close()}
});

test('Guide keyboard capture blocks app shortcuts and clipboard actions; Tab remains untrapped',()=>{
  const e=setup();try{
    let received=0,clip=0;e.d.addEventListener('keydown',()=>received++,true);e.d.addEventListener('copy',()=>clip++);e.d.addEventListener('cut',()=>clip++);e.d.addEventListener('paste',()=>clip++);
    e.d.querySelector('#help').focus();e.api.mount();e.api.start();
    e.key('n');e.key('Delete');e.key('z',{ctrlKey:true});assert.equal(received,0);
    const tab=e.key('Tab');assert.equal(tab.defaultPrevented,false);
    e.key('ArrowRight');assert.equal(e.api.getState().step,1);
    e.key('Escape',{isComposing:true});assert.equal(e.api.getState().view,'tour');
    for(const type of ['copy','cut','paste'])e.d.activeElement.dispatchEvent(new e.w.Event(type,{bubbles:true,cancelable:true}));assert.equal(clip,0);
    e.key('Escape');assert.equal(e.api.getState().view,'hidden');assert.equal(e.d.activeElement.id,'help');
    e.d.querySelector('#canvasEngine').focus();e.key('n');assert.equal(received,1);
  }finally{e.close()}
});

test('Real app capture/bubble shortcuts cannot delete objects, switch tools or undo from tour',async()=>{
  const e=setup({full:true});try{
    e.w.FW.select(['existing']);const before=JSON.stringify(e.w.FW.data),selected=JSON.stringify(e.w.FW.state.selected),history=JSON.stringify(e.w.FW.history);
    e.api.mount();e.api.start();for(const [key,options] of [['n',{}],['Delete',{}],['Backspace',{}],['z',{ctrlKey:true}],['d',{metaKey:true}],['k',{ctrlKey:true}],[' ',{code:'Space'}]])e.key(key,options);
    e.click('next');e.click('next');e.click('next');e.click('next');await e.flush();
    assert.equal(JSON.stringify(e.w.FW.data),before);assert.equal(JSON.stringify(e.w.FW.state.selected),selected);assert.equal(JSON.stringify(e.w.FW.history),history);assert.equal(e.w.FW.state.tool,'select');
    assert.equal(e.d.querySelector('#modalHost').children.length,0);
  }finally{e.close()}
});

test('Modal suspension yields Escape/Tab and resumes without focus theft',async()=>{
  const e=setup();try{
    e.api.start();e.click('next');const host=e.d.querySelector('#modalHost');host.innerHTML='<section role="dialog" aria-modal="true"><input id="query"></section>';
    e.d.querySelector('#query').focus();await e.flush();assert.equal(e.d.querySelector('#fwOnboarding').hidden,true);assert.equal(e.api.getState().suspended,true);
    let seen=false;e.d.querySelector('#query').addEventListener('keydown',()=>seen=true);e.key('Escape');assert(seen);
    host.innerHTML='';e.d.querySelector('#search').focus();await e.flush();assert.equal(e.api.getState().step,1);assert.equal(e.d.querySelector('#fwOnboarding').hidden,false);assert.equal(e.d.activeElement.id,'search');
  }finally{e.close()}
});

test('Initial invitation waits for existing editing; active tour never rewrites or steals caret',async()=>{
  const e=setup();try{
    const host=e.d.querySelector('#editorHost');host.hidden=false;host.innerHTML='<div id="fp-body" contenteditable="true" tabindex="0">保留编辑内容</div>';
    const body=e.d.querySelector('#fp-body');body.focus();e.api.mount();assert.equal(e.d.querySelector('#fwOnboarding').hidden,true);assert.equal(e.d.activeElement,body);
    host.hidden=true;e.d.querySelector('#canvasEngine').focus();await e.flush();assert.equal(e.d.querySelector('#fwOnboarding').hidden,false);
    e.api.start();e.click('next');host.hidden=false;body.focus();await e.flush();assert.equal(e.api.getState().compact,true);assert.equal(e.d.activeElement,body);assert.equal(body.textContent,'保留编辑内容');
    e.api.dismiss();assert.equal(e.d.activeElement,body);
  }finally{e.close()}
});

test('Pointer interaction minimizes; locate only changes focus, never activates controls',async()=>{
  const e=setup();try{
    let activated=0;e.d.querySelector('[data-tool="card"]').onclick=()=>activated++;
    e.api.start();e.click('locate');assert.equal(activated,0);assert.equal(e.api.getState().compact,true);assert.equal(e.d.activeElement.dataset.tool,'card');
    e.click('expand');assert.equal(e.api.getState().compact,false);
    e.d.querySelector('#canvasEngine').dispatchEvent(new e.w.Event('pointerdown',{bubbles:true}));await e.flush();assert.equal(e.api.getState().compact,true);
  }finally{e.close()}
});

test('Context switches from visible card to body or empty canvas without creating content',async()=>{
  const e=setup();try{
    e.api.start();e.click('next');assert.match(e.d.querySelector('.fwo-target-label').textContent,/双击/);
    e.d.querySelector('.fw-card').remove();await e.flush();assert.match(e.d.querySelector('.fwo-copy').textContent,/没有可见卡片/);
    const host=e.d.querySelector('#editorHost');host.hidden=false;host.innerHTML='<div id="fp-body" contenteditable="true">正文</div>';await e.flush();assert.match(e.d.querySelector('.fwo-target-label').textContent,/完整正文/);
  }finally{e.close()}
});

test('Invalid state and storage failure are recoverable; isolated mode writes no storage',()=>{
  for(const stored of ['{broken', {version:2,status:'completed',step:0},{version:1,status:'active',step:99},{version:1,status:'active',step:-1}]){
    const e=setup({stored});try{e.api.mount();assert.equal(e.api.getState().view,'invite');e.api.start();assert.equal(e.api.getState().step,0)}finally{e.close()}
  }
  let e=setup({storageError:true});try{e.api.start();e.click('next');assert.equal(e.api.getState().step,1);assert.equal(e.api.getState().storageAvailable,false);assert.match(e.d.querySelector('.fwo-storage').textContent,/未能记住/);e.api.dismiss();assert.equal(e.api.getState().view,'hidden')}finally{e.close()}
  e=setup({isolated:true,stored:{version:1,status:'completed',step:3}});try{e.api.mount();assert.equal(e.api.getState().view,'invite');e.api.start();e.click('next');e.api.dismiss();assert.deepEqual(e.writes,[]);assert.equal(e.api.getState().persistent,false)}finally{e.close()}
});

test('Deterministic placement stays inside narrow and short mocked viewports',()=>{
  for(const [width,height] of [[375,740],[320,568],[740,390]]){
    const e=setup({width,height});try{
      e.api.start();for(let i=0;i<4;i++){
        const p=e.d.querySelector('.fwo-card'),left=parseFloat(p.style.left),top=parseFloat(p.style.top),r=p.getBoundingClientRect();
        assert(left>=14&&left+r.width<=width-14);assert(top>=14&&top+r.height<=height-14);
        if(i<3)e.click('next');
      }
    }finally{e.close()}
  }
});
(async()=>{let count=0;for(const [name,fn] of cases){await fn();console.log('PASS:',name);count++}console.log(`\n${count} onboarding DOM/model regressions passed. Real-browser visual, native Tab order, touch and screen-reader QA remain separate.`)})().catch(error=>{console.error(error);process.exitCode=1});
