/* Forkwise R2 recovery rebuild: reconstructed from the preserved R1 baseline.
   This is not a byte-for-byte recovery of the lost R2 object controls.
   Native clipboard ownership lives exclusively in clipboard.js. */
(() => {
'use strict';
const F=()=>window.FW, C=()=>window.FWCanvas, P=()=>F().project(), S=()=>F().state;
const $=id=>document.getElementById(id), esc=value=>F().escape(String(value??'')), icon=name=>F().icon(name);
const markerOptions=[['none','无'],['arrow','箭头'],['triangle','三角箭头'],['dot','圆点'],['diamond','菱形']];
const shapeOptions=[['rectangle','矩形'],['rounded','圆角矩形'],['ellipse','椭圆'],['diamond','菱形'],['triangle','三角形']];
let bar, properties=null, initialized=false, returnAction='style';
function button(name,title,action){return `<button type="button" data-action="${action}" title="${esc(title)}" aria-label="${esc(title)}">${icon(name)}</button>`;}
function findNode(id,project=P()){return project.nodes.find(n=>n.id===id);}
function chosen(ids=S().selected,project=P()){const set=new Set(ids);return {nodes:project.nodes.filter(n=>set.has(n.id)),edges:project.edges.filter(n=>set.has(n.id))};}
function selectionKey(ids=S().selected){return [...ids].sort().join('|');}
function focusCanvas(){ $('canvasEngine')?.focus({preventScroll:true}); }
function closeProperties(restoreFocus=false){
  const action=properties?.returnAction||returnAction;
  properties=null;
  F().closePopover();
  if(restoreFocus){const target=bar?.querySelector(`[data-action="${action}"]`);if(target&&!bar.hidden)target.focus({preventScroll:true});else focusCanvas();}
}
function blocked(ev){return C().isCropping?.()||C().isEditing?.()||ev.target?.closest?.('input,textarea,select,[contenteditable="true"],#popoverHost,.popover,#modalHost,.fw-dialog-backdrop,[role="dialog"]')||$('modalHost')?.children.length>0||document.querySelector('.fw-dialog-backdrop,[role="dialog"]');}
function key(ev){
  if(ev.isComposing||ev.defaultPrevented||blocked(ev))return;
  const mod=ev.ctrlKey||ev.metaKey;
  if(ev.key==='Delete'||ev.key==='Backspace'){ev.preventDefault();C().remove();}
  else if(mod&&ev.key.toLowerCase()==='g'){ev.preventDefault();ev.shiftKey?C().ungroup():C().group();}
}
function init(){
  if(initialized)return;initialized=true;
  bar=document.createElement('div');bar.id='objectBar';bar.className='object-bar';bar.setAttribute('role','toolbar');bar.setAttribute('aria-label','所选对象工具');document.body.append(bar);
  document.addEventListener('fwcanvasrender',refresh);document.addEventListener('keydown',key);
  // Stop at the host before document/window canvas shortcuts; keep native input,
  // select, button and Tab behavior, and let IME composition finish normally.
  $('popoverHost')?.addEventListener('keydown',ev=>{
    ev.stopPropagation();
    if(!ev.isComposing&&ev.key==='Escape'){ev.preventDefault();closeProperties(true);}
  });
  F().openImage=openImage;refresh();
}
function selectionBounds(nodes,edges){
  const boxes=nodes.map(n=>({x:n.x||0,y:n.y||0,w:n.w||0,h:n.h||0}));
  edges.forEach(ed=>{const {a,b}=C().endpoints(ed);boxes.push({x:Math.min(a.x,b.x),y:Math.min(a.y,b.y),w:Math.abs(a.x-b.x),h:Math.abs(a.y-b.y)});});
  if(!boxes.length)return null;
  const x=Math.min(...boxes.map(b=>b.x)),y=Math.min(...boxes.map(b=>b.y));
  return {x,y,w:Math.max(...boxes.map(b=>b.x+b.w))-x,h:Math.max(...boxes.map(b=>b.y+b.h))-y};
}
function refresh(){
  if(!bar)return;
  if(properties){
    if(!properties.el.isConnected)properties=null;
    else if(properties.projectId!==P().id||properties.key!==selectionKey()||C().isEditing?.()||C().isCropping?.())closeProperties();
    else syncProperties();
  }
  const ids=[...S().selected],{nodes,edges}=chosen(ids),n=nodes[0],single=nodes.length===1&&edges.length===0;
  if(!nodes.length&&!edges.length||C().isEditing?.()||C().isCropping?.()){bar.hidden=true;return;}
  const card=single&&n.type==='card',image=single&&n.type==='image',group=single&&n.type==='group';
  const text=single&&['text','shape','frame','group'].includes(n.type),b=selectionBounds(nodes,edges);
  const focused=bar.contains(document.activeElement)?document.activeElement.dataset.action:null;
  bar.hidden=false;
  bar.innerHTML=(card?button('edit','编辑卡片标题','title')+button('file','打开写字板','edit'):'')+(text?button('edit','编辑文字','text'):'')+(image?button('expand','查看图片','view'):'')+button('shape','外观','style')+(card?button('sparkles','AI 工具（模拟）','ai'):'')+button('copy','复制副本','duplicate')+(nodes.length>1&&!edges.length?button('frame','组合','group'):'')+(group?button('frame','取消组合','ungroup'):'')+button('more','更多操作','more');
  const root=$('canvasEngine').getBoundingClientRect(),v=S().viewport,x=root.left+(b.x+b.w/2)*v.zoom+v.x,y=root.top+b.y*v.zoom+v.y-54;
  bar.style.left=Math.max(10,Math.min(innerWidth-bar.offsetWidth-10,x-bar.offsetWidth/2))+'px';
  bar.style.top=Math.max(82,Math.min(innerHeight-110,y))+'px';
  if(focused)bar.querySelector(`[data-action="${focused}"]`)?.focus({preventScroll:true});
  bar.querySelectorAll('button').forEach(btn=>btn.onclick=()=>{
    const action=btn.dataset.action,current=chosen(),id=current.nodes[0]?.id;
    if(action==='edit'&&findNode(id)?.type==='card')F().openEditor(id);
    else if(action==='title'||action==='text')C().editText(id);
    else if(action==='view')openImage(id);
    else if(action==='ai')window.FWPanels?.openAI(id);
    else if(action==='duplicate')C().duplicate();
    else if(action==='group')C().group();
    else if(action==='ungroup')C().ungroup();
    else if(action==='style')style(btn);
    else if(action==='more')more(btn);
  });
}
function more(anchor){
  properties=null;returnAction='more';
  const {nodes,edges}=chosen(),single=nodes.length===1&&!edges.length,n=nodes[0],ids=nodes.map(a=>a.id),edgeIds=edges.map(a=>a.id),projectId=P().id;
  const sameParent=nodes.length>0&&!edges.length&&nodes.every(a=>(a.parentId||null)===(n.parentId||null)&&(a.groupId||null)===(n.groupId||null));
  const items=[...['front','forward','backward','back'].map((action,index)=>({label:['置于顶层','前移一层','后移一层','置于底层'][index],icon:index<2?'arrowRight':'arrowLeft',disabled:!C().canSetLayer?.(action),action:()=>C().setLayer(action)}))];
  if(nodes.length){
    items.push('-', {label:'移出组合',icon:'frame',disabled:!nodes.some(a=>a.groupId),action:()=>C().removeFromGroup()}, {label:'将所选对象放入分区框',icon:'frame',disabled:!sameParent||!!n.groupId||typeof C().frameFromSelection!=='function',action:()=>C().frameFromSelection()});
    const attachable=nodes.filter(a=>['text','shape','image','stroke'].includes(a.type));
    if(attachable.length){items.push({label:'设为随动批注…',icon:'arrowRight',disabled:attachable.length!==nodes.length||!!edges.length||typeof C().beginAttachment!=='function',action:()=>C().beginAttachment()}, {label:'解除随动批注',icon:'arrowLeft',disabled:!attachable.some(a=>a.attachment)||typeof C().detachAttachments!=='function',action:()=>C().detachAttachments(ids)});}
  }
  if(edges.length)items.push('-', {label:'反转连线两端标记',icon:'redo',action:()=>reverseMarkers({ids:edgeIds,projectId})});
  if(single&&n.type==='image'){
    const id=n.id;
    items.push('-', {label:'裁剪图片',icon:'frame',action:()=>C().beginCrop(id)}, {label:'恢复完整图片',icon:'image',disabled:!n.crop,action:()=>C().restoreImage(id)}, {label:'向右旋转 90°',icon:'redo',action:()=>rotate(id,90,projectId)}, {label:'向左旋转 90°',icon:'undo',action:()=>rotate(id,-90,projectId)});
  }
  items.push('-', {label:single&&n.type==='frame'?'删除分区框（保留内容）':'删除所选对象',icon:'trash',danger:true,action:()=>C().remove()});
  F().popover(anchor,items);
  const el=$('popoverHost').lastElementChild;
  if(el){el.setAttribute('aria-label','更多对象操作');el.style.maxHeight='calc(100vh - 110px)';el.style.overflowY='auto';el.style.top=Math.max(80,Math.min(parseFloat(el.style.top)||80,innerHeight-el.offsetHeight-14))+'px';el.querySelector('button:not(:disabled)')?.focus({preventScroll:true});}
}
function options(list){return list.map(([value,title])=>`<option value="${value}">${title}</option>`).join('');}
function selectControl(title,field,list,scope){return `<label>${title}<select data-field="${field}" data-scope="${scope}" aria-label="${title}">${options(list)}</select></label>`;}
function numberControl(title,field,min,max,scope){return `<label>${title}<input data-field="${field}" data-scope="${scope}" type="number" min="${min}" max="${max}" step="1" aria-label="${title}"></label>`;}
function colorControl(title,field,scope){return `<label>${title}<input data-field="${field}" data-scope="${scope}" type="color" aria-label="${title}"></label>`;}
function currentTargets(snapshot,scope,project=P()){
  if(project.id!==snapshot.projectId)return [];
  const {nodes,edges}=chosen(snapshot.ids,project);
  if(scope==='edge')return edges;
  if(scope==='text')return nodes.filter(n=>n.type==='text');
  if(scope==='shape')return nodes.filter(n=>n.type==='shape');
  return [...nodes,...edges];
}
function mutate(snapshot,label,scope,fn){
  if(P().id!==snapshot.projectId||!currentTargets(snapshot,scope).length)return;
  F().transact(label,project=>currentTargets(snapshot,scope,project||P()).forEach(fn));
}
function removeInlineOverride(n,field){
  if(n.type!=='text'||!n.html)return;
  const box=document.createElement('div');box.innerHTML=n.html;
  box.querySelectorAll('*').forEach(el=>{
    if(field==='color'){el.style.removeProperty('color');el.removeAttribute('color');}
    if(field==='bold')el.style.removeProperty('font-weight');
  });
  if(field==='bold')box.querySelectorAll('b,strong').forEach(el=>{
    if(el.attributes.length){const span=document.createElement('span');[...el.attributes].forEach(a=>span.setAttribute(a.name,a.value));span.append(...el.childNodes);el.replaceWith(span);}
    else el.replaceWith(...el.childNodes);
  });
  n.html=box.innerHTML;
}
function reverseMarkers(snapshot){mutate(snapshot,'反转连线两端标记','edge',ed=>{const start=ed.startMarker||'none',end=ed.endMarker||'arrow';ed.startMarker=end;ed.endMarker=start;});}
function style(anchor){
  closeProperties();returnAction='style';
  const ids=[...S().selected],{nodes,edges}=chosen(ids),el=document.createElement('div');
  const snapshot={ids,projectId:P().id,key:selectionKey(ids),el,returnAction:'style'};
  const hasText=nodes.some(n=>n.type==='text'),hasShape=nodes.some(n=>n.type==='shape');
  const palette=nodes.every(n=>n.type==='text')?['#596155','#623C2A','#3f6e85','#557359','#a95446','#90733c']:['#ffffff','#fff0de','#eaf0e9','#e6edf3','#f4e6e2','#efe8f1'];
  el.className='popover object-properties';el.setAttribute('role','dialog');el.setAttribute('aria-label','对象外观');el.tabIndex=-1;
  el.style.maxHeight='calc(100vh - 110px)';el.style.overflowY='auto';el.style.maxWidth='calc(100vw - 32px)';
  el.innerHTML=`<div class="property-heading"><strong>外观${ids.length>1?' · 多选':''}</strong><button type="button" data-close-properties aria-label="关闭外观" title="关闭外观">${icon('close')}</button></div><small>修改即时保存</small><div class="swatches" aria-label="常用颜色">${palette.map(c=>`<button type="button" data-color="${c}" style="background:${c}" title="颜色 ${c}" aria-label="颜色 ${c}"></button>`).join('')}</div>${colorControl('自定义颜色','color','all')}${edges.length?`<hr><small>连线${edges.length>1?` · ${edges.length} 条`:''}</small>${selectControl('线型','style',[['straight','直线'],['elbow','折线'],['curve','曲线']],'edge')}${selectControl('起点','startMarker',markerOptions,'edge')}${selectControl('终点','endMarker',markerOptions,'edge')}${numberControl('线条粗细','width',1,16,'edge')}<label>虚线<input data-field="dashed" data-scope="edge" type="checkbox" aria-label="虚线"></label><button type="button" data-reverse>${icon('redo')}反转两端标记</button><hr><small>连线文字</small><button type="button" data-label ${edges.length!==1?'disabled':''}>${icon('edit')}编辑连线文字</button>${numberControl('标签字号','fontSize',10,72,'edge')}${colorControl('标签颜色','labelColor','edge')}<button type="button" data-bold="edge" aria-pressed="false">${icon('bold')}标签加粗</button>`:''}${hasText?`<hr><small>独立文字 · 整块设置</small>${numberControl('整块字号','fontSize',10,144,'text')}${selectControl('对齐','align',[['left','左对齐'],['center','居中'],['right','右对齐']],'text')}<button type="button" data-bold="text" aria-pressed="false">${icon('bold')}整块加粗</button>`:''}${hasShape?`<hr><small>形状</small>${selectControl('形状','shape',shapeOptions,'shape')}`:''}<small>Esc 关闭并返回画布工具</small>`;
  $('popoverHost').append(el);properties=snapshot;syncProperties();
  const r=anchor.getBoundingClientRect();
  el.style.left=Math.max(12,Math.min(r.left,innerWidth-el.offsetWidth-12))+'px';
  el.style.top=Math.max(80,Math.min(r.bottom+8,innerHeight-el.offsetHeight-14))+'px';
  el.querySelector('[data-close-properties]').onclick=()=>closeProperties(true);
  el.querySelectorAll('[data-color]').forEach(btn=>btn.onclick=()=>mutate(snapshot,'调整颜色','all',n=>{n.color=btn.dataset.color;removeInlineOverride(n,'color');}));
  el.querySelectorAll('[data-field]').forEach(input=>input.addEventListener('change',()=>{
    const field=input.dataset.field,scope=input.dataset.scope;let value=input.type==='checkbox'?input.checked:input.value;
    if(input.type==='number'){
      if(!input.value.trim()||!Number.isFinite(Number(input.value))){syncProperties();return;}
      value=Math.round(Math.min(Number(input.max),Math.max(Number(input.min),Number(input.value))));
    }
    mutate(snapshot,'调整外观',scope,n=>{n[field]=value;if(field==='color')removeInlineOverride(n,'color');});
    syncProperties();
  }));
  el.querySelector('[data-reverse]')?.addEventListener('click',()=>reverseMarkers(snapshot));
  el.querySelector('[data-label]')?.addEventListener('click',()=>{
    const target=currentTargets(snapshot,'edge')[0];if(!target)return;
    closeProperties();C().editLabel(target.id);
  });
  el.querySelectorAll('[data-bold]').forEach(btn=>btn.onclick=()=>{
    const scope=btn.dataset.bold,targets=currentTargets(snapshot,scope),value=!targets.every(n=>!!n.bold);
    mutate(snapshot,'调整文字加粗',scope,n=>{n.bold=value;removeInlineOverride(n,'bold');});
  });
  el.focus({preventScroll:true});
}
function valueFor(n,field,scope){
  const defaults={style:'straight',startMarker:'none',endMarker:'arrow',width:2,dashed:false,fontSize:scope==='edge'?12:18,align:'left',shape:'rounded',labelColor:'#50594e'};
  if(field==='color')return n.color||(n.type==='text'?'#343832':scope==='edge'||!n.type?'#7c847b':'#fffdf8');
  return n[field]??defaults[field];
}
function colorHex(value){if(/^#[0-9a-f]{6}$/i.test(value))return value;if(/^#[0-9a-f]{3}$/i.test(value))return '#'+value.slice(1).split('').map(x=>x+x).join('');return '#343832';}
function syncProperties(){
  const snapshot=properties;if(!snapshot?.el.isConnected)return;
  const el=snapshot.el;
  const colors=currentTargets(snapshot,'all').map(n=>valueFor(n,'color','all'));
  el.querySelectorAll('[data-color]').forEach(btn=>btn.setAttribute('aria-pressed',String(colors.length>0&&colors.every(c=>c.toLowerCase()===btn.dataset.color.toLowerCase()))));
  el.querySelectorAll('[data-field]').forEach(input=>{
    const scope=input.dataset.scope,field=input.dataset.field,targets=currentTargets(snapshot,scope),values=targets.map(n=>valueFor(n,field,scope));
    if(!targets.length){input.disabled=true;return;}
    const mixed=values.some(v=>v!==values[0]);input.disabled=false;input.dataset.mixed=String(mixed);input.title=mixed?'所选对象的当前值不同；修改后统一应用':'';
    if(input.type==='checkbox'){input.checked=!!values[0];input.indeterminate=mixed;}
    else if(input.type==='color')input.value=colorHex(values[0]);
    else if(input.tagName==='SELECT'){
      input.querySelector('option[data-mixed]')?.remove();
      if(mixed){const opt=document.createElement('option');opt.value='';opt.textContent='多种';opt.disabled=true;opt.dataset.mixed='true';input.prepend(opt);input.value='';}else input.value=String(values[0]);
    }else{input.value=mixed?'':String(values[0]);input.placeholder=mixed?'多种':'';}
  });
  el.querySelectorAll('[data-bold]').forEach(btn=>{const targets=currentTargets(snapshot,btn.dataset.bold),all=targets.length>0&&targets.every(n=>!!n.bold),some=targets.some(n=>!!n.bold);btn.setAttribute('aria-pressed',some&&!all?'mixed':String(all));btn.classList.toggle('active',all);});
}
function rotate(id,angle,projectId=P().id){
  if(P().id!==projectId||findNode(id)?.type!=='image')return;
  F().transact('旋转图片',project=>{
    const n=findNode(id,project||P());if(n?.type!=='image')return;
    const cx=n.x+n.w/2,cy=n.y+n.h/2;
    if(n.crop){const c=n.crop;n.crop=angle>0?{x:1-c.y-c.h,y:c.x,w:c.h,h:c.w}:{x:c.y,y:1-c.x-c.w,w:c.h,h:c.w};}
    n.rotation=((n.rotation||0)+angle+360)%360;[n.w,n.h]=[n.h,n.w];n.x=cx-n.w/2;n.y=cy-n.h/2;
  });
}
function openImage(id){
  const projectId=P().id;if(findNode(id)?.type!=='image')return;
  closeProperties();
  const el=document.createElement('div');el.className='fw-dialog-backdrop image-viewer';
  el.innerHTML=`<section role="dialog" aria-modal="true" aria-label="图片查看器"><header><span>图片</span><span>适应窗口</span><button type="button" data-original>查看原图</button><button type="button" data-close aria-label="关闭图片">${icon('close')}</button></header><div class="image-viewer-content"></div></section>`;
  document.body.append(el);let original=false;
  const close=()=>{el.remove();focusCanvas();};
  const show=()=>{
    const n=P().id===projectId?findNode(id):null;if(!n){close();return;}
    const view=el.querySelector('.image-viewer-content'),ratio=n.w/n.h,ww=Math.min(innerWidth*.8,innerHeight*.7*ratio),hh=ww/ratio;
    view.style.cssText=`position:relative;width:${ww}px;height:${hh}px;overflow:hidden`;
    if(original){view.style.cssText='position:relative;max-width:80vw;max-height:70vh;display:flex;align-items:center;justify-content:center;overflow:visible';view.innerHTML=`<img src="${esc(n.src)}" alt="图片原图" style="transform:rotate(${Number(n.rotation)||0}deg);max-width:70vw;max-height:65vh">`;}
    else view.innerHTML=C().imageMarkup({...n,w:ww,h:hh});
    el.querySelector('[data-original]').textContent=original?'查看画布效果':'查看原图';
  };
  show();el.querySelector('[data-original]').onclick=()=>{original=!original;show();};el.querySelector('[data-close]').onclick=close;
  el.addEventListener('click',ev=>{if(ev.target===el)close();});
  el.addEventListener('keydown',ev=>{
    ev.stopPropagation();
    if(!ev.isComposing&&ev.key==='Escape'){ev.preventDefault();close();}
    if(ev.key==='Tab'){const first=el.querySelector('[data-original]'),last=el.querySelector('[data-close]');if(ev.shiftKey&&document.activeElement===first){ev.preventDefault();last.focus();}else if(!ev.shiftKey&&document.activeElement===last){ev.preventDefault();first.focus();}}
  });
  el.querySelector('[data-close]').focus();
}
window.FWObjects={init};
})();
