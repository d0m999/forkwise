/* Card-local materials: list → read → return. Only explicit actions write the study. */
window.ForkwiseMaterials = (() => {
  const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  let pdfLibrary;
  const pdfjs=()=>pdfLibrary??=import('./vendor/pdfjs/pdf.min.mjs').then(lib=>{lib.GlobalWorkerOptions.workerSrc=new URL('./vendor/pdfjs/pdf.worker.min.mjs',document.baseURI).href;return lib;});
  const pdfOptions=data=>({data:Uint8Array.from(atob(data.split(',')[1]),c=>c.charCodeAt(0)),cMapUrl:new URL('./vendor/pdfjs/cmaps/',document.baseURI).href,cMapPacked:true,standardFontDataUrl:new URL('./vendor/pdfjs/standard_fonts/',document.baseURI).href,wasmUrl:new URL('./vendor/pdfjs/wasm/',document.baseURI).href,iccUrl:new URL('./vendor/pdfjs/iccs/',document.baseURI).href,isEvalSupported:false});
  const readFile=file=>new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=()=>reject(new Error('文件读取失败'));reader.readAsDataURL(file)});
  const readImage=data=>new Promise((resolve,reject)=>{const img=new Image();img.onload=()=>resolve({width:img.naturalWidth,height:img.naturalHeight});img.onerror=()=>reject(new Error('图像无法读取'));img.src=data});
  function install(host){
    const panel=document.createElement('section');panel.className='fw-material-window hidden';panel.setAttribute('role','dialog');panel.setAttribute('aria-label','对象材料');host.canvas.append(panel);
    let context=null,reading=null,add=false,reuse=false,region=null,reference=null,job=0,pdfDocument=null,task=null,renderTask=null,page=1,status='',replace=null,cancelRegion=()=>{};
    const current=()=>host.get(),valid=()=>context&&context.project===current().projectId&&current().graph.nodes[context.target]||context&&context.project===current().projectId&&current().graph.edges[context.target];
    const object=()=>current().graph.nodes[context?.target]||current().graph.edges[context?.target];
    const material=()=>current().study.sources.find(m=>m.id===reading?.source&&m.version===reading.version);
    const drafts=()=>host.draft(context.target),putDraft=values=>host.setDraft(context.target,{...drafts(),...values});
    const stopPdf=()=>{cancelRegion();job++;renderTask?.cancel();renderTask=null;task?.destroy();task=null;pdfDocument?.destroy();pdfDocument=null};
    let returnTo=null,listScroll=0;
    const close=()=>{returnTo=null;stopPdf();panel.classList.add('hidden');context=null;reading=null;reference=null;status='';host.closed()};
    const refs=()=>{
      const n=object(),all=[...(n?.materials||[]),n?.sourceRef,...(n?.evidence||[]).map(e=>e.ref)].filter(Boolean),seen=new Set();
      return all.filter(r=>!n?.materialExclusions?.some(x=>x.source===r.source&&x.version===r.version)).filter(r=>{const key=r.source+':'+r.version;if(seen.has(key))return false;seen.add(key);return true}).map(r=>current().study.sources.find(m=>m.id===r.source&&m.version===r.version)).filter(Boolean);
    };
    const act=a=>host.act({...a,id:context.target});
    const buttons=(text,action,extra='')=>`<button type="button" data-material="${action}" ${extra}>${text}</button>`;
    const message=()=>{panel.querySelector('[data-material-status]')?.replaceChildren(document.createTextNode(status))};
    const summary=()=>{const n=object();return `<p class="fw-material-object">${escape(n?.text||'这步推导')} · ${n?.type==='inference'?'推导':'主张'}</p>`};
    function render(){
      if(!context)return;if(!valid()){close();return}
      stopPdf();const n=object(),m=material(),draft=drafts();
      panel.innerHTML=`<header><strong>${reading?'材料阅读':'材料 · '+(n.type==='inference'?'这步推导':'当前卡片')}</strong><div>${reading?(returnTo?buttons(host.returnLabel(returnTo),'return-task'):buttons('返回列表','back')):''}${buttons('关闭','close','aria-label="关闭材料窗口"')}</div></header><div class="fw-material-body">${summary()}<p data-material-status role="status">${escape(status)}</p></div>`;
      const body=panel.querySelector('.fw-material-body');
      if(!reading){
        const rows=refs().sort((a,b)=>(b.period||'').localeCompare(a.period||''));
        const groups=new Map();for(const m of rows){const old=groups.get(m.id);if(!old||old.version<m.version)groups.set(m.id,m)}
        body.insertAdjacentHTML('beforeend',`${buttons('＋ 添加材料','add')}<div class="fw-material-list">${groups.size?[...groups.values()].map(m=>`<article><button data-material="read" data-source="${escape(m.id)}" data-version="${m.version}" class="fw-material-row"><strong>${escape(m.title)}</strong><span>${escape(m.author||'来源未知')} · ${escape(m.period||'业务期间未知')}</span><small>${escape(m.kind==='pdf'?'PDF':m.kind==='image'?'图片':'文本')} · v${m.version}</small></button>${buttons('移除','remove',`data-source="${escape(m.id)}" data-version="${m.version}" aria-label="从本对象移除 ${escape(m.title)}"`)}</article>`).join(''):'<p>还没有材料。添加文件，或从本项目已有材料选用。</p>'}</div>`);
        if(add)body.insertAdjacentHTML('beforeend',`<section class="fw-material-add"><label class="fw-material-file">从本机添加文本、图片或 PDF<input type="file" data-material-file accept=".txt,.md,.pdf,image/png,image/jpeg,image/webp,image/gif"></label>${buttons(reuse?'收起已有资料':'从本项目已有资料选择','reuse')}${reuse?current().study.sources.map(m=>buttons(escape(m.title)+' · v'+m.version,'attach',`data-source="${escape(m.id)}" data-version="${m.version}"`)).join(''):''}<details${draft.text?' open':''}><summary>也可以贴入文本</summary><label>材料名称<input data-material-draft="title" value="${escape(draft.title||'')}" placeholder="例如：2026 年二季度财报"></label><label>文本<textarea data-material-draft="text">${escape(draft.text||'')}</textarea></label>${buttons('添加这份文本','save-text')}</details>${buttons('完成','finish-add')}</section>`);
      }else if(!m){body.insertAdjacentHTML('beforeend','<p>所引用的材料版本暂无法取得，原引用保留。</p>')}
      else{
        const versions=current().study.sources.filter(x=>x.id===m.id);
        body.insertAdjacentHTML('beforeend',`<h3>${escape(m.title)}</h3><p>${escape(m.author)} · ${escape(m.period)}</p>${versions.length>1?`<label>材料版本<select data-material-version>${versions.map(v=>`<option value="${v.version}"${m.version===v.version?' selected':''}>v${v.version}</option>`).join('')}</select></label>`:''}<details class="fw-material-meta"><summary>来源与版本信息</summary><label>来源<input data-material-meta="author" value="${escape(m.author||'')}" placeholder="作者或机构"></label><label>业务期间<input data-material-meta="period" value="${escape(m.period||'')}" placeholder="例如：2026 年 Q2"></label><p>${escape(m.published||'发布时间未知')}<br>取得时间：${escape(m.acquired||'未记录')}<br>材料 v${m.version}</p>${buttons('保存来源信息','metadata')}${buttons('添加新版本','new-version')}</details>`);
        if(m.kind==='pdf'){
          body.insertAdjacentHTML('beforeend',`<div class="fw-pdf-tools">${buttons('上一页','pdf-prev','disabled')}<span data-pdf-position>正在读取 PDF…</span>${buttons('下一页','pdf-next','disabled')}</div><div class="fw-pdf-page"><canvas aria-label="PDF 页面"></canvas></div>`);loadPdf(m);
        }else if(m.kind==='image'){
          body.insertAdjacentHTML('beforeend',`<p class="fw-material-note">原图阅读；按需拖框记录具体区域，未进行 OCR。</p>${buttons('框选引用区域','region-mode')}${buttons('引用整图','image-quote')}<div class="fw-material-image"><img src="${escape(m.data)}" alt="${escape(m.title)}"><div class="fw-image-region hidden"></div></div>`);
          if(reference?.kind==='image'){region=reference.region;panel.querySelector('img').onload=()=>paintRegion(m)}
        }else{
          const ref=reference?.kind!=='image'?reference:null,matched=ref&&m.text.slice(ref.start,ref.end)===ref.quote;
          body.insertAdjacentHTML('beforeend',`<div class="fw-material-text">${matched?escape(m.text.slice(0,ref.start))+'<mark>'+escape(ref.quote)+'</mark>'+escape(m.text.slice(ref.end)):escape(m.text)}</div>${buttons('引用选中文字','text-quote')}`)
        }
        if(m.kind!=='pdf')body.insertAdjacentHTML('beforeend',`<section class="fw-material-excerpt hidden"><p data-material-quote></p><label>作用<select data-material-effect>${['尚待判断','支持','反驳','限定','背景'].map(x=>`<option>${x}</option>`).join('')}</select></label><label>说明（选填）<input data-material-reason></label>${buttons('记录这项引用','save-evidence')}${buttons('取消','cancel-evidence')}</section>`);
        const evidence=n.evidence.filter(e=>e.ref.source===m.id&&e.ref.version===m.version);
        if(evidence.length)body.insertAdjacentHTML('beforeend',`<details><summary>已记录引用 · ${evidence.length} 项</summary>${evidence.map(e=>`<p>${escape(e.effect)} · ${escape(e.ref.quote)}${e.targetVersion!==n.version?' · 适用于旧版 v'+e.targetVersion:''}</p>${buttons('回查与修改作用','edit-evidence',`data-evidence="${escape(e.id)}"`)}${buttons('解除引用','remove-evidence',`data-evidence="${escape(e.id)}"`)}`).join('')}</details>`);
      }
    }
    async function loadPdf(m){
      const token=job;status='';
      try{const lib=await pdfjs();if(token!==job)return;task=lib.getDocument(pdfOptions(m.data));task.onPassword=()=>{status='这份 PDF 有密码保护，当前基础阅读不支持解锁。';message();task.destroy()};pdfDocument=await task.promise;if(token!==job)return;page=Math.min(Math.max(1,page),pdfDocument.numPages);await drawPdf(token)}catch(error){if(token===job){status=status||'PDF 无法加载：'+(error.message||error);message()}}
    }
    async function drawPdf(token=job){
      if(!pdfDocument||token!==job)return;renderTask?.cancel();
      const requested=page,p=await pdfDocument.getPage(page);if(token!==job||requested!==page)return;
      const canvas=panel.querySelector('canvas'),base=p.getViewport({scale:1}),scale=Math.min(1.8,Math.max(.25,(panel.clientWidth-50)/base.width)),vp=p.getViewport({scale});
      canvas.width=vp.width;canvas.height=vp.height;
      renderTask=p.render({canvasContext:canvas.getContext('2d'),canvas,viewport:vp});
      try{await renderTask.promise}catch(error){if(error.name!=='RenderingCancelledException')throw error}
      if(token!==job)return;panel.querySelector('[data-pdf-position]').textContent=`第 ${page} / ${pdfDocument.numPages} 页`;
      panel.querySelector('[data-material="pdf-prev"]').disabled=page===1;panel.querySelector('[data-material="pdf-next"]').disabled=page===pdfDocument.numPages;
    }
    function paintRegion(m){
      if(!region)return;const layer=panel.querySelector('.fw-image-region');if(!layer)return;
      layer.classList.remove('hidden');Object.assign(layer.style,{left:region.x/m.width*100+'%',top:region.y/m.height*100+'%',width:region.width/m.width*100+'%',height:region.height/m.height*100+'%'});
    }
    async function addFile(file){
      if(!file)return;const captured={...context},replacing=replace;
      const validContext=()=>context&&captured.project===context.project&&captured.target===context.target&&valid();
      const loadingJob=++job;
      status='正在读取文件…';message();
      try{
        if(file.size>16*1024*1024)throw new Error('当前原型单个文件上限为 16 MB，请使用较小文件。');
        const lower=file.name.toLowerCase();let m={title:file.name,text:'',kind:'text'};
        if(lower.endsWith('.pdf')){m.kind='pdf';m.data=(await readFile(file)).replace(/^data:[^;]+;/,'data:application/pdf;');const lib=await pdfjs(),loading=lib.getDocument(pdfOptions(m.data));loading.onPassword=()=>loading.destroy();try{const doc=await loading.promise;m.pages=doc.numPages;await doc.destroy()}catch{await loading.destroy();throw new Error('PDF 损坏或有密码保护，没有加入材料。')}}
        else if(/^image\/(png|jpeg|webp|gif)$/.test(file.type)){m.kind='image';m.data=await readFile(file);Object.assign(m,await readImage(m.data))}
        else if(/\.(txt|md)$/.test(lower)){m.text=await file.text();if(!m.text.trim())throw new Error('文本为空')}
        else throw new Error('请选择文本、PNG/JPEG/WebP/GIF 图片或 PDF。');
        if(!validContext()||loadingJob!==job)return;
        if(act({type:'material-add',material:m,replaces:replacing})){reading=null;replace=null;status='已加入材料列表';add=false;render()}
      }catch(error){if(validContext()&&loadingJob===job){status=error.message||String(error);message()}}
    }
    panel.addEventListener('input',event=>{const key=event.target.dataset.materialDraft;if(key)putDraft({[key]:event.target.value})});
    panel.addEventListener('change',event=>{
      if(event.target.matches('[data-material-file]')){const file=event.target.files?.[0];event.target.value='';addFile(file)}
      if(event.target.matches('[data-material-version]')){reading.version=Number(event.target.value);page=1;reference=null;render()}
    });
    panel.addEventListener('click',async event=>{
      const button=event.target.closest('[data-material]');if(!button||!valid())return;const a=button.dataset.material,m=material();
      if(a==='close'){close();return}
      if(a==='return-task'){const previous=returnTo;close();host.returned(previous);return}
      if(a==='back'){reading=null;reference=null;region=null;status='';render();panel.querySelector('.fw-material-body').scrollTop=listScroll;return}
      if(a==='add'){add=!add;render();return}
      if(a==='reuse'){reuse=!reuse;render();return}
      if(a==='finish-add'){add=false;render();return}
      if(a==='read'){listScroll=panel.querySelector('.fw-material-body').scrollTop;returnTo=null;reading={source:button.dataset.source,version:Number(button.dataset.version)};reference=null;region=null;page=1;render();return}
      if(a==='attach'||a==='remove'){act({type:a==='attach'?'material-attach':'material-remove',source:button.dataset.source,version:Number(button.dataset.version)});render();return}
      if(a==='save-text'){const draft=drafts();if(act({type:'material-add',material:{kind:'text',title:draft.title||'本人提供文本',text:draft.text||''}})){putDraft({text:'',title:''});add=false;render()}return}
      if(a==='metadata'){const values=Object.fromEntries([...panel.querySelectorAll('[data-material-meta]')].map(el=>[el.dataset.materialMeta,el.value]));act({type:'material-meta',source:m.id,version:m.version,...values});render();return}
      if(a==='new-version'){replace=m.id;reading=null;add=true;status='选择文件，保存为此材料的新版本；旧版本保留。';render();return}
      if(a==='pdf-prev'||a==='pdf-next'){page=Math.min(pdfDocument.numPages,Math.max(1,page+(a==='pdf-prev'?-1:1)));drawPdf().catch(error=>{status=error.message;message()});return}
      if(a==='text-quote'){
        const sel=window.getSelection(),block=panel.querySelector('.fw-material-text');
        if(!sel?.rangeCount||!block.contains(sel.anchorNode)||!block.contains(sel.focusNode)||!sel.toString()){status='先在原文中选中一句话';message();return}
        const range=sel.getRangeAt(0),prefix=range.cloneRange();prefix.selectNodeContents(block);prefix.setEnd(range.startContainer,range.startOffset);const start=prefix.toString().length,end=start+range.toString().length;
        reference={source:m.id,version:m.version,start,end,quote:m.text.slice(start,end)};showEvidence();return;
      }
      if(a==='image-quote'){region={x:0,y:0,width:m.width,height:m.height};reference={kind:'image',source:m.id,version:m.version,width:m.width,height:m.height,region,quote:'原图整图（未进行 OCR）'};paintRegion(m);showEvidence();return}
      if(a==='region-mode'){panel.querySelector('.fw-material-image').classList.add('selecting');status='在原图上按下并拖动，框选要引用的区域';message();return}
      if(a==='remove-evidence'){act({type:'material-evidence-remove',evidence:button.dataset.evidence});render();return}
      if(a==='edit-evidence'){const e=object().evidence.find(e=>e.id===button.dataset.evidence);if(!e)return;reference=e.ref;if(reference.kind==='image'){region=reference.region;paintRegion(m)}showEvidence();panel.querySelector('[data-material-effect]').value=e.effect;panel.querySelector('[data-material-reason]').value=e.reason||'';panel.querySelector('.fw-material-excerpt').scrollIntoView({block:'nearest'});return}
      if(a==='cancel-evidence'){reference=null;panel.querySelector('.fw-material-excerpt').classList.add('hidden');return}
      if(a==='save-evidence'&&reference){act({type:'material-evidence',ref:reference,effect:panel.querySelector('[data-material-effect]').value,reason:panel.querySelector('[data-material-reason]').value});status='引用已记录；立场保持。';render()}
    });
    const showEvidence=()=>{panel.querySelector('.fw-material-excerpt').classList.remove('hidden');panel.querySelector('[data-material-quote]').textContent=reference.quote+' · 记录到当前对象 v'+object().version+'；旧版引用保留。'};
    panel.addEventListener('pointerdown',event=>{
      const area=event.target.closest('.fw-material-image.selecting'),m=material();if(!area||!m)return;
      cancelRegion();event.preventDefault();const rect=area.getBoundingClientRect(),point=e=>({x:Math.max(0,Math.min(m.width,(e.clientX-rect.left)/rect.width*m.width)),y:Math.max(0,Math.min(m.height,(e.clientY-rect.top)/rect.height*m.height))}),first=point(event);
      const move=e=>{const at=point(e);region={x:Math.min(at.x,first.x),y:Math.min(at.y,first.y),width:Math.abs(at.x-first.x),height:Math.abs(at.y-first.y)};paintRegion(m)};
      const cleanup=()=>{window.removeEventListener('pointermove',move);window.removeEventListener('pointerup',up);window.removeEventListener('pointercancel',cleanup);area.classList.remove('selecting');cancelRegion=()=>{}};const up=e=>{move(e);cleanup();area.classList.remove('selecting');if(region.width<1||region.height<1)return;reference={kind:'image',source:m.id,version:m.version,width:m.width,height:m.height,region,quote:'原图区域（人工框选，未进行 OCR）'};showEvidence()};
      cancelRegion=cleanup;window.addEventListener('pointermove',move);window.addEventListener('pointerup',up,{once:true});window.addEventListener('pointercancel',cleanup);
    });
    panel.addEventListener('keydown',event=>{if(event.key==='Escape'){event.preventDefault();event.stopPropagation();close()}});
    return {open(target,ref,previous=null){host.beforeOpen();returnTo=previous;listScroll=0;context={project:current().projectId,target};reading=ref?{source:ref.source,version:ref.version}:null;reference=ref||null;add=false;reuse=false;replace=null;region=null;page=1;status='';panel.classList.remove('hidden');render();panel.querySelector('[data-material="close"]')?.focus()},sync(){if(context&&!valid())close()},close,pdfjs};
  }
  return {install};
})();
