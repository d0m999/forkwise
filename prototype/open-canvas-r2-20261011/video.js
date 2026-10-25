/* R2 视频交互原型：在完整工作台里体验画布、小窗、画面外控制条和全屏。
   单一待体验方案；本地动画用于演示，外站只使用公开嵌入入口。
   播放状态只在内存中，不写入项目历史，不接入来源或生产后端。 */
(() => {
'use strict';
const F=()=>window.FW, C=()=>window.FWCanvas, P=()=>F().project();
const esc=value=>F().escape(value), $=id=>document.getElementById(id);
const CAPTION=34, DURATION=90;
const reducedMotion=window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
let active=null, frame=0, mounted=false, resizeObserver, demoViewport, lastMiniPosition=null, demoCount=0, lastDemoId=null;
const loadJobs=new Map();
const symbols={play:'<path d="m9 5 11 7-11 7Z" fill="currentColor" stroke="none"/>',pause:'<path d="M9 5v14M16 5v14" stroke-width="3"/>',video:'<rect x="3" y="5" width="18" height="14" rx="3"/><path d="m10 9 5 3-5 3Z"/>',back:'<path d="M19 12H5m7-7-7 7 7 7"/>',expand:'<path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5"/>',close:'<path d="m6 6 12 12M6 18 18 6"/>',external:'<path d="M14 3h7v7m0-7L10 14M10 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-5"/>'};
const icon=name=>`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${symbols[name]||symbols.video}</svg>`;
symbols.mini='<rect x="3" y="4" width="18" height="16" rx="2"/><rect x="11" y="11" width="8" height="6" rx="1" fill="currentColor" stroke="none"/>';
symbols.locate='<path d="M12 2v4m0 12v4M2 12h4m12 0h4"/><circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="2"/>';
symbols.grip='<path d="M9 5h.01M15 5h.01M9 12h.01M15 12h.01M9 19h.01M15 19h.01" stroke-width="3"/>';
const clock=t=>`${String(Math.floor(t/60)).padStart(2,'0')}:${String(Math.floor(t%60)).padStart(2,'0')}`;

function extractLink(text){
  const urls=String(text).match(/https?:\/\/[^\s<>"'，。！？；、（）【】「」《》]+/gi)||[];
  if(urls.length!==1)return null;
  let url=urls[0].replace(/[.,!?;:]+$/,'');
  const pairs={')':'(',']':'[','}':'{'};
  while(pairs[url.at(-1)]){
    const close=url.at(-1),open=pairs[close];
    if(url.split(close).length<=url.split(open).length)break;
    url=url.slice(0,-1).replace(/[.,!?;:]+$/,'');
  }
  return url;
}

function startTime(url){
  const raw=url.searchParams.get('t')||url.searchParams.get('start')||new URLSearchParams(url.hash.slice(1)).get('t')||'';
  if(/^\d+(?:\.\d+)?$/.test(raw))return Math.min(86400,Math.floor(Number(raw)));
  if(!/^(?:\d+h)?(?:\d+m)?(?:\d+s)?$/.test(raw))return 0;
  return Math.min(86400,Number(raw.match(/(\d+)h/)?.[1]||0)*3600+Number(raw.match(/(\d+)m/)?.[1]||0)*60+Number(raw.match(/(\d+)s/)?.[1]||0));
}

function parseLink(text){
  let url;try{url=new URL(String(text).trim());}catch{return null;}
  if(!['https:','http:'].includes(url.protocol)||url.username||url.password)return null;
  const host=url.hostname.toLowerCase(),base={url:url.href,startTime:startTime(url)};
  if(['youtube.com','www.youtube.com','m.youtube.com','music.youtube.com','youtube-nocookie.com','www.youtube-nocookie.com','youtu.be'].includes(host)){
    const id=host==='youtu.be'?url.pathname.match(/^\/([^/]+)\/?$/)?.[1]:url.pathname==='/watch'?url.searchParams.get('v'):url.pathname.match(/^\/(?:embed|shorts|live)\/([^/]+)\/?$/)?.[1];
    if(/^[\w-]{11}$/.test(id||''))return {...base,provider:'youtube',site:'YouTube',videoId:id};
  }
  if(['bilibili.com','www.bilibili.com','m.bilibili.com','player.bilibili.com'].includes(host)){
    const id=url.pathname.match(/^\/video\/(BV[\da-zA-Z]{10}|av\d+)(?:\/|$)/)?.[1]||(host==='player.bilibili.com'?(url.searchParams.get('bvid')||('av'+url.searchParams.get('aid'))):null);
    if(/^(?:BV[\da-zA-Z]{10}|av\d+)$/.test(id||''))return {...base,provider:'bilibili',site:'哔哩哔哩',videoId:id,part:Math.max(1,Math.min(1000,Number.parseInt(url.searchParams.get('p'),10)||1))};
  }
  if(['douyin.com','www.douyin.com','iesdouyin.com','www.iesdouyin.com'].includes(host)){
    const id=url.pathname.match(/^\/(?:share\/)?video\/(\d+)(?:\/|$)/)?.[1];
    if(id)return {...base,provider:'douyin',site:'抖音',videoId:id};
  }
  const shortSites={'b23.tv':'哔哩哔哩','v.douyin.com':'抖音','xhslink.com':'小红书','www.xhslink.com':'小红书','xhslink.cn':'小红书','www.xhslink.cn':'小红书'};
  if(shortSites[host]&&url.pathname!=='/')return {...base,provider:'pending',site:shortSites[host]};
  if(['xiaohongshu.com','www.xiaohongshu.com','m.xiaohongshu.com'].includes(host)&&/^\/(?:explore|discovery\/item)\/[a-z\d]+(?:\/|$)/i.test(url.pathname))return {...base,provider:'pending',site:'小红书'};
  return {...base,provider:'link',site:host.replace(/^www\./,'')};
}

function diagram(scene='basis'){
  if(scene==='portrait')return `<svg class="video-diagram" viewBox="0 0 540 960" role="img" aria-label="竖屏向量演示"><rect width="540" height="960" fill="#172725"/><g fill="#e9eee1" font-family="-apple-system, PingFang SC, sans-serif"><text x="48" y="100" font-size="18" fill="#a9b8b0">线性代数的直觉</text><text x="46" y="175" font-size="36" font-weight="600">从方向认识向量</text><text x="48" y="225" font-size="22" fill="#b2c3b6">换个角度，再看一次。</text></g><g transform="translate(185 590)"><path d="M-95 0H270M0 120V-250" stroke="#61756a" stroke-width="2"/><g data-basis-one><path d="M0 0H190m-15-10 15 10-15 10" fill="none" stroke="#b2d8ba" stroke-width="5"/></g><g data-basis-two><path d="M0 0V-170m-10 15 10-15 10 15" fill="none" stroke="#e7b99c" stroke-width="5"/></g><g data-demo-vector><path d="M0 0 220-220m-25 3 25-3-3 25" fill="none" stroke="#f6e8ad" stroke-width="7"/></g><circle r="6" fill="#f0f3e9"/></g><text x="48" y="800" font-size="24" fill="#dbe5d7" font-family="-apple-system, PingFang SC, sans-serif">长度与方向，一起定义向量。</text></svg>`;
  const basis=scene!=='vector';
  const grid=Array.from({length:13},(_,i)=>`<path d="M${i*80} 0V540M0 ${i*80}H960"/>`).join('');
  return `<svg class="video-diagram" viewBox="0 0 960 540" preserveAspectRatio="xMidYMid meet" role="img" aria-label="${basis?'两组基底与同一个向量':'向量的长度与方向'}">
    <rect width="960" height="540" fill="#172725"/>
    <g stroke="#31433e" stroke-width="1" opacity=".55">${grid}</g>
    <g fill="#a9b8b0" font-family="-apple-system, PingFang SC, sans-serif"><text x="64" y="73" font-size="17" letter-spacing="3">线性代数的直觉</text><text x="64" y="153" font-size="48" font-weight="600" fill="#f0f3e9">${basis?'换一组基底':'向量是什么'}</text><text x="66" y="194" font-size="20">${basis?'同一个向量，另一种描述。':'从长度和方向开始理解。'}</text></g>
    <g transform="translate(506 355)">
      <path d="M-80 0H380M0 100V-240" stroke="#61756a" stroke-width="1.5"/>
      <path d="m370-5 10 5-10 5m-375-235 5-10 5 10" fill="none" stroke="#61756a"/>
      <g data-basis-one><path d="M0 0H170m-12-8 12 8-12 8" fill="none" stroke="#b2d8ba" stroke-width="4"/><text x="183" y="6" fill="#b2d8ba" font-size="21">e₁</text></g>
      <g data-basis-two><path d="M0 0V-160m-8 12 8-12 8 12" fill="none" stroke="#e7b99c" stroke-width="4"/><text x="-30" y="-174" fill="#e7b99c" font-size="21">e₂</text></g>
      <path d="M0-180H270V0" stroke="#c5d5bd" stroke-dasharray="5 8" opacity=".5" fill="none"/>
      <g data-demo-vector><path d="M0 0 270-180m-20 2 20-2-8 19" fill="none" stroke="#f6e8ad" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/><text x="285" y="-186" font-size="31" fill="#f6e8ad" font-style="italic">v</text></g>
      <circle r="5" fill="#f0f3e9"/>
    </g>
    <g font-family="-apple-system, PingFang SC, sans-serif"><text x="66" y="380" font-size="15" fill="#9aaa9d">${basis?'坐标在改变':'长度与方向'}</text><text x="64" y="420" font-size="27" fill="#dbe5d7">${basis?'向量没有变。':'一起定义一个向量。'}</text></g>
  </svg>`;
}

function fallback(info,n){
  const state=n.recognition==='pending'?'正在识别链接':n.metaState==='loading'?'正在获取封面':n.metaState==='error'?'标题或封面暂未获取':'双击打开观看';
  return `<div class="video-link-cover"><span class="video-site-mark" data-provider="${esc(info?.provider||'link')}">${icon('video')}</span><strong>${esc(n.site||info?.site||'视频链接')}</strong><span class="video-placeholder-url">${esc(n.url||'本地演示片段')}</span><span class="video-load-status" role="status">${state}</span></div>`;
}

function nodeMarkup(n){
  const info=parseLink(n.url),demo=!!n.demoScene;
  const cover=demo?diagram(n.demoScene):n.coverUrl?`<img src="${esc(n.coverUrl)}" alt="视频封面" draggable="false" loading="lazy" referrerpolicy="no-referrer">`:fallback(info,n);
  const status=n.metaState==='error'?`<div class="video-meta-retry"><span>${n.coverUrl||demo?'部分信息暂未获取':'可稍后重试获取信息'}</span><button type="button" data-video-retry="${esc(n.id)}">重试</button></div>`:'';
  return `<div class="fw-video-cover">${cover}${demo?'<span class="video-cover-kind">本地动画演示</span><span class="video-duration">01:30</span>':''}${status}<span class="video-mini-badge">${icon('mini')}小窗观看中</span></div><div class="fw-video-caption"><span>${esc(n.site||info?.site||'视频')}</span><span title="${esc(n.title||n.url)}">${esc(n.title||n.url||'视频链接')}</span></div>`;
}

function saveNodeResult(projectId){
  F().save();if(P().id===projectId)C().render();
}

function metadataSpace(){
  const bounds=$('canvasEngine').getBoundingClientRect(),z=F().state.viewport.zoom;
  return {width:bounds.width/z,height:bounds.height/z};
}

function applyMetadata(n,result,space){
  if(result.title)n.title=result.title;
  if(result.scene)n.demoScene=result.scene;
  if(result.coverUrl)n.coverUrl=result.coverUrl;
  if(result.width&&result.height){
    n.videoWidth=result.width;n.videoHeight=result.height;
    if(!n.videoSizeManual){
      const center={x:n.x+n.w/2,y:n.y+n.h/2};
      const aspect=result.width/result.height,w=Math.max(40,Math.min(480,space.width*.55,(space.height*.6-CAPTION)*aspect));
      n.w=w;n.h=w/aspect+CAPTION;n.x=center.x-n.w/2;n.y=center.y-n.h/2;
    }
  }
  n.metaState=result.complete?'ready':'error';
}

function requestInfo(n,projectId=P().id,retry=false,space=metadataSpace()){
  const key=projectId+':'+n.id,previous=loadJobs.get(key);if(previous)clearTimeout(previous.timer);
  if(retry){n.metaState='loading';n.demoInfoRetry=true;}
  const job={node:n,timer:0,space};loadJobs.set(key,job);
  const current=()=>loadJobs.get(key)===job&&F().data.projects.find(p=>p.id===projectId)?.nodes.find(a=>a.id===n.id)===n;
  const finish=fn=>{if(!current())return;loadJobs.delete(key);fn();saveNodeResult(projectId);};
  job.run=()=>{
    if(!current())return;
    if(n.recognition==='pending'){
      finish(()=>{
        if(n.demoLoadCase==='recognize'){
          n.recognition='video';n.provider='demo';n.metaState='loading';
        }else if(n.forceVideo){n.recognition='video';n.provider='link';n.metaState='error';}
        else{n.type='card';n.title='';n.body=n.url;n.tags=[];n.color='#ffffff';n.manualHeight=n.h;delete n.recognition;delete n.metaState;}
      });
      if(n.type==='video'&&n.metaState==='loading')requestInfo(n,projectId,false,job.space);
      return;
    }
    if(n.demoLoadCase){
      finish(()=>{
        const portrait=n.demoLoadCase==='portrait';
        if(n.demoLoadCase==='metadata-error'&&!n.demoInfoRetry){n.title='换一组基底，看懂同一个向量';n.metaState='error';return;}
        applyMetadata(n,{title:portrait?'竖屏片段：从方向认识向量':'换一组基底，看懂同一个向量',scene:portrait?'portrait':'basis',width:portrait?540:960,height:portrait?960:540,complete:true},P().id===projectId?metadataSpace():job.space);
      });return;
    }
    const info=parseLink(n.url);
    if(info?.provider==='youtube'&&!n.coverUrl){
      const img=new Image(),coverUrl=`https://i.ytimg.com/vi/${info.videoId}/hqdefault.jpg`;
      img.referrerPolicy='no-referrer';img.onload=()=>finish(()=>applyMetadata(n,{coverUrl,complete:false}));
      img.onerror=()=>finish(()=>{n.metaState='error';});img.src=coverUrl;
      job.timer=setTimeout(()=>finish(()=>{n.metaState='error';}),6000);
    }else finish(()=>{n.metaState='error';});
  };
  job.timer=setTimeout(job.run,n.demoLoadCase?12000:450);
  if(retry)saveNodeResult(projectId);
}

function resumeInfo(){
  for(const [key,job]of loadJobs){
    if(!F().data.projects.some(p=>p.nodes.includes(job.node))){clearTimeout(job.timer);loadJobs.delete(key);}
  }
  for(const n of P().nodes)if(n.type==='video'&&(n.recognition==='pending'||n.metaState==='loading')&&!loadJobs.has(P().id+':'+n.id))requestInfo(n);
}

function addLink(text,at,options={}){
  const url=extractLink(text),info=url&&parseLink(url);if(!info){F().toast('请提供一个完整的 http 或 https 视频链接');return false;}
  C().finishEdit();
  const point=at||C().center(),n={id:F().uid(),type:'video',x:point.x-240,y:point.y-152,w:480,h:270+CAPTION,title:info.url,...info,forceVideo:!!options.force,recognition:info.provider==='pending'?'pending':'video',metaState:info.provider==='pending'?'idle':'loading'};
  F().transact('添加视频对象',p=>{p.nodes.push(n);C().updateFrames?.([n.id]);F().state.selected=[n.id];});
  F().toast(n.recognition==='pending'?'已放到画布，正在识别链接':'视频已放到画布，正在获取封面');return true;
}

function openLinkDialog(){
  F().closePopover();C().finishEdit();
  const previous=document.activeElement,back=document.createElement('div');back.className='fw-dialog-backdrop';
  back.innerHTML=`<form class="fw-dialog video-link-dialog" role="dialog" aria-modal="true" aria-label="添加视频"><h2>把视频放到画布上</h2><p>粘贴视频网址，或只含一个网址的分享文案。</p><label for="video-link-url">视频链接</label><input id="video-link-url" type="text" placeholder="https://…" maxlength="4096" required autocomplete="off"><div class="dialog-actions"><button type="button" data-cancel>取消</button><button class="primary" type="submit">放到画布</button></div></form>`;
  document.body.append(back);
  const close=()=>{back.remove();previous?.isConnected&&previous.focus({preventScroll:true});};
  back.querySelector('[data-cancel]').onclick=close;
  back.querySelector('form').onsubmit=event=>{event.preventDefault();if(addLink(back.querySelector('input').value,null,{force:true}))close();};
  back.onkeydown=event=>{if(event.isComposing)return;if(event.key==='Escape'){event.preventDefault();event.stopPropagation();close();}};
  back.querySelector('input').focus();
}

function setBackgroundInert(a,full){
  if(full){
    a.background=[...document.querySelectorAll('.app-header,#workspace,.bottom-left,#toolDock,.zoom-tools,#objectBar,#popoverHost,#modalHost')].map(el=>[el,el.inert]);
    a.background.forEach(([el])=>el.inert=true);
  }else{a.background?.forEach(([el,value])=>el.inert=value);a.background=null;}
}

function stop(restoreFocus=true){
  if(!active)return;const a=active;active=null;cancelAnimationFrame(frame);
  setBackgroundInert(a,false);document.body.classList.remove('fw-video-fullscreen');
  a.el.remove();a.dock.remove();document.querySelectorAll('.fw-video').forEach(el=>el.classList.remove('is-playing','is-mini'));C().render();
  if(restoreFocus){const target=document.querySelector(`[data-node="${CSS.escape(a.id)}"]`);(target||$('canvasEngine')).focus({preventScroll:true});}
}

function setMode(mode){
  if(!active||active.mode===mode)return;
  const a=active;F().closePopover();
  if(mode==='full')a.returnMode=a.mode;
  if(a.mode==='full')setBackgroundInert(a,false);
  a.mode=mode;if(mode==='full')setBackgroundInert(a,true);
  document.body.classList.toggle('fw-video-fullscreen',mode==='full');a.el.dataset.mode=mode;
  a.el.setAttribute('role',mode==='full'?'dialog':'group');
  if(mode==='full')a.el.setAttribute('aria-modal','true');else a.el.removeAttribute('aria-modal');
  const backLabel=a.returnMode==='mini'?'返回小窗':'返回画布';
  a.expand.innerHTML=icon(mode==='full'?'back':'expand')+`<span>${mode==='full'?backLabel:'全屏'}</span>`;
  a.expand.setAttribute('aria-label',mode==='full'?backLabel:'全屏观看');
  a.mini.hidden=mode==='full';
  a.mini.innerHTML=icon(mode==='mini'?'back':'mini')+`<span>${mode==='mini'?'回到画布':'小窗'}</span>`;
  a.mini.setAttribute('aria-label',mode==='mini'?'回到画布':'小窗观看');
  sync();(mode==='mini'?a.mini:a.expand).focus({preventScroll:true});
}

function locateVideo(){
  const a=active,n=a&&P().nodes.find(n=>n.id===a.id);if(!n)return;
  window.FWPanels?.revealCanvas?.();
  const root=$('canvasEngine'),v=F().state.viewport;
  v.x=root.clientWidth/2-(n.x+n.w/2)*v.zoom;
  v.y=root.clientHeight/2-(n.y+n.h/2)*v.zoom;
  C().render();
}

function returnToCanvas(locate=true){
  setMode('canvas');if(locate)locateVideo();
}

function miniRect(a,bounds){
  const margin=18,top=bounds.top+60;
  const toolTops=[...document.querySelectorAll('#toolDock,.zoom-tools,.bottom-left')].map(el=>el.getBoundingClientRect().top);
  const bottom=Math.min(bounds.bottom-margin,...toolTops.map(y=>y-margin));
  const availableW=Math.max(1,bounds.width-margin*2),availableH=Math.max(1,bottom-top-CAPTION);
  // 横屏约占可见画布宽度的五分之一；竖屏以较紧凑的高度确定宽度。
  const compactW=a.aspect>=1?Math.max(280,Math.min(420,bounds.width*.21)):Math.min(300,Math.max(240,bounds.height*.44))*a.aspect;
  const targetW=Math.max(compactW,a.minWidth,a.minHeight*a.aspect);
  const w=Math.min(targetW,availableW,availableH*a.aspect),h=w/a.aspect;
  const left=bounds.left+margin,right=Math.max(left,bounds.right-margin-w),maxTop=Math.max(top,bottom-h-CAPTION);
  a.miniPosition??=lastMiniPosition?{...lastMiniPosition}:{x:right,y:maxTop};
  a.miniPosition.x=Math.max(left,Math.min(right,a.miniPosition.x));
  a.miniPosition.y=Math.max(top,Math.min(maxTop,a.miniPosition.y));
  lastMiniPosition={...a.miniPosition};
  return {left:a.miniPosition.x,top:a.miniPosition.y,width:w,height:h};
}

function dragMini(event){
  const a=active;if(!a||a.mode!=='mini'||event.button!==0)return;
  event.preventDefault();event.stopPropagation();
  const handle=a.caption;
  const origin={...a.miniPosition},pointerId=event.pointerId;
  handle.setPointerCapture(pointerId);a.el.classList.add('is-dragging');
  const move=e=>{a.miniPosition={x:origin.x+e.clientX-event.clientX,y:origin.y+e.clientY-event.clientY};sync();};
  const end=()=>{a.el.classList.remove('is-dragging');handle.removeEventListener('pointermove',move);handle.removeEventListener('pointerup',end);handle.removeEventListener('pointercancel',end);if(handle.hasPointerCapture(pointerId))handle.releasePointerCapture(pointerId);};
  handle.addEventListener('pointermove',move);handle.addEventListener('pointerup',end);handle.addEventListener('pointercancel',end);
}

function toggle(){
  const a=active;if(!a?.demo||a.error)return;
  if(a.time>=DURATION)a.time=a.startTime;
  a.playing=!a.playing;a.last=performance.now();updateDemo(a);
  if(a.playing){cancelAnimationFrame(frame);frame=requestAnimationFrame(tick);}
}

function updateDemo(a){
  const ended=a.time>=DURATION;
  a.el.classList.toggle('is-ended',ended);
  a.play.innerHTML=icon(a.playing?'pause':'play')+(ended?'<span>重播</span>':'');a.play.setAttribute('aria-label',ended?'重播':a.playing?'暂停':'播放');
  a.play.title=ended?'重播':a.playing?'暂停':'播放';
  a.timeLabel.textContent=`${clock(a.time)} / ${clock(DURATION)}`;
  a.seek.value=String(a.time);a.seek.style.setProperty('--progress',(a.time/DURATION*100)+'%');a.seek.setAttribute('aria-valuetext',clock(a.time));
  const phase=reducedMotion?0:Math.sin(a.time*.23),angle=phase*22;
  a.el.querySelector('[data-basis-one]')?.setAttribute('transform',`rotate(${-angle})`);
  a.el.querySelector('[data-basis-two]')?.setAttribute('transform',`rotate(${angle*.45})`);
  if(a.scene==='vector')a.el.querySelector('[data-demo-vector]')?.setAttribute('transform',`rotate(${angle*.5})`);
}

function tick(now){
  const a=active;if(!a?.demo||!a.playing)return;
  a.time=Math.min(DURATION,a.time+Math.max(0,(now-a.last)/1000));a.last=now;
  if(a.time>=DURATION)a.playing=false;
  updateDemo(a);if(a.playing)frame=requestAnimationFrame(tick);
}

function openOriginal(a,n){
  if(!n)return;
  let url=n.url;
  if(a.demo){
    const demo=new URL(location.href);demo.search='?isolated=1&video-demo=1&video-view=canvas&demo-origin=1';url=demo.href;
  }
  if(!url||!parseLink(url))return;
  stop(false);window.open(url,'_blank','noopener,noreferrer');
}

function showFailure(a,{message='播放暂时中断，请稍后重试。',canResume=false,permanent=false}={}){
  a.error={resumeTime:a.demo&&canResume?a.time:null,wasPlaying:a.playing,permanent};
  a.playing=false;cancelAnimationFrame(frame);
  if(!a.demo){a.media.replaceChildren();a.loaded=false;}
  const start=a.error.resumeTime??a.startTime;
  a.failure.innerHTML=`<strong>${esc(message)}</strong><p>${permanent?'可以在原页面继续观看。':a.error.resumeTime!==null?`重试将从 ${clock(start)} 继续`:`无法恢复中断进度，重试将从 ${clock(start)} 开始`}</p><div>${permanent?'':'<button type="button" data-play-retry>重试</button>'}<button type="button" data-original>打开原页面 ${icon('external')}</button><button type="button" data-error-close>关闭</button></div>`;
  a.failure.hidden=false;a.media.inert=true;
  a.failure.querySelector('[data-play-retry]')?.addEventListener('click',()=>retryPlayback(a));
  a.failure.querySelector('[data-original]').onclick=()=>openOriginal(a,P().nodes.find(n=>n.id===a.id));
  a.failure.querySelector('[data-error-close]').onclick=()=>stop();
  if(a.demo)updateDemo(a);
  sync();a.failure.querySelector('button')?.focus({preventScroll:true});
}

function retryPlayback(a){
  if(!a.error)return;
  const error=a.error;a.error=null;a.failure.hidden=true;a.media.inert=false;
  if(a.demo){a.time=error.resumeTime??a.startTime;a.last=performance.now();a.playing=error.wasPlaying;updateDemo(a);if(a.playing)frame=requestAnimationFrame(tick);}
  else{a.loaded=false;sync();}
  a.el.focus({preventScroll:true});
}

function loadExternal(a,n){
  if(a.loaded)return;
  const info=parseLink(n.url);if(!info)return;
  a.loaded=true;
  if(!['youtube','bilibili'].includes(info.provider)){
    showFailure(a,{message:'这个链接暂时无法在画布里播放',permanent:true});return;
  }
  let src=info.url;
  if(info.provider==='youtube')src=`https://www.youtube.com/embed/${info.videoId}?autoplay=1&playsinline=1&fs=0&start=${a.startTime}`;
  if(info.provider==='bilibili')src=`https://player.bilibili.com/player.html?${info.videoId.startsWith('av')?'aid='+info.videoId.slice(2):'bvid='+info.videoId}&p=${info.part}&t=${a.startTime}&autoplay=1`;
  const iframe=document.createElement('iframe');iframe.src=src;iframe.title=n.title||info.site+' 视频';
  iframe.allow='autoplay; encrypted-media; picture-in-picture';iframe.referrerPolicy='strict-origin-when-cross-origin';
  a.media.replaceChildren(iframe);
  const help=document.createElement('div');help.className='video-external-help';help.innerHTML=`<button type="button">播放遇到问题？</button><a href="${esc(info.url)}" target="_blank" rel="noopener noreferrer">打开原页面 ${icon('external')}</a>`;a.media.append(help);
  help.querySelector('button').onclick=()=>showFailure(a);
  help.querySelector('a').onclick=event=>{event.preventDefault();openOriginal(a,n);};
  iframe.onerror=()=>{if(active===a)showFailure(a);};
}

function editorCoversCanvas(){
  const editor=document.querySelector('.fp-editor');if(!editor||!editor.getClientRects().length)return false;
  const r=editor.getBoundingClientRect(),workspace=$('workspace').getBoundingClientRect();
  return getComputedStyle(editor).position==='fixed'&&r.width>=workspace.width-2;
}

function sync(){
  resumeInfo();
  document.querySelector('.video-demo-scenes')?.toggleAttribute('hidden',P().id!=='demo-video-interaction');
  const waiting=P().nodes.find(n=>n.id===lastDemoId),finish=document.querySelector('[data-demo-finish]');
  if(finish){finish.hidden=!waiting||!(waiting.recognition==='pending'||waiting.metaState==='loading');finish.textContent=waiting?.recognition==='pending'?'完成识别':'补齐信息';}
  const a=active;if(!a)return;
  const n=P().nodes.find(n=>n.id===a.id);
  if(P().id!==a.projectId||!n||n.type!=='video'){stop(false);return;}
  const node=document.querySelector(`[data-node="${CSS.escape(n.id)}"]`),poster=node?.querySelector('.fw-video-cover');
  if(!poster){a.el.hidden=true;a.dock.hidden=true;return;}
  node.classList.toggle('is-playing',a.mode==='canvas');
  node.classList.toggle('is-mini',a.mode==='mini'||(a.mode==='full'&&a.returnMode==='mini'));
  a.el.hidden=false;a.dock.hidden=true;a.el.inert=false;
  const covered=editorCoversCanvas(),r=poster.getBoundingClientRect(),bounds=$(covered?'workspace':'canvasEngine').getBoundingClientRect();
  a.aspect=n.videoWidth&&n.videoHeight?n.videoWidth/n.videoHeight:a.aspect;
  a.caption.querySelector('strong').textContent=n.title||n.url||'视频';
  a.el.querySelector('.video-player-heading').textContent=n.title||n.url||'视频';
  a.el.classList.toggle('over-writing',covered&&a.mode==='mini');
  let displayed=r;
  a.el.classList.remove('is-offscreen');a.content.style.clipPath='';
  a.actions.removeAttribute('style');
  if(a.mode==='canvas'){
    Object.assign(a.el.style,{left:r.left+'px',top:r.top+'px',width:r.width+'px',height:r.height+'px'});
    a.actions.style.top=(Math.max(bounds.top+8,r.top-44)-r.top)+'px';
    const actionWidth=a.actions.getBoundingClientRect().width;
    const actionLeft=Math.max(bounds.left+8,Math.min(r.right-actionWidth,bounds.right-actionWidth-8));
    a.actions.style.left=(actionLeft-r.left)+'px';a.actions.style.right='auto';
    const crop={t:Math.max(0,bounds.top-r.top),r:Math.max(0,r.right-bounds.right),b:Math.max(0,r.bottom-bounds.bottom),l:Math.max(0,bounds.left-r.left)};
    a.content.style.clipPath=`inset(${crop.t}px ${crop.r}px ${crop.b}px ${crop.l}px round 9px)`;
    const outside=covered||r.bottom<=bounds.top||r.top>=bounds.bottom||r.right<=bounds.left||r.left>=bounds.right;
    a.el.classList.toggle('is-offscreen',outside);a.el.inert=outside;a.dock.hidden=!outside;
    if(covered)a.content.style.clipPath='inset(100%)';
    a.dock.querySelector('.video-offscreen-label span').textContent=covered?'视频在画布中':'视频在视野外';
    a.dock.classList.toggle('over-writing',covered);
    Object.assign(a.dock.style,{left:(bounds.left+bounds.width/2)+'px',top:(bounds.top+16)+'px',maxWidth:Math.max(0,bounds.width-32)+'px'});
  }else if(a.mode==='mini'){
    displayed=miniRect(a,bounds);
    Object.assign(a.el.style,{left:displayed.left+'px',top:displayed.top+'px',width:displayed.width+'px',height:displayed.height+'px'});
  }else{a.el.removeAttribute('style');}
  a.el.style.setProperty('--video-aspect',String(a.aspect));
  const small=a.mode!=='full'&&(displayed.width<a.minWidth||displayed.height<a.minHeight);
  a.small.hidden=!small;a.media.inert=small||!!a.error;
  a.el.classList.toggle('is-too-small',small);
  a.small.classList.toggle('very-small',displayed.width<160||displayed.height<110);
  if(!small&&!a.error){
    if(!a.demo)loadExternal(a,n);
    else if(!a.started){a.started=true;a.playing=true;a.last=performance.now();updateDemo(a);frame=requestAnimationFrame(tick);}
  }
  if(a.mode==='canvas'&&F().state.selected.length===1&&F().state.selected[0]===a.id)$('objectBar')?.setAttribute('hidden','');
}

function open(id){
  const n=P().nodes.find(n=>n.id===id);if(n?.type!=='video')return;
  if(n.recognition==='pending'){F().toast('正在识别链接，确认后请再次双击观看');return;}
  if(active?.id===id&&active.projectId===P().id){if(active.mode==='mini')returnToCanvas(false);active.el.focus({preventScroll:true});return;}
  stop(false);F().closePopover();C().finishEdit();F().state.tool='select';F().select([id]);
  const el=document.createElement('section');el.id='videoPlayer';el.className='video-player';el.dataset.mode='canvas';el.tabIndex=-1;el.setAttribute('role','group');el.setAttribute('aria-label','正在观看：'+(n.title||'视频'));
  el.innerHTML=`<header class="video-actions"><span class="video-player-heading">${esc(n.title||'视频')}</span><button type="button" data-video-mini aria-label="小窗观看">${icon('mini')}<span>小窗</span></button><button type="button" data-video-expand aria-label="全屏观看">${icon('expand')}<span>全屏</span></button><button type="button" data-video-close aria-label="关闭播放，回到封面" title="关闭播放，回到封面">${icon('close')}<span>关闭</span></button></header><div class="video-content"><div class="video-media"></div><div class="video-failure" role="status" hidden></div></div><div class="video-too-small" hidden><strong><span>放大视频，</span><span>或全屏观看</span></strong><button type="button" data-small-expand>全屏</button></div><div class="video-mini-caption" tabindex="0" aria-label="小窗标题，拖动或使用方向键移动">${icon('grip')}<span>${esc(n.site||'视频')}</span><strong>${esc(n.title||'视频')}</strong></div>`;
  const dock=document.createElement('nav');dock.className='video-offscreen-actions';dock.hidden=true;dock.setAttribute('aria-label','视野外视频控制');
  dock.innerHTML=`<span class="video-offscreen-label">${icon('video')}<span>视频在视野外</span></span><button type="button" data-locate>${icon('locate')}定位视频</button><button type="button" data-mini>${icon('mini')}小窗</button><button type="button" data-close>${icon('close')}关闭</button>`;
  document.body.append(el,dock);
  const aspect=n.videoWidth&&n.videoHeight?n.videoWidth/n.videoHeight:n.w/Math.max(1,n.h-CAPTION);
  const demo=!!(n.demoScene||n.demoClip),start=demo?Math.min(DURATION-1,n.startTime||0):n.startTime??parseLink(n.url)?.startTime??0;
  const a=active={id,projectId:P().id,mode:'canvas',returnMode:'canvas',aspect,el,dock,actions:el.querySelector('.video-actions'),content:el.querySelector('.video-content'),media:el.querySelector('.video-media'),failure:el.querySelector('.video-failure'),small:el.querySelector('.video-too-small'),expand:el.querySelector('[data-video-expand]'),mini:el.querySelector('[data-video-mini]'),caption:el.querySelector('.video-mini-caption'),demo,scene:n.demoClip||n.demoScene,startTime:start,time:start,playing:!demo,started:false,minWidth:demo?180:200,minHeight:n.provider==='youtube'?200:100,last:performance.now(),background:null};
  a.expand.onclick=()=>setMode(a.mode==='full'?a.returnMode:'full');
  a.mini.onclick=()=>a.mode==='mini'?returnToCanvas():setMode('mini');
  el.querySelector('[data-video-close]').onclick=()=>stop();el.querySelector('[data-small-expand]').onclick=()=>setMode('full');
  dock.querySelector('[data-locate]').onclick=()=>{locateVideo();a.el.focus({preventScroll:true});};
  dock.querySelector('[data-mini]').onclick=()=>setMode('mini');dock.querySelector('[data-close]').onclick=()=>stop();
  a.caption.addEventListener('pointerdown',dragMini);
  el.addEventListener('pointerdown',event=>event.stopPropagation());
  if(a.demo){
    a.media.innerHTML=`<div class="video-demo-stage" tabindex="0" aria-label="演示画面，空格暂停或继续">${diagram(a.scene)}</div><div class="video-demo-controls"><input class="video-seek" type="range" min="0" max="${DURATION}" value="${start}" step=".1" aria-label="播放进度"><div><button type="button" data-video-play aria-label="暂停">${icon('pause')}</button><span data-video-time>${clock(start)} / 01:30</span><span class="video-demo-notice">本地动画演示 · 无音轨</span></div></div>`;
    a.play=el.querySelector('[data-video-play]');a.seek=el.querySelector('.video-seek');a.timeLabel=el.querySelector('[data-video-time]');
    a.play.onclick=toggle;a.media.querySelector('.video-demo-stage').onclick=toggle;
    a.seek.oninput=()=>{a.time=Number(a.seek.value);a.last=performance.now();updateDemo(a);};
    updateDemo(a);
  }
  sync();el.focus({preventScroll:true});
}

function keyboard(event){
  if(event.isComposing)return;
  const target=event.target.closest?.('.fw-video');
  if(target&&event.key==='Enter'&&!event.target.closest('[data-video-retry]')){event.preventDefault();event.stopImmediatePropagation();open(target.dataset.node);return;}
  const a=active;
  if(!a)return;
  if(event.key==='Escape'&&a.mode!=='mini'&&(a.el.contains(event.target)||!event.target.closest('input,textarea,select,[contenteditable=true]'))&&!document.querySelector('.fw-dialog-backdrop,#popoverHost:not(:empty),#modalHost:not(:empty)')){
    event.preventDefault();event.stopImmediatePropagation();a.mode==='full'?setMode(a.returnMode):stop();return;
  }
  if(a.mode==='mini'&&event.target===a.caption&&event.key.startsWith('Arrow')){
    event.preventDefault();event.stopImmediatePropagation();const step=event.shiftKey?2:16;
    a.miniPosition.x+=event.key==='ArrowLeft'?-step:event.key==='ArrowRight'?step:0;
    a.miniPosition.y+=event.key==='ArrowUp'?-step:event.key==='ArrowDown'?step:0;sync();return;
  }
  if(a.mode==='full'&&event.key==='Tab'){
    const controls=[...a.el.querySelectorAll('button,input,[tabindex="0"],a[href]')].filter(el=>el.getClientRects().length&&!el.closest('[hidden]'));
    const index=controls.indexOf(document.activeElement);
    if((event.shiftKey&&index<=0)||(!event.shiftKey&&(index<0||index===controls.length-1))){event.preventDefault();controls[event.shiftKey?controls.length-1:0]?.focus();}
  }
  if(a.el.contains(event.target)){
    event.stopPropagation();
    if(a.demo&&event.code==='Space'&&!event.target.closest('button,input,a')){event.preventDefault();toggle();}
  }
}

function demoProject(){
  const id='demo-video-interaction';
  F().data.projects.push({id,name:'视频旁边，继续思考',nodes:[
    {id:'video-note',type:'card',x:82,y:215,w:290,h:248,title:'换一组基底，向量变了吗？',body:'先看右边这段视频。\n\n记下我的理解：\n改变的是描述它的坐标，\n向量本身没有变。',bodyHtml:'<p>先看右边这段视频。</p><p>记下我的理解：</p><p>改变的是描述它的坐标，向量本身没有变。</p><p>我可以一边看，一边在这里接着写。</p>',tags:[],color:'#fff0de'},
    {id:'video-demo-basis',type:'video',x:470,y:180,w:640,h:360+CAPTION,title:'换一组基底，看懂同一个向量',site:'本地演示',demoScene:'basis',videoWidth:960,videoHeight:540,url:''},
    {id:'video-hint',type:'text',x:478,y:602,w:600,h:50,title:'点击画面外的「小窗」，继续边看边整理。\n双击原封面，可以把播放接回这里。',html:'点击画面外的「小窗」，继续边看边整理。<br>双击原封面，可以把播放接回这里。',fontSize:15,color:'#777972',manualWidth:true},
    {id:'video-away-note',type:'card',x:1850,y:230,w:360,h:230,title:'边听，边把想法写下来',body:'视频留在刚才的位置。\n\n这里可以继续整理、连线、写笔记。\n想重新看画面，可以点顶部的「小窗」；\n想回到视频附近，可以点「定位视频」。',bodyHtml:'<p>视频留在刚才的位置。</p><p>这里可以继续整理、连线、写笔记。</p><p>想重新看画面，可以点顶部的「小窗」；想回到视频附近，可以点「定位视频」。</p>',tags:[],color:'#fff0de'}
  ],edges:[{id:'video-note-link',from:'video-note',to:'video-demo-basis',fromSide:'right',toSide:'left',start:{x:372,y:339},end:{x:470,y:377},style:'curve',label:'换个角度理解',width:2,color:'#8f9a8a',endMarker:'none'}],tags:[]});
  F().data.current=id;F().state.selected=[];F().render();
  const root=$('canvasEngine'),z=Math.max(.2,Math.min(1,(root.clientWidth-100)/1030,(root.clientHeight-240)/472));
  F().state.viewport={x:(root.clientWidth-1030*z)/2-82*z,y:140-180*z,zoom:z};F().render();
  demoViewport={...F().state.viewport};
  const guide=document.createElement('nav');guide.className='video-demo-scenes';guide.setAttribute('aria-label','视频交互演示场景');
  guide.innerHTML='<span>本地演示</span><button data-scene="canvas">画布内观看</button><button data-scene="mini">小窗观看</button><button data-scene="offscreen">移出视野</button><select aria-label="更多视频演示"><option value="">更多流程…</option><optgroup label="加入与补齐"><option value="recognize">识别链接</option><option value="metadata">获取封面</option><option value="metadata-error">信息获取失败</option><option value="not-video">无法确认为视频</option><option value="portrait">补齐竖屏比例</option></optgroup><optgroup label="观看与恢复"><option value="start-time">从分享时间起播</option><option value="second">换一段视频</option><option value="small">播放中缩得过小</option><option value="ended">播放结束</option><option value="playback-error">中断后恢复进度</option><option value="no-progress">无法恢复进度</option><option value="blocked">不允许嵌入</option></optgroup><optgroup label="边看边写"><option value="writing">写字板占满：控制条</option><option value="writing-mini">写字板占满：小窗</option></optgroup></select><button data-demo-finish hidden>补齐信息</button>';
  guide.onclick=event=>{const button=event.target.closest('[data-scene]');if(button)showDemoView(button.dataset.scene);};
  guide.querySelector('select').onchange=event=>{const value=event.target.value;event.target.value='';if(value)runDemoCase(value);};
  guide.querySelector('[data-demo-finish]').onclick=()=>{const job=loadJobs.get(P().id+':'+lastDemoId);if(job){clearTimeout(job.timer);job.run();}};
  document.querySelector('.canvas-heading').append(guide);
  if(new URLSearchParams(location.search).has('demo-origin')){P().name='原页面打开效果 · 本地演示';F().render();}
  const view=new URLSearchParams(location.search).get('video-view');if(['canvas','mini','offscreen'].includes(view))showDemoView(view);
}

function showDemoView(view){
  if(P().id!=='demo-video-interaction'){F().data.current='demo-video-interaction';F().render();}
  F().state.viewport={...demoViewport};C().render();open('video-demo-basis');
  if(view==='mini')setMode('mini');else returnToCanvas(false);
  if(view==='offscreen'){
    const n=P().nodes.find(n=>n.id==='video-away-note'),root=$('canvasEngine'),v=F().state.viewport;
    v.x=root.clientWidth/2-(n.x+n.w/2)*v.zoom;v.y=root.clientHeight/2-(n.y+n.h/2)*v.zoom;
  }
  F().state.selected=[];C().render();
}

function runDemoCase(kind){
  if(['playback-error','no-progress','blocked','ended'].includes(kind)){
    if(!active?.demo)showDemoView('canvas');
    const a=active;if(!a)return;
    if(kind==='ended'){a.error=null;a.failure.hidden=true;a.media.inert=false;a.time=DURATION;a.playing=false;cancelAnimationFrame(frame);updateDemo(a);return;}
    a.time=36;a.playing=true;updateDemo(a);
    showFailure(a,{canResume:kind==='playback-error',permanent:kind==='blocked',message:kind==='blocked'?'这个视频不允许在此嵌入播放':'播放暂时中断，请稍后重试。'});return;
  }
  if(kind==='writing'||kind==='writing-mini'){
    showDemoView(kind==='writing-mini'?'mini':'canvas');F().openEditor('video-note');
    if(!document.body.classList.contains('fp-editor-expanded'))$('fp-expand')?.click();sync();return;
  }
  stop(false);window.FWPanels?.revealCanvas?.();
  const loading=['recognize','metadata','metadata-error','not-video','portrait'].includes(kind),pending=['recognize','not-video'].includes(kind);
  const n={id:F().uid(),type:'video',x:2500+(demoCount++)*800,y:180,w:480,h:270+CAPTION,title:loading?'https://video.example/clip?t=15':'从分享时间开始的另一段视频',site:'本地演示',url:'https://video.example/clip?t=15',startTime:15,provider:pending?'pending':'demo',recognition:pending?'pending':'video',metaState:pending?'idle':loading?'loading':'ready',demoLoadCase:loading?kind:null,demoClip:kind==='portrait'?'portrait':'basis',demoScene:loading?null:'vector'};
  lastDemoId=n.id;
  F().transact('添加本地视频演示',p=>{p.nodes.push(n);F().state.selected=[n.id];});
  const root=$('canvasEngine'),v=F().state.viewport;v.zoom=demoViewport.zoom;v.x=root.clientWidth/2-(n.x+n.w/2)*v.zoom;v.y=(root.clientHeight+140)/2-(n.y+n.h/2)*v.zoom;C().render();
  if(!loading)open(n.id);
  else F().toast('本地加载演示：可以先移动或缩放对象，再用「完成识别／补齐信息」推进');
  if(kind==='small')F().transact('缩小演示视频',()=>{const center={x:n.x+n.w/2,y:n.y+n.h/2};n.w=160;n.h=160*9/16+CAPTION;n.x=center.x-n.w/2;n.y=center.y-n.h/2;n.videoSizeManual=true;});
}

function init(){
  if(mounted)return;mounted=true;
  F().openVideo=open;
  $('videoInsert').innerHTML=icon('video');$('videoInsert').onclick=openLinkDialog;
  $('videoDemo').onclick=()=>{const url=new URL(location.href);url.searchParams.set('isolated','1');url.searchParams.set('video-demo','1');location.assign(url.href);};
  document.addEventListener('fwcanvasrender',sync);window.addEventListener('resize',sync);window.addEventListener('keydown',keyboard,true);
  $('canvasEngine').addEventListener('pointerdown',event=>{
    if(active?.el.contains(document.activeElement)&&!event.target.closest('input,textarea,[contenteditable=true]'))$('canvasEngine').focus({preventScroll:true});
  },true);
  new MutationObserver(sync).observe(document.body,{attributes:true,attributeFilter:['class']});
  document.addEventListener('visibilitychange',()=>{if(active?.demo&&active.playing){cancelAnimationFrame(frame);tick(performance.now());}});
  document.addEventListener('click',event=>{const retry=event.target.closest('[data-video-retry]');if(!retry)return;event.preventDefault();event.stopPropagation();const n=P().nodes.find(n=>n.id===retry.dataset.videoRetry);if(n)requestInfo(n,P().id,true);},true);
  document.addEventListener('dblclick',event=>{if(event.target.closest('[data-video-retry]'))event.stopPropagation();},true);
  document.addEventListener('error',event=>{if(event.target.matches?.('.fw-video-cover img'))event.target.remove();},true);
  resizeObserver=new ResizeObserver(sync);resizeObserver.observe($('canvasEngine'));
  if(new URLSearchParams(location.search).has('video-demo'))demoProject();
}
window.FWVideo={init,nodeMarkup,open,stop,parseLink,extractLink,addLink,isPlaying:id=>!!active&&active.id===id&&active.projectId===P().id,acceptsLink:text=>{const url=extractLink(text),info=url&&parseLink(url);return !!info&&info.provider!=='link';}};
})();
