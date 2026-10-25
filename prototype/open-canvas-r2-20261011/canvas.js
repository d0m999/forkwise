/* Forkwise R2 recovery rebuild from R1 and recorded patch operations; re-QA required. */
(() => {
'use strict';
let root, world, overlay, drag, space=false, options={}, editing=null, clipboard=null, pointer=null, crop=null, lastClick=null;
const P=()=>window.FW.project(), S=()=>window.FW.state, clone=o=>JSON.parse(JSON.stringify(o)), esc=s=>window.FW.escape(String(s??'')), uid=()=>window.FW.uid();
const selected=()=>S().selected||[], node=id=>P().nodes.find(n=>n.id===id), edge=id=>P().edges.find(e=>e.id===id), isContainer=n=>n&&['group','frame'].includes(n.type);
const change=(label,fn)=>window.FW.transact(label,fn), select=ids=>{if(JSON.stringify(ids)!==JSON.stringify(selected()))S().suppressRaise=false;window.FW.select([...new Set(ids)]);}, save=(label,before)=>window.FW.commit(label,before);
const rect=n=>({x:n.x||0,y:n.y||0,w:n.w||160,h:n.h||80});
function bounds(items=P().nodes){if(!items.length)return {x:0,y:0,w:0,h:0};const r=items.map(rect),x=Math.min(...r.map(a=>a.x)),y=Math.min(...r.map(a=>a.y));return{x,y,w:Math.max(...r.map(a=>a.x+a.w))-x,h:Math.max(...r.map(a=>a.y+a.h))-y};}
function descendants(ids){const out=new Set(ids);let more=true;while(more){more=false;P().nodes.forEach(n=>{if((out.has(n.groupId)||out.has(n.parentId))&&!out.has(n.id)){out.add(n.id);more=true;}});}return out;}
function syncGroups(){P().nodes.filter(n=>n.type==='group').forEach(g=>{const m=P().nodes.filter(n=>n.groupId===g.id);if(m.length){const b=bounds(m);Object.assign(g,{x:b.x-16,y:b.y-32,w:b.w+32,h:b.h+48});}});}
function position(e){const b=root.getBoundingClientRect(),v=S().viewport;return{x:(e.clientX-b.left-v.x)/v.zoom,y:(e.clientY-b.top-v.y)/v.zoom};}
function center(){const v=S().viewport;return{x:(root.clientWidth/2-v.x)/v.zoom,y:(root.clientHeight/2-v.y)/v.zoom};}
function pointAt(n,side){const b=rect(n);return side==='left'?{x:b.x,y:b.y+b.h/2}:side==='top'?{x:b.x+b.w/2,y:b.y}:side==='bottom'?{x:b.x+b.w/2,y:b.y+b.h}:{x:b.x+b.w,y:b.y+b.h/2};}
function endpoints(e){return{a:node(e.from)?pointAt(node(e.from),e.fromSide||'right'):(e.start||{x:0,y:0}),b:node(e.to)?pointAt(node(e.to),e.toSide||'left'):(e.end||{x:100,y:100})};}
function nearest(p,exclude){
const eligible=P().nodes.map((n,index)=>({n,index})).filter(({n})=>n.type!=='stroke');
// Content objects win over their organizational containers, matching visible hit targets.
const inside=eligible.filter(({n})=>p.x>=n.x&&p.x<=n.x+n.w&&p.y>=n.y&&p.y<=n.y+n.h);
inside.sort((a,b)=>{const ac=isContainer(a.n),bc=isContainer(b.n);if(ac!==bc)return ac?1:-1;if(ac&&bc)return a.n.w*a.n.h-b.n.w*b.n.h;const pure=selected().length&&selected().every(id=>node(id)?.type==='card')&&!S().suppressRaise,ar=pure&&selected().includes(a.n.id),br=pure&&selected().includes(b.n.id);if(ar!==br)return ar?-1:1;return b.index-a.index;});
if(inside.length){const n=inside[0].n;const sides=[['left',Math.abs(p.x-n.x)],['right',Math.abs(n.x+n.w-p.x)],['top',Math.abs(p.y-n.y)],['bottom',Math.abs(n.y+n.h-p.y)]].sort((a,b)=>a[1]-b[1]);return{id:n.id,side:sides[0][0],p:pointAt(n,sides[0][0]),blockedSelf:n.id===exclude};}
let best=null,dist=24/S().viewport.zoom;eligible.reverse().forEach(({n})=>{for(const side of ['left','right','top','bottom']){const q=pointAt(n,side),d=Math.hypot(q.x-p.x,q.y-p.y);if(d<dist){dist=d;best={id:n.id,side,p:q,blockedSelf:n.id===exclude};}}});return best;
}
function path(e){const {a,b}=endpoints(e);if(e.style==='elbow'){const m=(a.x+b.x)/2;return`M${a.x},${a.y} H${m} V${b.y} H${b.x}`;}if(e.style==='curve'){const d=Math.max(50,Math.abs(b.x-a.x)*.5);return`M${a.x},${a.y} C${a.x+d},${a.y} ${b.x-d},${b.y} ${b.x},${b.y}`;}return`M${a.x},${a.y} L${b.x},${b.y}`;}
function edgePoint(e,t=e.labelPosition??.5){
  const {a,b}=endpoints(e);t=Math.max(0,Math.min(1,t));
  if(e.style==='curve'){
    const d=Math.max(50,Math.abs(b.x-a.x)*.5),u=1-t;
    return {x:u*u*u*a.x+3*u*u*t*(a.x+d)+3*u*t*t*(b.x-d)+t*t*t*b.x,y:u*u*u*a.y+3*u*u*t*a.y+3*u*t*t*b.y+t*t*t*b.y};
  }
  if(e.style==='elbow'){
    const m=(a.x+b.x)/2,points=[a,{x:m,y:a.y},{x:m,y:b.y},b];
    const lengths=points.slice(1).map((p,i)=>Math.hypot(p.x-points[i].x,p.y-points[i].y));
    let distance=t*lengths.reduce((sum,n)=>sum+n,0);
    for(let i=0;i<lengths.length;i++){if(distance<=lengths[i]||i===lengths.length-1){const k=lengths[i]?distance/lengths[i]:0;return {x:points[i].x+(points[i+1].x-points[i].x)*k,y:points[i].y+(points[i+1].y-points[i].y)*k};}distance-=lengths[i];}
  }
  return {x:a.x+(b.x-a.x)*t,y:a.y+(b.y-a.y)*t};
}
function nearestEdgePosition(e,p){let best=0,distance=Infinity;for(let i=0;i<=200;i++){const t=i/200,q=edgePoint(e,t),d=Math.hypot(q.x-p.x,q.y-p.y);if(d<distance){distance=d;best=t;}}return Math.max(.05,Math.min(.95,best));}
function alignmentMove(original,dx,dy){
  const box=bounds(original),ids=new Set(original.map(n=>n.id)),threshold=6/S().viewport.zoom;
  const moving={x:box.x+dx,y:box.y+dy,w:box.w,h:box.h},guides=[];
  for(const axis of ['x','y']){
    const size=axis==='x'?'w':'h';let best=threshold,offset=0,guide=null;
    const anchors=[moving[axis],moving[axis]+moving[size]/2,moving[axis]+moving[size]];
    for(const n of P().nodes){if(ids.has(n.id)||n.type==='group')continue;for(const target of [n[axis],n[axis]+n[size]/2,n[axis]+n[size]])for(const source of anchors){const diff=target-source;if(Math.abs(diff)<best){best=Math.abs(diff);offset=diff;guide={axis,position:target};}}}
    if(axis==='x')dx+=offset;else dy+=offset;if(guide)guides.push(guide);
  }
  return {dx,dy,guides};
}
function strokePath(n){return(n.points||[]).map((p,i)=>`${i?'L':'M'}${p.x},${p.y}`).join(' ');}
function safeInline(html){const box=document.createElement('div');box.innerHTML=html;box.querySelectorAll('script,style,iframe,object,embed,svg,img,video,audio').forEach(e=>e.remove());box.querySelectorAll('*').forEach(el=>{const color=el.style.color||el.getAttribute('color'),weight=el.style.fontWeight,italic=el.style.fontStyle,dec=el.style.textDecoration;[...el.attributes].forEach(a=>el.removeAttribute(a.name));if(color)el.style.color=color;if(weight)el.style.fontWeight=weight;if(italic)el.style.fontStyle=italic;if(dec)el.style.textDecoration=dec;});return box.innerHTML;}
function shape(n){const fill=esc(n.color||'#f1ede5'),common=`fill="${fill}" stroke="${esc(n.stroke||'#9b978f')}" stroke-width="1.5"`;let s=n.shape==='ellipse'?`<ellipse cx="50" cy="50" rx="49" ry="49" ${common}/>`:n.shape==='diamond'?`<polygon points="50,1 99,50 50,99 1,50" ${common}/>`:n.shape==='triangle'?`<polygon points="50,1 99,99 1,99" ${common}/>`:`<rect x="1" y="1" width="98" height="98" rx="${n.shape==='rounded'?12:0}" ${common}/>`;return`<svg viewBox="0 0 100 100" preserveAspectRatio="none">${s}</svg><div class="fw-shape-text" style="font-size:${n.fontSize||17}px;color:${esc(n.textColor||'#343832')};font-weight:${n.bold?700:400}">${esc(n.title||'')}</div>`;}
function imageMarkup(n){const c=n.crop||{x:0,y:0,w:1,h:1},w=n.w/c.w,h=n.h/c.h,rot=n.rotation||0,turned=Math.abs(rot%180)===90;return `<div class="fw-image-inner"><div style="position:absolute;left:${-c.x*w}px;top:${-c.y*h}px;width:${w}px;height:${h}px"><img draggable="false" alt="画布图片" src="${esc(n.src||'')}" style="position:absolute;left:50%;top:50%;width:${turned?h:w}px;height:${turned?w:h}px;transform:translate(-50%,-50%) rotate(${rot}deg)"></div></div>`;}
function nodeHTML(n,z){if(crop?.id===n.id)n={...n,...crop.full,crop:null};const b=rect(n),sel=selected().includes(n.id),affected=frameResizeEffect(n),style=`left:${b.x}px;top:${b.y}px;width:${b.w}px;height:${b.h}px;z-index:${z};${n.type==='card'?`--card-tint:${esc(n.color||'#fffdf8')};`:n.type==='frame'?`background:${esc(n.color||'transparent')};`:''}`,tags=(n.tags||[]).map(id=>{const t=(P().tags||[]).find(t=>t.id===id);return`<span style="background:${esc(t?.color||'#778568')}">${esc(t?t.name:id)}</span>`;}).join('');let body='';
if(n.type==='card')body=`<h3>${esc(n.title||'未命名卡片')}</h3><div class="fw-card-body">${esc((n.body||'').replace(/<[^>]*>/g,'')).slice(0,520)}</div>${tags?`<div class="fw-card-tags">${tags}</div>`:''}<span class="fw-card-foot">双击打开写字板</span>`;
else if(n.type==='text')body=`<div class="fw-text-body" style="font-size:${n.fontSize||18}px;text-align:${esc(n.align||'left')};color:${esc(n.color||'#343832')};font-weight:${n.bold?700:400}">${(n.html?safeInline(n.html):'')||esc(n.title||'').replace(/\n/g,'<br>')}</div>`;
else if(n.type==='shape')body=shape(n);
else if(n.type==='video')body=window.FWVideo?.nodeMarkup(n)||'';
else if(n.type==='image')body=imageMarkup(n);
else if(n.type==='frame'||n.type==='group')body=`<div class="fw-container-label">${window.FW.icon?.(n.type==='frame'?'frame':'group')||''} ${esc(n.title|| (n.type==='frame'?'新分区':'组合'))}</div>`;
else if(n.type==='stroke')body=`<svg viewBox="0 0 ${b.w} ${b.h}" preserveAspectRatio="none"><path d="${strokePath(n)}" fill="none" stroke="${esc(n.color||'#4e6357')}" stroke-width="${n.strokeWidth||3}" opacity="${n.opacity||1}" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
return`<div class="fw-node fw-${esc(n.type)} ${sel?'is-selected':''} ${affected?'fw-frame-'+affected:''}" data-node="${esc(n.id)}" ${n.type==='video'?`tabindex="0" role="button" aria-label="${esc(n.title||'视频')}，双击观看"`:''} style="${style}">${body}</div>`;}
function edgeHTML(e){const sel=selected().includes(e.id),{a,b}=endpoints(e),t=e.labelPosition??.5,{x,y}=edgePoint(e,t),c=esc(e.color||'#7c847b');return`<g data-edge="${esc(e.id)}" class="fw-edge ${sel?'is-selected':''}"><path class="fw-edge-hit" d="${path(e)}"/><path class="fw-edge-visible" d="${path(e)}" stroke="${c}" stroke-width="${e.width||4}" ${e.dashed?'stroke-dasharray="9 7"':''} marker-start="${marker(e.startMarker||'none')}" marker-end="${marker(e.endMarker||'arrow')}"/>${e.label?`<foreignObject x="${x-140}" y="${y-19}" width="280" height="100"><div xmlns="http://www.w3.org/1999/xhtml" class="fw-edge-label" style="color:${esc(e.labelColor||'#50594e')};font-size:${e.fontSize||16}px;font-weight:${e.bold?700:400}">${esc(e.label)}</div></foreignObject>`:''}</g>`;}
function marker(m){return m==='none'?'none':`url(#fw-marker-${m})`;}
function render(){if(!root||editing)return;syncGroups();syncAttachments();const v=S().viewport,sel=selected(),pure=sel.length&&sel.every(id=>node(id)?.type==='card')&&!S().suppressRaise;root.dataset.tool=S().tool||'select';root.style.backgroundPosition=`${v.x}px ${v.y}px`;root.style.backgroundSize=`${24*v.zoom}px ${24*v.zoom}px`;world.style.transform=`translate(${v.x}px,${v.y}px) scale(${v.zoom})`;world.innerHTML=`<svg class="fw-edges"><defs><marker id="fw-marker-arrow" viewBox="0 0 12 12" refX="11" refY="6" markerWidth="9" markerHeight="9" orient="auto-start-reverse"><path d="M2 1 L10 6 L2 11" fill="none" stroke="context-stroke" stroke-width="1.5"/></marker><marker id="fw-marker-triangle" viewBox="0 0 12 12" refX="10" refY="6" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M1 1 L11 6 L1 11 Z" fill="context-stroke"/></marker><marker id="fw-marker-dot" viewBox="0 0 12 12" refX="6" refY="6" markerWidth="5" markerHeight="5"><circle cx="6" cy="6" r="5" fill="context-stroke"/></marker><marker id="fw-marker-diamond" viewBox="0 0 12 12" refX="6" refY="6" markerWidth="6" markerHeight="6"><path d="M6 0 L12 6 L6 12 L0 6Z" fill="context-stroke"/></marker></defs>${P().edges.map(edgeHTML).join('')}${drag?.kind==='line'?`<path d="M${drag.start.x},${drag.start.y} L${drag.now.x},${drag.now.y}" fill="none" stroke="#ca5a39" stroke-width="3" stroke-dasharray="5 5"/>`:''}</svg>`+P().nodes.map((n,i)=>nodeHTML(n,n.type==='frame'?0:pure&&sel.includes(n.id)?P().nodes.length+i+5:i+1)).join('');
reflow();overlay.innerHTML='';const nodes=sel.map(node).filter(Boolean);if(nodes.length){const b=bounds(nodes),x=b.x*v.zoom+v.x,y=b.y*v.zoom+v.y,w=b.w*v.zoom,h=b.h*v.zoom;overlay.innerHTML=`<div class="fw-selection" style="left:${x}px;top:${y}px;width:${w}px;height:${h}px">${(nodes.length===1&&nodes[0].type==='video'?['nw','ne','se','sw']:nodes.length===1&&nodes[0].type==='text'?['nw','ne','e','se','sw','w']:['nw','n','ne','e','se','s','sw','w']).map(k=>`<i class="fw-handle ${k}" data-resize="${k}"></i>`).join('')}${nodes.length===1&&nodes[0].type!=='stroke'?['left','right','top','bottom'].map(s=>`<button title="从这里连线" class="fw-anchor ${s}" data-anchor="${s}" data-owner="${esc(nodes[0].id)}"></button>`).join(''):''}</div>`;}
if(sel.length===1&&edge(sel[0])){const e=edge(sel[0]),{a,b}=endpoints(e);overlay.innerHTML=['start','end'].map((k,i)=>{const p=i?b:a;return`<i class="fw-endpoint" data-endpoint="${k}" data-owner="${esc(e.id)}" style="left:${p.x*v.zoom+v.x}px;top:${p.y*v.zoom+v.y}px"></i>`;}).join('');}
if(drag?.kind==='marquee'){const b=drag.box;overlay.innerHTML+=`<div class="fw-marquee" style="left:${b.x*v.zoom+v.x}px;top:${b.y*v.zoom+v.y}px;width:${b.w*v.zoom}px;height:${b.h*v.zoom}px"></div>`;}
if(drag?.guides){for(const guide of drag.guides){const vertical=guide.axis==='x',value=guide.position*v.zoom+(vertical?v.x:v.y);overlay.innerHTML+=`<div class="fw-guide ${vertical?'vertical':'horizontal'}" style="${vertical?'left':'top'}:${value}px"></div>`;}}
if(drag?.frameTarget){const f=drag.frameTarget;overlay.innerHTML+=`<div class="fw-frame-target" style="left:${f.x*v.zoom+v.x}px;top:${f.y*v.zoom+v.y}px;width:${f.w*v.zoom}px;height:${f.h*v.zoom}px"></div>`;}
if(drag?.snap){const p=drag.snap.p;overlay.innerHTML+=`<span class="fw-snap" style="left:${p.x*v.zoom+v.x}px;top:${p.y*v.zoom+v.y}px"></span>`;}
if(crop){const b=crop.box,f=crop.full,sc=a=>({x:a.x*v.zoom+v.x,y:a.y*v.zoom+v.y,w:a.w*v.zoom,h:a.h*v.zoom}),q=sc(b),r=sc(f);overlay.innerHTML=`${[{x:r.x,y:r.y,w:r.w,h:q.y-r.y},{x:r.x,y:q.y+q.h,w:r.w,h:r.y+r.h-q.y-q.h},{x:r.x,y:q.y,w:q.x-r.x,h:q.h},{x:q.x+q.w,y:q.y,w:r.x+r.w-q.x-q.w,h:q.h}].map(a=>`<div class="fw-crop-shade" style="left:${a.x}px;top:${a.y}px;width:${a.w}px;height:${a.h}px"></div>`).join('')}<div class="fw-crop-box" data-crop="move" style="left:${q.x}px;top:${q.y}px;width:${q.w}px;height:${q.h}px">${['nw','n','ne','e','se','s','sw','w'].map(k=>`<i class="fw-handle ${k}" data-crop="${k}"></i>`).join('')}</div><div class="fw-crop-actions" style="left:${q.x}px;top:${q.y+q.h+16}px"><button data-crop-action="cancel">取消</button><button data-crop-action="apply">完成裁剪</button></div>`;}
root.dispatchEvent(new CustomEvent('fwcanvasrender',{bubbles:true,detail:{zoom:v.zoom}}));}
function setTool(tool,opts={}){finishEdit();S().tool=tool;options=opts;render();}
function attachmentCenter(id){
  const n=node(id);if(n)return {x:n.x+n.w/2,y:n.y+n.h/2};
  const e=edge(id);return e?edgePoint(e,.5):null;
}
function syncAttachments(){
  for(const n of P().nodes){if(!n.attachment)continue;const p=attachmentCenter(n.attachment.targetId);
    if(!p){delete n.attachment;continue;}
    n.x=p.x+n.attachment.offsetX;n.y=p.y+n.attachment.offsetY;
  }
}
function updateAttachmentOffset(n){if(!n.attachment)return;const p=attachmentCenter(n.attachment.targetId);if(p){n.attachment.offsetX=n.x-p.x;n.attachment.offsetY=n.y-p.y;}}
function attachTo(targetId,ids=selected(),releaseContainer=false){
  const target=node(targetId),point=attachmentCenter(targetId),sources=ids.map(node).filter(n=>n&&['text','shape','image','stroke'].includes(n.type));
  if(!point||(!edge(targetId)&&target?.type!=='card')||!sources.length)return false;
  if(sources.some(n=>n.parentId||n.groupId)&&!releaseContainer)return {requiresRelease:true};
  change('附着批注',()=>{for(const n of sources){n.parentId=null;n.groupId=null;n.attachment={targetId,offsetX:n.x-point.x,offsetY:n.y-point.y};}cleanupEmptyGroups();});return true;
}
function detachAttachments(ids=selected()){change('解除批注附着',()=>{ids.map(node).filter(Boolean).forEach(n=>delete n.attachment);});}
function beginAttachment(){setTool('attach',{annotationIds:selected().slice()});window.FW.toast('点击卡片或连线以附着批注；Esc 取消');}
function create(type,p,size){const n={id:uid(),type,x:p.x,y:p.y,w:size?.w|| (type==='card'?286:type==='text'?100:180),h:size?.h||(type==='card'?230:type==='text'?32:120),title:'',body:'',tags:[],color:type==='card'?'#fffdf8':type==='text'?'#343832':'#f1ede5',...options};if(type==='card')n.autoSize=true;if(type==='shape')n.shape=options.shape||'rounded';if(type==='frame'){n.w=size?.w||540;n.h=size?.h||350;n.title='分区 '+(P().nodes.filter(a=>a.type==='frame').length+1);n.color='transparent';}return n;}
function down(e){if(e.button!==0&&e.button!==1)return;if(e.target.closest('.fw-inline-tools,[data-video-retry]'))return;if(e.target.closest('input,textarea,[contenteditable=true]'))return;if(crop){const act=e.target.closest('[data-crop-action]');if(act){finishCrop(act.dataset.cropAction==='apply');return;}const h=e.target.closest('[data-crop]');if(h){drag={kind:'crop',handle:h.dataset.crop,start:position(e),original:{...crop.box}};e.preventDefault();root.setPointerCapture(e.pointerId);}return;}const p=position(e),target=e.target.closest('[data-node]'),edgeEl=e.target.closest('[data-edge]'),handle=e.target.closest('[data-resize]'),anchor=e.target.closest('[data-anchor]'),endpoint=e.target.closest('[data-endpoint]');finishEdit();pointer=p;const before=clone(P());
if(e.button===1||space||S().tool==='pan'){drag={kind:'pan',client:{x:e.clientX,y:e.clientY},view:clone(S().viewport)};}
else if(S().tool==='attach'){const id=target?.dataset.node||edgeEl?.dataset.edge,result=id?attachTo(id,options.annotationIds):false;if(result?.requiresRelease){const sources=options.annotationIds.slice();window.FW.dialog({title:'移出容器并附着？',text:'这次操作会将所选批注移出原分区或组合，再附着到此对象。批注内容和位置保持，可一起撤销。',confirm:'移出并附着',onConfirm:()=>{attachTo(id,sources,true);window.FW.setTool('select');}});}else if(result){window.FW.setTool('select');}return;}
else if(endpoint){drag={kind:'endpoint',id:endpoint.dataset.owner,end:endpoint.dataset.endpoint,before};}
else if(anchor||S().tool==='line'){let from=anchor?{id:anchor.dataset.owner,side:anchor.dataset.anchor,p:pointAt(node(anchor.dataset.owner),anchor.dataset.anchor)}:nearest(p);drag={kind:'line',from,start:from?.p||p,now:p,before};}
else if(handle&&selected().length){const ids=selected().length===1&&node(selected()[0])?.type==='frame'?new Set(selected()):descendants(selected());drag={kind:'resize',handle:handle.dataset.resize,start:p,box:bounds(selected().map(node).filter(Boolean)),original:clone(P().nodes.filter(n=>ids.has(n.id))),before};}
else if(['pen','highlighter'].includes(S().tool)){const n=create('stroke',p,{w:1,h:1});n.points=[{x:0,y:0}];n.color=options.color||'#8ca36b';n.strokeWidth=S().tool==='highlighter'?22:3;n.opacity=S().tool==='highlighter'?.3:1;P().nodes.push(n);drag={kind:'stroke',id:n.id,start:p,before,points:[p]};}
else if(S().tool==='frame'){const n=create('frame',p,{w:1,h:1});P().nodes.push(n);select([n.id]);drag={kind:'frame',id:n.id,start:p,before};}
else if(['card','text','shape'].includes(S().tool)){const type=S().tool,n=create(type,p);P().nodes.push(n);updateFrames([n.id]);select([n.id]);S().tool='select';if(type==='text'||type==='card'){e.preventDefault();editText(n.id,before);return;}save('新建'+({card:'卡片',shape:'形状',frame:'分区'}[type]),before);return;}
else if(target){const previousSelection=selected().slice();let n=node(target.dataset.node),id=n.id;if(n.groupId&&!selected().includes(n.id)&&!selected().some(sid=>node(sid)?.groupId===n.groupId)){id=n.groupId;}if(e.shiftKey){select(selected().includes(id)?selected().filter(x=>x!==id):[...selected(),id]);}else if(!selected().includes(id))select([id]);const ids=descendants(selected());drag={kind:'move',start:p,original:clone(P().nodes.filter(n=>ids.has(n.id))),edges:clone(P().edges.filter(e=>ids.has(e.id))),before,moved:false,targetId:n.id,titleHit:!!e.target.closest('h3'),memberClick:n.groupId&&previousSelection.includes(n.groupId)?n.id:null};}
else if(edgeEl){const id=edgeEl.dataset.edge;if(e.shiftKey)select(selected().includes(id)?selected().filter(x=>x!==id):[...selected(),id]);else if(!selected().includes(id))select([id]);drag=e.target.closest('.fw-edge-label')?{kind:'label',id,targetId:id,start:p,moved:false,before}:{kind:'move',targetId:id,start:p,original:[],edges:clone(P().edges.filter(e=>selected().includes(e.id))),before,moved:false};}
else{drag={kind:'marquee',start:p,box:{...p,w:0,h:0},previous:e.shiftKey?selected().slice():[]};if(!e.shiftKey)select([]);}
e.preventDefault();root.setPointerCapture(e.pointerId);render();}
function move(e){pointer=position(e);if(!drag)return;const p=pointer,v=S().viewport,dx=p.x-(drag.start?.x||0),dy=p.y-(drag.start?.y||0);
if(drag.kind==='crop'){const f=crop.full,b=drag.original,k=drag.handle;let x=b.x,y=b.y,w=b.w,h=b.h;if(k==='move'){x=Math.max(f.x,Math.min(f.x+f.w-w,b.x+dx));y=Math.max(f.y,Math.min(f.y+f.h-h,b.y+dy));}else{if(k.includes('e'))w=Math.max(24,Math.min(f.x+f.w-b.x,b.w+dx));if(k.includes('s'))h=Math.max(24,Math.min(f.y+f.h-b.y,b.h+dy));if(k.includes('w')){x=Math.max(f.x,Math.min(b.x+b.w-24,b.x+dx));w=b.x+b.w-x;}if(k.includes('n')){y=Math.max(f.y,Math.min(b.y+b.h-24,b.y+dy));h=b.y+b.h-y;}}crop.box={x,y,w,h};}
if(drag.kind==='frame'){Object.assign(node(drag.id),{x:Math.min(p.x,drag.start.x),y:Math.min(p.y,drag.start.y),w:Math.max(1,Math.abs(dx)),h:Math.max(1,Math.abs(dy))});}
if(drag.kind==='pan'){v.x=drag.view.x+e.clientX-drag.client.x;v.y=drag.view.y+e.clientY-drag.client.y;}
if(drag.kind==='marquee'){drag.box={x:Math.min(p.x,drag.start.x),y:Math.min(p.y,drag.start.y),w:Math.abs(dx),h:Math.abs(dy)};const b=drag.box;S().suppressRaise=false;S().selected=[...new Set([...drag.previous,...P().nodes.filter(n=>n.type!=='group'&&n.x>=b.x&&n.y>=b.y&&n.x+n.w<=b.x+b.w&&n.y+n.h<=b.y+b.h).map(n=>n.groupId||n.id)])];}
if(drag.kind==='move'){if(Math.hypot(dx,dy)<3/v.zoom&&!drag.moved)return;drag.moved=true;let mx=dx,my=dy;drag.guides=[];if(S().snap!==false&&!e.altKey&&drag.original.length){const aligned=alignmentMove(drag.original,dx,dy);mx=aligned.dx;my=aligned.dy;drag.guides=aligned.guides;}drag.original.forEach(n=>{const a=node(n.id);a.x=n.x+mx;a.y=n.y+my;});drag.original.forEach(n=>updateAttachmentOffset(node(n.id)));drag.frameTarget=drag.original.some(n=>!n.groupId)?frameAt(p,descendants(drag.original.map(n=>n.id))):null;drag.edges.forEach(e=>{const a=edge(e.id);if(!a.from)a.start={x:e.start.x+mx,y:e.start.y+my};if(!a.to)a.end={x:e.end.x+mx,y:e.end.y+my};});}
if(drag.kind==='resize'){const b=drag.box,k=drag.handle;let x=b.x,y=b.y,w=b.w,h=b.h;if(k.includes('e'))w=Math.max(40,b.w+dx);if(k.includes('s'))h=Math.max(30,b.h+dy);if(k.includes('w')){w=Math.max(40,b.w-dx);x=b.x+b.w-w;}if(k.includes('n')){h=Math.max(30,b.h-dy);y=b.y+b.h-h;}const one=drag.original.length===1?drag.original[0]:null;if((!one||['image','text','video'].includes(one.type))&&k.length===2){const sx=k.includes('w')?-dx:dx,sy=k.includes('n')?-dy:dy,scale=Math.max(24/b.w,24/b.h,1+(sx*b.w+sy*b.h)/(b.w*b.w+b.h*b.h));w=b.w*scale;h=b.h*scale;if(k.includes('w'))x=b.x+b.w-w;if(k.includes('n'))y=b.y+b.h-h;}if(one?.type==='video'){const mediaH=Math.max(1,b.h-34),sx=k.includes('w')?-dx:dx,sy=k.includes('n')?-dy:dy,scale=Math.max(40/b.w,30/mediaH,1+(sx*b.w+sy*mediaH)/(b.w*b.w+mediaH*mediaH));w=b.w*scale;h=mediaH*scale+34;if(k.includes('w'))x=b.x+b.w-w;if(k.includes('n'))y=b.y+b.h-h;}drag.original.forEach(n=>{const a=node(n.id);if(one?.type==='frame'&&n.id!==one.id)return;a.x=x+(n.x-b.x)*w/b.w;a.y=y+(n.y-b.y)*h/b.h;a.w=Math.max(24,n.w*w/b.w);a.h=Math.max(24,n.h*h/b.h);if(n.type==='video'&&(a.w!==n.w||a.h!==n.h))a.videoSizeManual=true;if(n.type==='card')a.manualHeight=a.h;if(n.type==='stroke')a.points=(n.points||[]).map(p=>({x:p.x*w/b.w,y:p.y*h/b.h}));updateAttachmentOffset(a);if(n.type==='text'){a.manualWidth=true;if(k.length===2)a.fontSize=(n.fontSize||18)*w/b.w;}});}
if(drag.kind==='label'){if(Math.hypot(dx,dy)>3/v.zoom)drag.moved=true;const e=edge(drag.id);e.labelPosition=nearestEdgePosition(e,p);}
if(drag.kind==='line'){drag.snap=nearest(p,drag.from?.id);drag.now=drag.snap?.p||p;}
if(drag.kind==='endpoint'){const a=edge(drag.id),other=drag.end==='start'?a.to:a.from;drag.snap=nearest(p,other);if(drag.snap?.blockedSelf){render();return;}if(drag.end==='start'){a.from=drag.snap?.id||null;a.fromSide=drag.snap?.side;a.start=drag.snap?.p||p;}else{a.to=drag.snap?.id||null;a.toSide=drag.snap?.side;a.end=drag.snap?.p||p;}}
if(drag.kind==='stroke'){drag.points.push(p);const n=node(drag.id),xs=drag.points.map(p=>p.x),ys=drag.points.map(p=>p.y);n.x=Math.min(...xs);n.y=Math.min(...ys);n.w=Math.max(1,Math.max(...xs)-n.x);n.h=Math.max(1,Math.max(...ys)-n.y);n.points=drag.points.map(p=>({x:p.x-n.x,y:p.y-n.y}));}render();}
// Container membership changes only at the end of a deliberate operation.
function contains(a,b){return b.x>=a.x&&b.y>=a.y&&b.x+b.w<=a.x+a.w&&b.y+b.h<=a.y+a.h;}
function frameAt(p,excluded=new Set()){
  const frames=P().nodes.filter(f=>f.type==='frame'&&!excluded.has(f.id)&&p.x>=f.x&&p.x<=f.x+f.w&&p.y>=f.y&&p.y<=f.y+f.h);
  frames.sort((a,b)=>descendants([a.id]).has(b.id)?1:descendants([b.id]).has(a.id)?-1:P().nodes.indexOf(b)-P().nodes.indexOf(a));
  return frames[0]||null;
}
function updateFrames(ids,point){
  const moving=new Set(ids),excluded=descendants(ids);
  for(const id of ids){
    const n=node(id);
    if(!n||n.groupId||n.attachment||moving.has(n.parentId))continue;
    const p=point||{x:n.x+n.w/2,y:n.y+n.h/2};
    n.parentId=frameAt(p,excluded)?.id||null;
  }
}
function frameResizeEffect(n){
  if(drag?.kind!=='resize'||n.groupId)return '';
  const f=drag.original.length===1&&drag.original[0].type==='frame'?node(drag.original[0].id):null;
  if(!f||f.id===n.id)return '';
  if(n.parentId===f.id&&!overlap(f,n))return 'release';
  if(n.parentId!==f.id&&(!n.parentId||n.parentId===f.parentId)&&contains(f,n)&&!descendants([n.id]).has(f.id))return 'adopt';
  return '';
}
function encloseFrame(id,resize=false){
  const f=node(id);if(!f)return;
  syncGroups();
  const forbidden=new Set([id]);let ancestor=node(f.parentId);
  while(ancestor&&!forbidden.has(ancestor.id)){forbidden.add(ancestor.id);ancestor=node(ancestor.parentId);}
  const candidates=P().nodes.filter(n=>!forbidden.has(n.id)&&!n.groupId&&!n.attachment);
  // Process containers before descendants so existing child structures stay intact.
  candidates.sort((a,b)=>isContainer(b)-isContainer(a));
  for(const n of candidates){
    if(n.parentId===id){if(resize&&!overlap(f,n))n.parentId=null;continue;}
    if(n.parentId&&descendants([id]).has(n.parentId))continue;
    if(contains(f,n)&&(!n.parentId||n.parentId===f.parentId))n.parentId=id;
  }
}
function frameFromSelection(){
  const members=selected().map(node).filter(Boolean);
  if(!members.length||members.some(n=>n.groupId)||new Set(members.map(n=>n.parentId||null)).size!==1)return false;
  change('从选区创建分区',()=>{
    const b=bounds(members),f=create('frame',{x:b.x-24,y:b.y-40},{w:b.w+48,h:b.h+64});
    f.parentId=members[0].parentId||null;P().nodes.push(f);members.forEach(n=>n.parentId=f.id);S().selected=[f.id];
  });return true;
}
function cardPreviewLayout(height,bodyTop,bottom,lineHeight){
  const available=Math.max(0,height-bodyTop-bottom);
  const lines=Math.max(0,Math.floor((available+.001)/lineHeight));
  return {lines,height:lines*lineHeight};
}
// Measure rendered type rather than counting characters: CJK and styled runs wrap differently.
function reflowNode(n,el){
  if(!el)return;
  if(n.type==='card'){
    if(n.manualHeight==null&&!n.autoSize)n.manualHeight=n.h;
    const title=el.querySelector('h3'),tags=el.querySelector('.fw-card-tags');
    const required=Math.ceil((title?.offsetHeight||54)+13+(tags?tags.offsetHeight+24:16));
    const floor=n.manualHeight??((n.body||'').replace(/<[^>]*>/g,'').trim()?230:0);n.h=Math.max(floor,required);el.style.height=n.h+'px';
    const body=el.querySelector('.fw-card-body');
    if(body){
      const computed=typeof window.getComputedStyle==='function'?window.getComputedStyle(body):null;
      const cardStyle=typeof window.getComputedStyle==='function'?window.getComputedStyle(el):null;
      const lineHeight=parseFloat(computed?.lineHeight)||23.4;
      // offsetTop is in canvas coordinates, unaffected by viewport scale.
      const bodyTop=Number.isFinite(body.offsetTop)?body.offsetTop:(title?.offsetHeight||54)+13;
      const border=parseFloat(cardStyle?.borderBottomWidth)||0;
      const bottom=tags?Math.max(tags.offsetHeight+24,Number.isFinite(tags.offsetTop)?n.h-tags.offsetTop+8:0):parseFloat(cardStyle?.paddingBottom)||24;
      const preview=cardPreviewLayout(n.h,bodyTop,bottom+border,lineHeight);
      body.style.maxHeight=preview.height+'px';
      body.style.webkitLineClamp=preview.lines?String(preview.lines):'unset';
      body.dataset&&(body.dataset.previewLines=String(preview.lines));
    }
  }else if(n.type==='text'){
    const text=el.querySelector('.fw-text-body');if(!text)return;
    if(!n.manualWidth){el.style.width='max-content';el.style.maxWidth='320px';n.w=Math.max(24,Math.min(320,Math.ceil(text.getBoundingClientRect().width/(S().viewport.zoom||1))));}
    el.style.width=n.w+'px';n.h=Math.max((n.fontSize||18)*1.5,text.scrollHeight);el.style.height=n.h+'px';
  }
}
function reflow(){if(!world)return;P().nodes.forEach(n=>reflowNode(n,world.querySelector(`[data-node="${CSS.escape(n.id)}"]`)));syncGroups();syncAttachments();P().nodes.filter(n=>n.attachment).forEach(n=>{const el=world.querySelector(`[data-node="${CSS.escape(n.id)}"]`);if(el){el.style.left=n.x+'px';el.style.top=n.y+'px';}});}
function activate(id,title=false){const n=node(id),ed=edge(id);select([id]);if(n?.type==='card'){if(title)editText(n.id);else window.FW.openEditor(n.id);}else if(n?.type==='video')window.FW.openVideo?.(n.id);else if(n?.type==='image')window.FW.openImage?.(n.id);else if(n&&n.type!=='stroke')editText(n.id);else if(ed)editLabel(ed.id);}
function up(e){if(!drag)return;const d=drag;drag=null;if(['line','endpoint'].includes(d.kind)&&d.snap?.blockedSelf){if(d.kind==='endpoint'){const previous=d.before.edges.find(a=>a.id===d.id);if(previous)Object.assign(edge(d.id),clone(previous));}window.FW.toast('连线的两端不能连接同一个对象');render();return;}if(d.targetId&&!d.moved){const now=Date.now();if(lastClick&&lastClick.id===d.targetId&&now-lastClick.time<420&&Math.hypot(e.clientX-lastClick.x,e.clientY-lastClick.y)<8){lastClick=null;activate(d.targetId,d.titleHit);return;}lastClick={id:d.targetId,time:now,x:e.clientX,y:e.clientY};}else if(d.moved)lastClick=null;if(d.kind==='frame'){const n=node(d.id);if(n.w<8||n.h<8){P().nodes=P().nodes.filter(a=>a.id!==d.id);select([]);}else{const excluded=new Set(P().nodes.filter(f=>f.id===n.id||f.type==='frame'&&!contains(f,n)).map(f=>f.id));n.parentId=frameAt({x:n.x+n.w/2,y:n.y+n.h/2},excluded)?.id||null;encloseFrame(n.id);save('创建分区',d.before);}S().tool='select';}else if(d.kind==='line'&&Math.hypot(d.now.x-d.start.x,d.now.y-d.start.y)>8){const ed={id:uid(),from:d.from?.id||null,to:d.snap?.id||null,fromSide:d.from?.side,toSide:d.snap?.side,start:d.start,end:d.now,style:'straight',label:'',width:4};P().edges.push(ed);S().tool='select';select([ed.id]);save('绘制连线',d.before);}else if(d.kind==='move'&&d.moved){updateFrames(d.original.map(n=>n.id),pointer);syncGroups();save('移动对象',d.before);}else if(d.kind==='move'&&!d.moved&&d.memberClick){select([d.memberClick]);}else if(['resize','endpoint','stroke','label'].includes(d.kind)){if(d.kind==='resize'){d.original.filter(n=>n.type==='frame').forEach(n=>encloseFrame(n.id,true));reflow();}save(d.kind==='resize'?'调整尺寸':d.kind==='endpoint'?'重接端点':d.kind==='label'?'移动连线文字':'绘制笔迹',d.before);}render();window.FW.render();}
function editText(id,before){finishEdit();const n=node(id);if(!n)return;select([id]);render();const el=world.querySelector(`[data-node="${CSS.escape(id)}"]`),text=el?.querySelector(n.type==='text'?'.fw-text-body':n.type==='shape'?'.fw-shape-text':n.type==='card'?'h3':'.fw-container-label');if(!text)return;editing={id,before:before||clone(P()),el:text};if(n.type==='card'&&!n.title)text.innerText='';text.contentEditable='true';text.setAttribute('role','textbox');text.setAttribute('aria-label',n.type==='card'?'卡片标题':'编辑文字');text.setAttribute('aria-multiline','true');text.setAttribute('data-placeholder',n.type==='card'?'输入卡片标题…':'输入文字…');text.style.userSelect='text';text.focus();const r=document.createRange();r.selectNodeContents(text);const s=window.getSelection();s.removeAllRanges();s.addRange(r);requestAnimationFrame(()=>{if(editing?.el===text&&text.isConnected)text.focus({preventScroll:true});});if(n.type==='text'){const bar=document.createElement('div'),v=S().viewport;bar.className='fw-inline-tools';bar.style.left=(n.x*v.zoom+v.x)+'px';bar.style.top=(n.y*v.zoom+v.y-44)+'px';bar.innerHTML='<button type="button" title="加粗所选文字"><b>B</b></button><label title="文字颜色"><span>A</span><input type="color" value="#343832"></label><span class="fw-inline-hint">Esc 完成</span>';root.append(bar);editing.bar=bar;let saved=null;bar.onpointerdown=ev=>{const sel=window.getSelection();if(sel.rangeCount)saved=sel.getRangeAt(0).cloneRange();if(ev.target.closest('button'))ev.preventDefault();};bar.querySelector('button').onclick=()=>{text.focus();if(saved){const sel=window.getSelection();sel.removeAllRanges();sel.addRange(saved);}document.execCommand('bold');};bar.querySelector('input').oninput=ev=>{text.focus();if(saved){const sel=window.getSelection();sel.removeAllRanges();sel.addRange(saved);}document.execCommand('foreColor',false,ev.target.value);};}root.dispatchEvent(new CustomEvent('fwcanvasrender',{bubbles:true}));text.addEventListener('paste',e=>{e.preventDefault();document.execCommand('insertText',false,e.clipboardData.getData('text/plain'));});text.addEventListener('input',()=>{n.title=text.innerText;if(n.type==='text')n.html=text.innerHTML;window.FW.save?.();reflowNode(n,el);});text.addEventListener('keydown',e=>{if(!e.isComposing&&(e.key==='Escape'||(n.type==='card'&&e.key==='Enter'&&!e.shiftKey)||((e.metaKey||e.ctrlKey)&&e.key==='Enter'))){e.preventDefault();e.stopPropagation();finishEdit();}});}
function finishEdit(){if(!editing)return;const d=editing,n=node(d.id);d.bar?.remove();editing=null;if(n){n.title=d.el.innerText;if(n.type==='text'){n.html=d.el.innerHTML;n.h=Math.max(28,d.el.scrollHeight);if(!n.title.trim()){P().nodes=P().nodes.filter(a=>a.id!==n.id);P().edges=P().edges.filter(e=>e.from!==n.id&&e.to!==n.id);S().selected=selected().filter(id=>id!==n.id);}}save('编辑文字',d.before);}S().tool='select';render();}
function editLabel(id){const e=edge(id);if(!e)return;const before=clone(P()),point=edgePoint(e),a=point,b=point,v=S().viewport;const input=document.createElement('textarea');input.className='fw-label-editor';input.value=e.label||'';input.style.cssText=`left:${((a.x+b.x)/2)*v.zoom+v.x-140}px;top:${((a.y+b.y)/2)*v.zoom+v.y-25}px`;root.append(input);input.focus();let done=false;const finish=()=>{if(done)return;done=true;e.label=input.value;input.remove();save('编辑连线文字',before);};input.addEventListener('blur',finish);input.addEventListener('keydown',ev=>{if(!ev.isComposing&&(ev.key==='Escape'||((ev.metaKey||ev.ctrlKey)&&ev.key==='Enter'))){ev.preventDefault();ev.stopPropagation();finish();}});}
function freeContainerEnds(ids){P().edges.forEach(e=>{const {a,b}=endpoints(e);if(ids.has(e.from)){e.from=null;e.start=a;delete e.fromSide;}if(ids.has(e.to)){e.to=null;e.end=b;delete e.toSide;}});}
function cleanupEmptyGroups(){
  const empty=new Set(P().nodes.filter(n=>n.type==='group'&&!P().nodes.some(m=>m.groupId===n.id)).map(n=>n.id));
  freeContainerEnds(empty);P().nodes=P().nodes.filter(n=>!empty.has(n.id));
}
function remove(){finishEdit();const chosen=new Set(selected()),containers=new Set(P().nodes.filter(n=>chosen.has(n.id)&&n.type==='frame').map(n=>n.id)),ids=new Set(chosen);P().nodes.filter(n=>chosen.has(n.id)&&n.type==='group').forEach(g=>descendants([g.id]).forEach(id=>ids.add(id)));change('删除对象',()=>{freeContainerEnds(containers);P().edges=P().edges.filter(e=>!ids.has(e.id)&&!ids.has(e.from)&&!ids.has(e.to));P().nodes=P().nodes.filter(n=>!ids.has(n.id));P().nodes.forEach(n=>{if(n.attachment&&(ids.has(n.attachment.targetId)||!attachmentCenter(n.attachment.targetId)))delete n.attachment;if(ids.has(n.parentId))n.parentId=null;if(ids.has(n.groupId))n.groupId=null;});cleanupEmptyGroups();S().selected=[];});}
function copy(){finishEdit();const ids=descendants(selected());clipboard={nodes:clone(P().nodes.filter(n=>ids.has(n.id))),edges:clone(P().edges.filter(e=>ids.has(e.id)||(ids.has(e.from)&&ids.has(e.to)))),tags:clone(P().tags||[])};return clone(clipboard);}
function paste(data=clipboard,at){if(!data)return;const d=clone(data),map=new Map(d.nodes.map(n=>[n.id,uid()])),b=bounds(d.nodes),p=at||pointer||center(),dx=p.x-b.x-b.w/2,dy=p.y-b.y-b.h/2;change('粘贴对象',()=>{d.nodes.forEach(n=>{delete n.attachment;n.id=map.get(n.id);n.x+=dx;n.y+=dy;n.groupId=map.get(n.groupId)||null;n.parentId=map.get(n.parentId)||null;});d.edges.forEach(e=>{const old=edge(e.id),pos=old?endpoints(old):{a:e.start,b:e.end};e.id=uid();e.from=map.get(e.from)||null;e.to=map.get(e.to)||null;e.start={x:(pos.a?.x||0)+dx,y:(pos.a?.y||0)+dy};e.end={x:(pos.b?.x||100)+dx,y:(pos.b?.y||100)+dy};});for(const n of d.nodes)n.tags=(n.tags||[]).map(tid=>{const t=d.tags?.find(t=>t.id===tid);if(!t)return tid;let found=P().tags.find(a=>a.name.toLocaleLowerCase()===t.name.toLocaleLowerCase());if(!found){found={...t,id:uid()};P().tags.push(found);}return found.id;});P().nodes.push(...d.nodes);updateFrames(d.nodes.map(n=>n.id));P().edges.push(...d.edges);S().selected=[...d.nodes.filter(n=>!n.groupId).map(n=>n.id),...d.edges.filter(e=>!e.from&&!e.to).map(e=>e.id)];});}
function duplicate(){const old=clipboard;const d=copy(),b=bounds(d.nodes);paste(d,{x:b.x+b.w/2+24,y:b.y+b.h/2+24});clipboard=old;}
function group(){const ids=descendants(selected()),members=P().nodes.filter(n=>ids.has(n.id)&&n.type!=='group');if(members.some(n=>n.type==='frame')){window.FW.toast('分区不能加入普通组合');return;}if(members.length<2)return;change('组合对象',()=>{const groups=new Set(P().nodes.filter(n=>ids.has(n.id)&&n.type==='group').map(n=>n.id));freeContainerEnds(groups);P().nodes=P().nodes.filter(n=>!groups.has(n.id));const b=bounds(members),parents=new Set(members.map(n=>n.parentId||null)),g={id:uid(),type:'group',title:'组合',...b,parentId:parents.size===1?members[0].parentId||null:null};members.forEach(n=>{n.groupId=g.id;n.parentId=null;});P().nodes.unshift(g);cleanupEmptyGroups();syncGroups();S().selected=[g.id];});}
function ungroup(){const ids=new Set(selected().filter(id=>node(id)?.type==='group'));if(!ids.size)return;change('取消组合',()=>{freeContainerEnds(ids);const members=P().nodes.filter(n=>ids.has(n.groupId));members.forEach(n=>{n.parentId=node(n.groupId)?.parentId||null;n.groupId=null;});P().nodes=P().nodes.filter(n=>!ids.has(n.id));S().selected=members.map(n=>n.id);});}
function removeFromGroup(){change('移出组合',()=>{selected().map(node).filter(Boolean).forEach(n=>{n.parentId=node(n.groupId)?.parentId||null;n.groupId=null;});cleanupEmptyGroups();});}
function overlap(a,b){return a.x<b.x+b.w&&a.x+a.w>b.x&&a.y<b.y+b.h&&a.y+a.h>b.y;}
function layerOrder(action){
  const ids=descendants(selected()),ns=P().nodes;
  if(action==='front')return [...ns.filter(n=>!ids.has(n.id)),...ns.filter(n=>ids.has(n.id))];
  if(action==='back')return [...ns.filter(n=>ids.has(n.id)),...ns.filter(n=>!ids.has(n.id))];
  // Assign insertion gaps among unselected objects, then enforce selected order.
  const forward=action==='forward',rest=ns.filter(n=>!ids.has(n.id)),chosen=ns.filter(n=>ids.has(n.id));
  const gaps=chosen.map(n=>{
    const i=ns.indexOf(n);let gap=ns.slice(0,i).filter(a=>!ids.has(a.id)).length;
    for(let j=i+(forward?1:-1);j>=0&&j<ns.length;j+=forward?1:-1){
      if(!ids.has(ns[j].id)&&!isContainer(ns[j])&&overlap(n,ns[j])){gap=rest.indexOf(ns[j])+(forward?1:0);break;}
    }return gap;
  });
  if(forward){for(let i=1;i<gaps.length;i++)gaps[i]=Math.max(gaps[i],gaps[i-1]);}
  else{for(let i=gaps.length-2;i>=0;i--)gaps[i]=Math.min(gaps[i],gaps[i+1]);}
  const result=[];for(let gap=0;gap<=rest.length;gap++){chosen.forEach((n,i)=>{if(gaps[i]===gap)result.push(n);});if(gap<rest.length)result.push(rest[gap]);}return result;
}
function canSetLayer(action){return layerOrder(action).some((n,i)=>n!==P().nodes[i]);}
function setLayer(action){change('调整层级',()=>{P().nodes=layerOrder(action);S().suppressRaise=true;});}
function fit(){if(!P().nodes.length)return;const b=bounds(),z=Math.min(1.25,Math.max(.12,Math.min((root.clientWidth-140)/Math.max(1,b.w),(root.clientHeight-140)/Math.max(1,b.h))));S().viewport={x:root.clientWidth/2-(b.x+b.w/2)*z,y:root.clientHeight/2-(b.y+b.h/2)*z,zoom:z};render();}
function zoom(delta,point){const v=S().viewport,p=point||{x:root.clientWidth/2,y:root.clientHeight/2},z=Math.max(.15,Math.min(3,v.zoom*delta));v.x=p.x-(p.x-v.x)*z/v.zoom;v.y=p.y-(p.y-v.y)*z/v.zoom;v.zoom=z;render();}
function centerOn(id){const n=node(id);if(!n)return;const v=S().viewport;v.x=root.clientWidth/2-(n.x+n.w/2)*v.zoom;v.y=root.clientHeight/2-(n.y+n.h/2)*v.zoom;select([id]);render();}
function beginCrop(id=selected()[0]){finishEdit();const n=node(id);if(n?.type!=='image')return;const c=n.crop||{x:0,y:0,w:1,h:1},w=n.w/c.w,h=n.h/c.h;crop={id,before:clone(P()),full:{x:n.x-c.x*w,y:n.y-c.y*h,w,h},box:rect(n)};render();}
function finishCrop(apply){if(!crop)return;const c=crop;crop=null;drag=null;if(apply){const n=node(c.id),f=c.full,b=c.box;n.crop={x:(b.x-f.x)/f.w,y:(b.y-f.y)/f.h,w:b.w/f.w,h:b.h/f.h};Object.assign(n,b);save('裁剪图片',c.before);}render();}
function restoreImage(id=selected()[0]){const n=node(id);if(n?.type!=='image'||!n.crop)return;change('恢复完整图片',()=>{const c=n.crop,w=n.w/c.w,h=n.h/c.h;n.x-=c.x*w;n.y-=c.y*h;n.w=w;n.h=h;delete n.crop;});}
function addImage(file){if(!file?.type.startsWith('image/'))return;const projectId=P().id;const r=new FileReader();r.onload=()=>{const img=new Image();img.onload=()=>{if(P().id!==projectId){window.FW.toast('项目已切换，请重新添加图片');return;}const v=S().viewport,scale=Math.min(1,root.clientWidth*.6/v.zoom/img.width,root.clientHeight*.6/v.zoom/img.height),p=pointer||center(),n=create('image',p,{w:img.width*scale,h:img.height*scale});n.src=r.result;n.x-=n.w/2;n.y-=n.h/2;change('添加图片',()=>{P().nodes.push(n);updateFrames([n.id]);S().selected=[n.id];});};img.src=r.result;};r.readAsDataURL(file);}
function mount(el){root=el;root.classList.add('fw-canvas');root.tabIndex=0;root.innerHTML='<div class="fw-world"></div><div class="fw-overlay"></div>';world=root.firstChild;overlay=root.lastChild;root.addEventListener('pointerdown',down);root.addEventListener('pointermove',move);root.addEventListener('pointerup',up);root.addEventListener('pointercancel',()=>{if(drag?.before)Object.assign(P(),drag.before);drag=null;render();});root.addEventListener('dblclick',e=>e.preventDefault());root.addEventListener('wheel',e=>{if(e.target.closest('[contenteditable],textarea'))return;e.preventDefault();if(e.ctrlKey||e.metaKey){const b=root.getBoundingClientRect();zoom(Math.exp(-e.deltaY*.005),{x:e.clientX-b.left,y:e.clientY-b.top});}else{S().viewport.x-=e.deltaX;S().viewport.y-=e.deltaY;render();}},{passive:false});window.addEventListener('keydown',e=>{if(crop){if(e.key==='Escape'||e.key==='Enter'){e.preventDefault();e.stopImmediatePropagation();finishCrop(e.key==='Enter');}return;}if(e.target.closest('input,textarea,select,[contenteditable=true],#popoverHost,.popover')||document.querySelector('#modalHost:not(:empty),[role=dialog]'))return;if(e.code==='Space'){space=true;e.preventDefault();root.classList.add('is-panning');}if(e.key==='Escape'){if(drag){if(drag.before)Object.assign(P(),drag.before);drag=null;render();return;}select([]);setTool('select');}});window.addEventListener('keyup',e=>{if(e.code==='Space'){space=false;root.classList.remove('is-panning');}});root.addEventListener('dragover',e=>e.preventDefault());root.addEventListener('drop',e=>{e.preventDefault();pointer=position(e);[...e.dataTransfer.files].forEach(addImage);});render();}
window.FWCanvas={mount,render,setTool,fit,zoom,duplicate,remove,group,ungroup,bounds,position,editText,finishEdit,editLabel,copy,paste,removeFromGroup,endpoints,centerOn,setLayer,addImage,center,beginCrop,restoreImage,finishCrop,imageMarkup,attachTo,detachAttachments,beginAttachment,syncAttachments,edgePoint,nearestEdgePosition,alignmentMove,reflow,frameFromSelection,updateFrames,encloseFrame,frameAt,canSetLayer,layerOrder,isEditing:()=>!!editing,isCropping:()=>!!crop};
})();
