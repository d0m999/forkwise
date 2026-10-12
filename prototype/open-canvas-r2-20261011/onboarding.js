/* Forkwise: optional, read-only, contextual canvas orientation. */
(() => {
'use strict';
const KEY = 'forkwise.onboarding.open-canvas.r2.v1';
const VERSION = 1;
const STEPS = [
  {name:'建卡',title:'放下第一个想法',body:'点击底部「新建卡」，再点画布空白处，输入标题。按 Enter 完成标题编辑。',hint:'一张卡，先装下一个想法。',shortcut:'N · 新建卡',selector:'#toolDock [data-tool="card"]',next:'下一步：写正文'},
  {name:'正文',title:'把想法写完整',body:'双击一张卡片，打开右侧写字板。标题留在卡面，完整正文在这里慢慢写。',hint:'正文支持段落、列表和图片；输入 / 可找内容块。',shortcut:'双击卡片 · 打开正文',next:'下一步：普通连线'},
  {name:'连线',title:'给两个想法搭一条线',body:'选择底部「连线」，从一个对象拖向另一个对象，也可以连接空白位置。线的含义由你来定。',hint:'普通连线不会建立推导关系，也不会触发 AI。',shortcut:'L · 连线',selector:'#toolDock [data-tool="line"]',next:'下一步：搜索'},
  {name:'搜索',title:'再把想法找回来',body:'点击右上角「搜索卡片」，搜索当前项目的标题与完整正文。也可以叠加标签条件。',hint:'结果预览只用于阅读；点「在画布中打开」才会定位到卡片。',shortcut:'Ctrl / ⌘ K · 搜索',selector:'#search',next:'完成引导'}
];
let root, panel, ring, live, mounted = false, record, view = 'hidden', step = 0;
let compact = false, suspended = false, queued = false, pendingFocus = false;
let lastAppFocus = null, renderKey = '', memoryOnly = false, storageFailed = false;
const $ = selector => document.querySelector(selector);
const escape = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const clamp = (n, min, max) => Math.min(Math.max(n, min), Math.max(min, max));

function initialRecord() { return {version:VERSION,status:'new',step:0}; }
function load() {
  try {
    memoryOnly = new URLSearchParams(window.location.search).has('isolated');
    if (memoryOnly) return initialRecord();
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return initialRecord();
    const value = JSON.parse(raw);
    if (value?.version !== VERSION || !['active','skipped','completed'].includes(value.status) || !Number.isInteger(value.step) || value.step < 0 || value.step >= STEPS.length) return initialRecord();
    return {version:VERSION,status:value.status,step:value.step};
  } catch (_) { storageFailed = true; return initialRecord(); }
}
function persist(status) {
  record = {version:VERSION,status,step};
  if (memoryOnly) return;
  try { window.localStorage.setItem(KEY, JSON.stringify(record)); storageFailed = false; }
  catch (_) { storageFailed = true; }
}
function rendered(element) {
  if (!element?.isConnected || element.closest('[hidden],[inert]')) return false;
  const style = window.getComputedStyle(element);
  return style.display !== 'none' && style.visibility !== 'hidden' && element.getClientRects().length > 0;
}
function editable(element) { return !!element?.closest?.('input,textarea,select,[contenteditable="true"],[contenteditable=""]'); }
function blockingSurface() {
  return [...document.querySelectorAll('.fw-dialog-backdrop,[aria-modal="true"],#popoverHost > *,#fp-insert > *,.fw-crop-actions,#saveBanner:not([hidden])')].some(rendered);
}
function inviteShouldWait() {
  return editable(document.activeElement) || rendered($('#editorHost'));
}
function rememberAppFocus(element) {
  if (element && element !== document.body && !root?.contains(element) && rendered(element)) lastAppFocus = element;
}
function focusPanel() {
  pendingFocus = false;
  panel.querySelector('[data-fwo-heading]')?.focus({preventScroll:true});
}
function announce(message) { if (live.textContent !== message) live.textContent = message; }
function snapshot() {
  return {status:record?.status || 'new',step,view,compact,suspended,storageAvailable:!storageFailed,persistent:!memoryOnly&&!storageFailed};
}

// Reads rendered controls only. It never calls FW, simulates clicks, or reads/writes project data.
function targetForStep() {
  const info = STEPS[step];
  if (step !== 1) return {element:$(info.selector),label:step === 0?'底部 · 新建卡':step === 2?'底部 · 连线':'右上角 · 搜索卡片',kind:'control'};
  const body = $('#fp-body');
  if (rendered(body)) return {element:body,label:'写字板 · 完整正文',kind:'body'};
  const candidates = [...document.querySelectorAll('.fw-card.is-selected'), ...document.querySelectorAll('.fw-card:not(.is-selected)')];
  const card = candidates.find(element => visibleRect(element));
  if (card) return {element:card,label:'画布卡片 · 双击打开写字板',kind:'card'};
  return {element:$('#toolDock [data-tool="card"]'),label:'画布还没有可见卡片',kind:'empty'};
}
function visibleRect(element) {
  if (!rendered(element)) return null;
  const r = element.getBoundingClientRect();
  let left = Math.max(4,r.left), top = Math.max(4,r.top), right = Math.min(window.innerWidth-4,r.right), bottom = Math.min(window.innerHeight-4,r.bottom);
  for (let ancestor = element.parentElement; ancestor && ancestor !== document.body; ancestor = ancestor.parentElement) {
    const style = window.getComputedStyle(ancestor);
    if (/(auto|scroll|hidden|clip)/.test(style.overflow + style.overflowX + style.overflowY)) {
      const box = ancestor.getBoundingClientRect();
      left = Math.max(left,box.left); right = Math.min(right,box.right); top = Math.max(top,box.top); bottom = Math.min(bottom,box.bottom);
    }
  }
  if (right-left < 8 || bottom-top < 8) return null;
  return {left,top,right,bottom,width:right-left,height:bottom-top};
}
function button(action, text, cls = '') { return `<button type="button" data-fwo-action="${action}" class="${cls}">${text}</button>`; }
function closeButton() { return '<button type="button" class="fwo-close" data-fwo-action="dismiss" aria-label="关闭并跳过引导" title="关闭引导">×</button>'; }
function storageNote() { return storageFailed?'<p class="fwo-storage" role="status">浏览器未能记住引导进度，本次仍可继续。</p>':memoryOnly?'<p class="fwo-storage">隔离演示：引导进度仅保留在本次页面。</p>':''; }
function draw(target) {
  const key = [view,step,compact,target?.kind,storageFailed,memoryOnly].join(':');
  if (key === renderKey) return;
  renderKey = key;
  panel.className = 'fwo-card' + (compact && view === 'tour'?' fwo-compact':'');
  panel.removeAttribute('aria-describedby');
  panel.setAttribute('aria-labelledby','fwo-title');
  if (view === 'invite') {
    const resume = record.status === 'active';
    panel.innerHTML = `<div class="fwo-top"><span class="fwo-overline"><img src="assets/logo-mark.svg" alt="">认识见岔</span>${closeButton()}</div><h2 id="fwo-title" tabindex="-1" data-fwo-heading>${resume?'接着认识这张画布':'先认识这张画布'}</h2><p class="fwo-copy">${resume?`上次看到第 ${record.step+1} 步「${STEPS[record.step].name}」。可以接着看，也可以从头走一遍。`:'用 4 步找到常用入口。你可以边看边操作，也可以随时跳过。'}</p><ol class="fwo-path" aria-label="引导内容">${STEPS.map((item,i)=>`<li><span>${i+1}</span>${item.name}</li>`).join('')}</ol><p class="fwo-truth">AI 仅本地模拟 · 未连接模型 · 不联网查证</p><div class="fwo-actions">${button('dismiss','暂时跳过','fwo-secondary')}${button(resume?'resume':'start',resume?`继续第 ${record.step+1} 步`:'开始 4 步引导','fwo-primary')}</div>${resume?button('restart','从头看看','fwo-restart'):''}<p class="fwo-footnote">以后可从右下角「使用说明」重新打开</p>${storageNote()}`;
  } else if (view === 'complete') {
    panel.innerHTML = `<div class="fwo-top"><span class="fwo-overline">4 步导览完成</span><button type="button" class="fwo-close" data-fwo-action="dismiss" aria-label="关闭引导">×</button></div><h2 id="fwo-title" tabindex="-1" data-fwo-heading>接下来，按自己的节奏</h2><p class="fwo-copy">从一张卡开始，写下来、连起来，再慢慢找回想法。需要时，可在「使用说明」里重新打开引导。</p><p class="fwo-truth">AI 仅本地模拟，候选需你明确添加才会成为新卡片。</p><div class="fwo-actions">${button('restart','再看一遍','fwo-secondary')}${button('dismiss','返回画布','fwo-primary')}</div>${storageNote()}`;
  } else if (compact) {
    panel.innerHTML = `<span class="fwo-compact-label" id="fwo-title">${String(step+1).padStart(2,'0')} / 04 <b>${STEPS[step].name}</b></span>${button('expand','继续引导','fwo-resume')}<button type="button" class="fwo-close" data-fwo-action="dismiss" aria-label="关闭并跳过引导">×</button>`;
  } else {
    const info = STEPS[step], body = step === 1 && target.kind === 'empty'?'目前没有可见卡片。先用「新建卡」放下一张想法，再双击卡片打开正文；也可以继续看后面的说明。':info.body;
    panel.setAttribute('aria-describedby','fwo-copy');
    panel.innerHTML = `<div class="fwo-top"><span class="fwo-overline">画布初识 <span class="fwo-count">${String(step+1).padStart(2,'0')} / 04</span></span><div class="fwo-top-actions"><button type="button" class="fwo-minimize" data-fwo-action="minimize" aria-label="收起引导，继续操作画布" title="收起引导">−</button>${closeButton()}</div></div><ol class="fwo-progress" aria-label="引导步骤">${STEPS.map((item,i)=>`<li ${i===step?'aria-current="step"':''} class="${i<step?'is-past':''}"><span>${escape(item.name)}</span></li>`).join('')}</ol><p class="fwo-target-label">${escape(target.label)}</p><h2 id="fwo-title" tabindex="-1" data-fwo-heading>${info.title}</h2><p class="fwo-copy" id="fwo-copy">${body}</p><p class="fwo-tip">${info.hint}</p><div class="fwo-locate-row"><span class="fwo-shortcut">${info.shortcut}</span>${button('locate','定位到区域 ↗','fwo-locate')}</div><div class="fwo-actions">${button(step?'back':'dismiss',step?'上一步':'跳过','fwo-secondary')}${button('next',info.next,'fwo-primary')}</div><p class="fwo-footnote">下一步只看说明，不会创建或改动内容</p><p class="fwo-ai-caption">AI 仅本地模拟 · 未连接模型 · 不联网查证</p>${storageNote()}`;
  }
}
function position(target) {
  const padding = 14, headerBottom = $('.app-header')?.getBoundingClientRect().bottom || 60;
  const topMin = Math.max(padding,headerBottom+12), viewportHeight = window.visualViewport?.height || window.innerHeight;
  const height = panel.getBoundingClientRect().height || (compact?48:330), width = panel.getBoundingClientRect().width || Math.min(326,window.innerWidth-padding*2);
  const maxTop = Math.max(padding,viewportHeight-height-padding);
  const topLimit = Math.min(topMin,maxTop);
  let left = window.innerWidth-width-padding, top = topLimit;
  const r = view === 'tour' && !compact ? visibleRect(target?.element) : null;
  ring.hidden = !r;
  if (r) {
    ring.style.left = (r.left-4)+'px'; ring.style.top = (r.top-4)+'px';
    ring.style.width = (r.width+8)+'px'; ring.style.height = (r.height+8)+'px';
  }
  if (compact) left = padding;
  else if (r) {
    const candidates = [
      {left:r.left+r.width/2-width/2,top:r.top-height-16},
      {left:r.left-width-16,top:r.top},
      {left:r.right+16,top:r.top},
      {left:r.left+r.width/2-width/2,top:r.bottom+16},
      {left:padding,top:topLimit},
      {left:window.innerWidth-width-padding,top:topLimit}
    ];
    const forbidden = [r,...['#toolDock','.zoom-tools','#saveBanner:not([hidden])'].map(selector=>visibleRect($(selector))).filter(Boolean)];
    const editor = $('#editorHost');
    if (rendered(editor) && !editor.contains(target.element)) forbidden.push(visibleRect(editor));
    const intersection = (a,b) => b?Math.max(0,Math.min(a.left+width,b.right)-Math.max(a.left,b.left))*Math.max(0,Math.min(a.top+height,b.bottom)-Math.max(a.top,b.top)):0;
    const options = candidates.map((candidate,i)=> {
      const fixed = {left:clamp(candidate.left,padding,window.innerWidth-width-padding),top:clamp(candidate.top,topLimit,maxTop)};
      return {...fixed,score:forbidden.reduce((total,box)=>total+intersection(fixed,box),0)+i*8};
    }).sort((a,b)=>a.score-b.score);
    ({left,top}=options[0]);
  } else if (view !== 'tour') {
    // The invitation sits in the canvas, away from the persistent tool dock.
    left = padding+10;
    top = topLimit+Math.min(110,Math.max(0,viewportHeight-height-topLimit-110));
  }
  panel.style.left = clamp(left,padding,window.innerWidth-width-padding)+'px';
  panel.style.top = clamp(top,topLimit,maxTop)+'px';
}
function sync() {
  queued = false;
  if (!mounted) return;
  if (view === 'hidden') { root.hidden = true; ring.hidden = true; return; }
  suspended = blockingSurface() || (view === 'invite' && inviteShouldWait());
  root.hidden = suspended;
  if (suspended) { ring.hidden = true; return; }
  const target = view === 'tour'?targetForStep():null;
  draw(target); position(target);
  if (pendingFocus && !compact) focusPanel();
}
function schedule() {
  if (!mounted || queued) return;
  queued = true;
  window.requestAnimationFrame(sync);
}
function begin(at = 0) {
  if (!mounted) mount({autoInvite:false});
  rememberAppFocus(document.activeElement);
  step = clamp(at,0,STEPS.length-1); view = 'tour'; compact = false; pendingFocus = true;
  persist('active'); sync();
  announce(`画布引导，第 ${step+1} 步，共 4 步：${STEPS[step].title}。随时可以跳过。`);
  return snapshot();
}
function start() { return begin(0); }
function dismiss() {
  if (!mounted) mount({autoInvite:false});
  const ownedFocus = root.contains(document.activeElement);
  if (record.status !== 'completed') persist('skipped');
  view = 'hidden'; compact = false; pendingFocus = false; suspended = false; sync();
  if (ownedFocus && !blockingSurface()) {
    const target = rendered(lastAppFocus)?lastAppFocus:($('#help') || $('#canvas'));
    target?.focus?.({preventScroll:true});
  }
  announce('引导已关闭。可从使用说明重新打开。');
  return snapshot();
}
function navigate(delta) {
  if (view !== 'tour') return;
  if (step+delta >= STEPS.length) {
    persist('completed'); view = 'complete'; compact = false; pendingFocus = true; sync();
    announce('四步引导已完成。你的画布内容没有被引导改动。');
    return;
  }
  step = clamp(step+delta,0,STEPS.length-1); persist('active'); pendingFocus = true; sync();
  announce(`第 ${step+1} 步，共 4 步：${STEPS[step].title}`);
}
function minimize() {
  if (view !== 'tour') return;
  compact = true; pendingFocus = false; sync();
}
function locate() {
  const target = targetForStep();
  const element = target.kind === 'card'?$('#canvasEngine'):target.element;
  if (!rendered(element)) return;
  minimize();
  element.focus?.({preventScroll:true});
  // No .click(), selection change, editor opening, viewport movement, or tool activation.
}
function mount(options = {}) {
  if (mounted) return snapshot();
  record = load(); step = record.step;
  root = document.createElement('div'); root.id = 'fwOnboarding'; root.hidden = true;
  root.innerHTML = '<div class="fwo-ring" aria-hidden="true" hidden></div><section class="fwo-card" role="region" aria-label="画布入门引导"></section>';
  document.body.append(root);
  panel = root.querySelector('.fwo-card'); ring = root.querySelector('.fwo-ring');
  live = document.createElement('div'); live.className = 'fwo-sr-only'; live.setAttribute('role','status'); live.setAttribute('aria-live','polite'); live.setAttribute('aria-atomic','true');
  document.body.append(live); mounted = true;
  rememberAppFocus(document.activeElement);
  root.addEventListener('click',event=> {
    const action = event.target.closest('[data-fwo-action]')?.dataset.fwoAction;
    if (!action) return;
    if (['start','restart'].includes(action)) start();
    else if (action === 'resume') begin(record.step);
    else if (action === 'dismiss') dismiss();
    else if (action === 'next') navigate(1);
    else if (action === 'back') navigate(-1);
    else if (action === 'minimize') { minimize(); panel.querySelector('[data-fwo-action="expand"]')?.focus({preventScroll:true}); }
    else if (action === 'expand') { compact = false; pendingFocus = true; sync(); }
    else if (action === 'locate') locate();
  });
  // Stop app shortcuts only inside the guide. Tab is deliberately not trapped.
  window.addEventListener('keydown',event=> {
    if (!root.contains(event.target)) return;
    event.stopImmediatePropagation();
    if (event.isComposing) return;
    if (event.key === 'Escape') { event.preventDefault(); dismiss(); }
    else if (view === 'tour' && !compact && !event.ctrlKey && !event.metaKey && !event.altKey && ['ArrowLeft','ArrowRight'].includes(event.key)) {
      event.preventDefault(); navigate(event.key === 'ArrowRight'?1:-1);
    }
  },true);
  // Native text copy may still work; canvas clipboard handlers must never see guide events.
  for (const type of ['copy','cut','paste']) root.addEventListener(type,event=>{
    event.stopPropagation();
    if (type !== 'copy') event.preventDefault();
  });
  root.addEventListener('keyup',event=>event.stopPropagation());
  document.addEventListener('pointerdown',event=> {
    if (view === 'tour' && !compact && !root.contains(event.target)) minimize();
  },true);
  document.addEventListener('focusin',event=> {
    if (root.contains(event.target)) return;
    rememberAppFocus(event.target);
    if (view === 'tour' && editable(event.target)) minimize();
    schedule();
  });
  document.addEventListener('focusout',schedule);
  document.addEventListener('fwcanvasrender',schedule);
  window.addEventListener('resize',schedule);
  document.addEventListener('scroll',schedule,true);
  window.visualViewport?.addEventListener('resize',schedule);
  window.visualViewport?.addEventListener('scroll',schedule);
  new MutationObserver(mutations=> {
    if (mutations.some(mutation=>!root.contains(mutation.target) && mutation.target !== live && !live.contains(mutation.target))) schedule();
  }).observe(document.body,{subtree:true,childList:true,attributes:true,attributeFilter:['hidden','class','contenteditable','aria-modal']});
  if (options.autoInvite !== false && !['skipped','completed'].includes(record.status)) view = 'invite';
  sync();
  return snapshot();
}
window.FWOnboarding = Object.freeze({mount,start,dismiss,getState:snapshot});
})();
