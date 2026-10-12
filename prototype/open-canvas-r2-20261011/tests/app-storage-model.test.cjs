const {JSDOM}=require(process.env.FW_JSDOM||'jsdom');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.join(__dirname,'..'),html=fs.readFileSync(path.join(root,'index.html'),'utf8'),source=fs.readFileSync(path.join(root,'app.js'),'utf8');
const KEY='forkwise.open-canvas.20261011.v1';
function setup({raw,fail=false,isolated=false}={}){const dom=new JSDOM(html,{url:'https://forkwise.test/'+(isolated?'?isolated=1':''),runScripts:'outside-only',pretendToBeVisual:true});const w=dom.window;if(raw!==undefined)w.localStorage.setItem(KEY,raw);let writes=0;const original=w.Storage.prototype.setItem;w.Storage.prototype.setItem=function(k,v){writes++;if(fail)throw new Error('quota');return original.call(this,k,v);};w.FWCanvas={mount(){},render(){},finishEdit(){},finishCrop(){},setTool(){}};w.FWPanels={mount(){},render(){},flush(){},closeEditor(){},closeSearch(){}};w.eval(source);w.FW.boot();return{w,dom,writes:()=>writes};}
{
 const {w,dom}=setup({raw:'not-json'});assert.equal(w.FW.save(),false);w.FW.transact('test',p=>p.name='new unsaved name');assert.equal(w.localStorage.getItem(KEY),'not-json');assert.equal(w.FW.getSaveStatus().ok,false);assert.equal(w.document.getElementById('saveBanner').hidden,false);dom.window.close();console.log('PASS malformed archive is never overwritten by edits');
}
{
 const {w,dom}=setup({fail:true});w.FW.transact('edit',p=>p.nodes[0].title='kept in memory');assert.equal(w.FW.project().nodes[0].title,'kept in memory');assert.equal(w.FW.getSaveStatus().ok,false);assert.equal(w.document.getElementById('saveBanner').hidden,false);assert.equal(w.FW.history.past.length,1);dom.window.close();console.log('PASS quota failure preserves in-memory edit and undo with visible failure');
}
{
 const {w,dom,writes}=setup({isolated:true});w.FW.transact('edit',p=>p.name='isolated');assert.equal(writes(),0);assert.equal(w.document.getElementById('saveStatus').textContent,'隔离演示 · 仅本次会话');dom.window.close();console.log('PASS isolated mode never writes project storage');
}
console.log('3 application storage recovery regressions passed');
