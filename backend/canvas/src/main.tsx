import React, { useCallback, useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import ExcalidrawCanvas from './ExcalidrawCanvas'
import type { CanvasEvent, EditorHandle, Snapshot } from './types'
import './shell.css'
import './object-interactions.css'

const empty:Snapshot={projectId:'empty',session:0,mode:'author',cards:[],links:[],selected:null,linkFrom:null}
const sameContext=(a:Snapshot,b:Snapshot)=>a.projectId===b.projectId&&a.session===b.session&&a.mode===b.mode
function App(){
 const [snapshot,setSnapshot]=useState<Snapshot>(empty)
 const [notice,setNotice]=useState('')
 const [showHelp,setShowHelp]=useState(false)
 const handle=useRef<EditorHandle|null>(null)
 const handleProject=useRef('')
 const exportMenu=useRef<HTMLDetailsElement>(null)
 const latest=useRef(snapshot);latest.current=snapshot
 const noticeTimer=useRef<ReturnType<typeof setTimeout>|undefined>(undefined)
 const report=useCallback((message:string)=>{setNotice(message);clearTimeout(noticeTimer.current);noticeTimer.current=setTimeout(()=>setNotice(''),6000)},[])
 const send=useCallback((event:CanvasEvent)=>{
   if(!sameContext(snapshot,latest.current))return
   if(event.type==='notice'){report(event.message);return}
   window.parent.postMessage({channel:'forkwise-canvas',event,engine:'excalidraw',projectId:snapshot.projectId,session:snapshot.session,mode:snapshot.mode},window.location.origin)
 },[report,snapshot.projectId,snapshot.session,snapshot.mode])
 const openHelp=(open:boolean)=>{if(snapshot.backend){send({type:'notice',message:'当前画布连接本机后端。研究操作由服务校验并保存；右侧编辑、条件与任务使用当前对象。绘图和排版单独保存，版本冲突时保留本地草稿。'});return}setShowHelp(open);send({type:'overlay',open})}
 useEffect(()=>{
   const listener=(event:MessageEvent)=>{
     if(event.source!==window.parent||event.origin!==window.location.origin||event.data?.channel!=='forkwise-study')return
     const data=event.data
     if(data.type==='state'&&data.engine==='excalidraw'){
       const next=data.snapshot as Snapshot
       if(typeof next?.projectId!=='string'||!Number.isFinite(next.session)||next.session<latest.current.session)return
       latest.current=next;setSnapshot(next)
     }
     if(data.type==='command'&&data.engine==='excalidraw'&&data.session===latest.current.session&&data.projectId===latest.current.projectId){
     if(data.command==='reveal-annotation'&&typeof data.id==='string')handle.current?.revealAnnotation(data.id)
     if(data.command==='restore-source'&&typeof data.id?.id==='string'&&Number.isFinite(data.id?.scroll))handle.current?.restoreSource(data.id.id,data.id.scroll)
     if(data.command==='flush')handle.current?.flush()
     if(data.command==='fit'){
       const context=latest.current
       requestAnimationFrame(()=>{if(sameContext(context,latest.current)&&handleProject.current===context.projectId)handle.current?.fit()})
     }
      if(data.command==='reveal'&&typeof data.id==='string'){
        const context=latest.current,id=data.id
        requestAnimationFrame(()=>requestAnimationFrame(()=>{if(sameContext(context,latest.current)&&handleProject.current===context.projectId)handle.current?.reveal(id)}))
      }
      if(data.command==='focus-range'&&Array.isArray(data.id)&&data.id.every((id:unknown)=>typeof id==='string')){
        const context=latest.current,ids=[...data.id] as string[]
        requestAnimationFrame(()=>requestAnimationFrame(()=>{if(sameContext(context,latest.current)&&handleProject.current===context.projectId)handle.current?.focusRange(ids)}))
      }
     }
   }
   window.addEventListener('message',listener)
   window.parent.postMessage({channel:'forkwise-canvas',ready:true},window.location.origin)
   return()=>window.removeEventListener('message',listener)
 },[])
 const onReady=useCallback((next:EditorHandle|null)=>{
   if(next){if(snapshot.projectId!==latest.current.projectId)return;handle.current=next;handleProject.current=snapshot.projectId}
   else if(handleProject.current===snapshot.projectId){handle.current=null;handleProject.current=''}
 },[snapshot.projectId])
 useEffect(()=>{setNotice('');clearTimeout(noticeTimer.current)},[snapshot.projectId])
 const exporter=async(kind:'exportFile'|'exportSvg'|'exportPng')=>{
   if(exportMenu.current)exportMenu.current.open=false
   try{await handle.current?.[kind]()}catch(error){report(error instanceof Error?error.message:'导出未完成，请再试一次。')}
 }
 return <div className={`canvas-shell${snapshot.history?' unified-history':''}`}>
   <div className="native-editor" key={snapshot.projectId}>
     <ExcalidrawCanvas snapshot={snapshot} onEvent={send} onReady={onReady}/>
   </div>
   <div className="canvas-extras" aria-label="画布文件与使用说明">
     {snapshot.history&&<><button data-history="undo" disabled={!snapshot.history.undoLabel} title={snapshot.history.undoLabel?`撤销：${snapshot.history.undoLabel}`:'暂无可撤销操作'} onClick={()=>{handle.current?.flush();send({type:'history',direction:'undo'})}}>撤销</button><button data-history="redo" disabled={!snapshot.history.redoLabel} title={snapshot.history.redoLabel?`重做：${snapshot.history.redoLabel}`:'暂无可重做操作'} onClick={()=>{handle.current?.flush();send({type:'history',direction:'redo'})}}>重做</button></>}
     <button className="new-claim" onClick={()=>handle.current?.newClaim()}>＋ 新建卡</button>
     <button onClick={()=>handle.current?.search()}>搜索画布</button>
     <details ref={exportMenu}><summary>导出画布</summary><div className="export-menu">
       <button onClick={()=>exporter('exportFile')}>.excalidraw 文件</button>
       <button onClick={()=>exporter('exportSvg')}>SVG 图片</button><button onClick={()=>exporter('exportPng')}>PNG 图片</button>
     </div></details>
     <label className="import-canvas" tabIndex={0} onKeyDown={event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();event.currentTarget.querySelector('input')?.click()}}}>导入画布<input type="file" accept=".excalidraw,.json" onChange={async event=>{
       const input=event.currentTarget,file=input.files?.[0],context=latest.current,editor=handle.current;if(!file||!editor)return;
       try{const text=await file.text();if(!sameContext(context,latest.current)||handle.current!==editor)return;await editor.loadScene(JSON.parse(text));if(sameContext(context,latest.current))report('画布已导入为普通绘图，当前研究卡片与判断保留。')}
       catch(error){if(sameContext(context,latest.current))report(error instanceof Error?error.message:'文件无法导入，请使用当前编辑器的画布文件。')}
       finally{input.value=''}
     }}/></label><button onClick={()=>openHelp(!showHelp)} aria-expanded={showHelp}>使用说明</button>
   </div>
   {showHelp&&<section className="canvas-help"><button className="close-help" onClick={()=>openHelp(false)} aria-label="关闭使用说明">×</button><h2>在同一张画布上研究和批注</h2>
     <p>自由画图、写文字、贴图片。选中自由文字或带文字的矩形，点“原位置转为研究卡”，确认后替换原对象，可一次撤销。也可点击“＋ 新建卡”。研究卡“更多 → 复制为独立研究卡”生成独立副本，保留内容起点与材料，默认待研究，不复制连线及个人判断。</p>
     <p>选中一张画布图片，点“加入卡内材料”，再点击目标研究卡；随后在卡内材料列表阅读原图片。画布图片保留，材料不会自动成为证据。点“搜索画布”或按 ⌘/Ctrl+F 查找卡片、推导说明和自由文字，点击结果定位，可返回搜索前的位置。</p>
     <p>在“更多工具 → 画框工具”画出 Frame，把整张研究卡拖入即可纳入；拖动框架连同成员卡移动，关联推导与随动批注跟随。拖出则退出，缩放框架不缩放研究卡，删除框架保留卡片与推导。Frame 名称用于组织画布，不改变推理关系。</p>
     <p>{snapshot.directCanvas?'直接把':'收录后，把'} A 拖到 B 上，建立 B → A。普通图形、手绘和未连接两张研究卡的箭头保留为自由批注。</p>
     <p>单击主张卡或推导的任意线段{snapshot.directCanvas?'，画布高亮相邻的推导、前提与结论；只查看，不修改内容或立场。再从浮动工具条选择主张“改写”或推导“说明”、“查证与立场”或“更多”。':'只选中对象，再从浮动工具条选择“改写”“立场”“查证”“来源”“推导”或“AI”。'}“更多”单列提供来源、AI 讨论、待查问题、修改记录、样式、聚焦和删除。{snapshot.directCanvas?'待查问题也从“更多”进入；主张卡另有“试一个假设”，临时查看前提不成立的影响。选中线上推导可“删除这步推导”，解除这一步的全部连线，前提与结论卡保留，可撤销。':''}Shift 点选或框选可多选，工具条显示数量，{snapshot.directCanvas?'可排列、调整样式或聚焦；直接在画布选择对象，无需另开范围清单。':snapshot.history?'多选个人对象后可排列、调整样式或聚焦；候选模式可收录所选范围。':'多选只提供 AI、样式和聚焦。'}</p>
     <p>研究卡完整显示主张，高度随正文调整；推导仍显示在线上。双击{snapshot.directCanvas?'研究':'个人'}对象或点击“改写”打开文字编辑，修改正文后直接保存并回到画布。系统自动记录改前、改后和时间。内容起点“来源／用户／AI”保留；个人内容改写后显示“我已编辑”，从“更多 → 修改记录”回看。{snapshot.directCanvas?'同一前提被多步推导引用时，保存前明确选择只修改哪一步，或更新全部引用。':''}</p>
     <p>个人立场用灰色“待研究”、绿色“认可”、橙色“质疑”、红色“不认可”标签显示。直接点击标签或工具条{snapshot.directCanvas?'“查证与立场”':'“立场”'}，先选择立场，再按需填写理由，点“保存立场”才更新画布。待研究无需理由，认可依据可选，质疑和不认可须写具体理由。{snapshot.directCanvas?'同一窗口左边查看查证摘要、展开原句依据，右边表达立场；窄窗上下排列。再次打开标签，展开“立场变化”回看最近一次的前后立场、理由和当时内容；更早变化按需展开。立场或理由没有改变时，重复保存不新增记录。查证未完成也能先判断，重新查证保留立场和草稿。':'理由从当前对象的立场窗口回看。'}选项和文字会作为草稿保留，取消则放弃这次填写。</p>
     <p>第一次研究只需选一句话、查看依据并记录判断、回到画布看标签。其他工具按需使用，可从“使用说明”或右上“使用引导 → 完整工具说明”查看。</p>
     <p>“查证与立场”先展示内容期间与本次查证时点。未来验证节点由 AI 提出候选（模拟），你确认或修改后收成摘要，继续查看当前依据。事件或日期不明确时保留缺口；确认节点不改变预测结果、个人立场或开启提醒。每条依据按出处与时间、关键原文、标明 AI 的解读、查看原文阅读，完整来路与版本按需展开。</p>
     <p>原文阅读顶部明确返回原来的查证与立场、来源或材料列表，保留展开依据、滚动位置和未保存草稿；× 退出到画布。公开查证将限定在维护的免费公开数据源目录，本原型仍使用模拟样本，没有接入真实取数。</p>
     <p>点击“来源”后查看本次引用的原文、已保存摘录或材料。只有记录了原始网址时才提供“打开原始网页”，网站内容可能已更新。{snapshot.directCanvas?'来源整理有误时，可在未作个人改写前“校正整理结果”；校正与个人改写分开记录。编辑、整理和查看都不自动表示认可，立场始终单独记录。':'查证与个人立场分别处理，候选收录后才可改写或删除。'}</p>
     <p>选择下方箭头工具（快捷键 5），按住鼠标从前提卡拖画到结论卡，松手直接建立推导。连接端吸附到所在边的居中点；画到空白或普通图形仍为自由箭头。也可以从选中卡片任意边的圆形“＋”，拖到结论卡任意边，新建前提 → 结论。拖动时目标卡显示四个落点。选中连线后拖方形端点重连到任意边；换同一张卡的连接边只调整布局，判断保留。用“＋”拖线时，空白处松手或 Esc 取消。也可按 Enter 点选目标、预览后保存。默认只画箭头，说明选填。</p>
     <p>左上“语义密度”同步切换整张画布：L0 草稿只看正文与连线；L1 归属增加内容起点和研究状态；L2 判断增加个人立场与查证状态；L3 全开展示摘要及来源入口。信息收起时仍可选中对象打开完整任务窗口。切换不修改判断或形成编辑历史。</p>
     <p>“更多 → 材料”进入文件列表，添加本机文本、图片或 PDF，点文件同窗阅读、再返回列表。PDF 可翻页；图片可人工框选引用区域，文本可选句记录引用。原文件和材料版本随本机存档保留，添加材料不自动表达立场。</p>
     <p>选中自由文字、手绘、形状或图片，点击“附着到对象”，再点击卡片或连线。批注会随它移动；单独移动批注可调整相对位置。“解除随动”后留在原处，删除所属对象也保留批注。复制得到自由副本。</p>
     <p>两种连接入口的新推导都采用蓝灰、1.5px 实线和简洁风格。研究对象的外观从“更多 → 线条样式／卡片样式”调整；下方箭头模式收起原生样式面板，选中研究推导时只保留对象样式窗口。已有线的个人样式保留，可在该窗口“恢复默认”。选中自由批注仍使用原生属性。样式不改变内容起点、个人立场、查证或内容版本；可恢复默认或撤销这次样式。聚焦只缩放所选对象及相邻前提、结论，全图保留，通过“返回上次视图”恢复位置。</p>
     <p>{snapshot.history?'研究修改、批注、样式和排版共用撤销／重做。编辑文字时仍可撤销当前输入；退出文字编辑后，⌘/Ctrl Z 撤销完整操作。研究、批注、视口、选择与未提交草稿自动保存在本机。':'本轮仍保留两种历史：原生撤销处理绘图；“撤销研究”处理主张、推导与判断。刷新后本次页面内容清空。'}</p>
     <p>选中研究卡、推导线或图形后，Delete／Backspace 删除所选对象；Shift 多选可一起删除。删除卡片会移除关联推导，删除推导保留卡片。⌘/Ctrl Z 撤销；编辑文字时只删除文字，Esc 取消操作或选择。</p>
     <p>导出的画布文件用于保存绘图，不能代替包含材料、证据与历史的研究档案。文件导入只进入绘图层。</p>
     <p>右上“研究工具”展开研究问题、材料、查证、整理原版及引导，选完收起。研究资料从“材料”或对象的“更多 → 材料”进入；绘图素材库入口已移除。</p>
     <p>所有资源在本机加载。线上协作、云账户与 AI 服务尚未接入。</p>
   </section>}
   {notice&&<div className="canvas-notice" role="status">{notice}</div>}
 </div>
}
createRoot(document.getElementById('root')!).render(<App/> )
