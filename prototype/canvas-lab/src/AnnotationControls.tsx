import { useEffect, useState } from 'react'
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types'
import type { CanvasEvent, CanvasPersistence, Snapshot } from './types'
import { targetAnchor } from './reasoningGeometry'
import { objectSelection } from './objectTools'

type Props={selectedRelations:string[];api:ExcalidrawImperativeAPI;snapshot:Snapshot;flush:()=>void;getState:()=>CanvasPersistence;commit:(state:CanvasPersistence,label:string)=>void;convert:(ids:string[],from:string,to:string)=>void;onEvent:(event:CanvasEvent)=>void;promoteText:()=>void}
export default function AnnotationControls({api,snapshot,selectedRelations,flush,getState,commit,convert,onEvent,promoteText}:Props){
 const [imagePicking,setImagePicking]=useState(false)
 const [,refresh]=useState(0),[picking,setPicking]=useState(false),[conversion,setConversion]=useState<{from:string;to:string;pick:'from'|'to'}|null>(null)
 const app=api.getAppState(),elements=api.getSceneElements(),selection=objectSelection(elements,app.selectedElementIds,app.selectedGroupIds,selectedRelations),free=selection.free.filter(e=>!e.isDeleted),ids=free.map(e=>e.id)
 useEffect(()=>api.onChange(()=>refresh(n=>n+1)),[api])
 useEffect(()=>{setPicking(false);setConversion(null);setImagePicking(false)},[snapshot.projectId,snapshot.session,snapshot.mode])
 useEffect(()=>{const key=(e:KeyboardEvent)=>{if(e.key==='Escape'){setPicking(false);setConversion(null);setImagePicking(false)}};window.addEventListener('keydown',key);return()=>window.removeEventListener('keydown',key)},[])
 if(!snapshot.history||!snapshot.simpleLinks||!free.length||selection.ids.length)return null
 const bound=ids.some(id=>snapshot.canvasState?.attachments?.[id])
 const singleArrow=free.length===1&&free[0].type==='arrow'
 const hasText=elements.some(e=>e.type==='text'&&!e.customData?.forkwisePart&&(app.selectedElementIds[e.id]||e.containerId&&app.selectedElementIds[e.containerId]))
 const image=free.length===1&&free[0].type==='image'?free[0]:null
 const addImage=(id:string)=>{
  const file=image?.fileId&&api.getFiles()[image.fileId]
  if(!image||!file){onEvent({type:'notice',message:'未取得原图片文件，请重新导入图片。'});return}
  if(!/^data:image\/(png|jpeg|webp|gif);base64,/.test(file.dataURL)||file.dataURL.length>Math.ceil(16*1024*1024*4/3)+128){onEvent({type:'notice',message:'请使用 16 MB 以内的 PNG、JPEG、WebP 或 GIF 图片。'});return}
  const captured=image,picture=new Image()
  picture.onload=()=>{onEvent({type:'image-material',id,imageId:captured.id,fileId:String(captured.fileId),data:file.dataURL,width:picture.naturalWidth,height:picture.naturalHeight})}
  picture.onerror=()=>onEvent({type:'notice',message:'图片未能读取，尚未加入材料。'})
  flush();picture.src=file.dataURL;setImagePicking(false)
 }
 const bind=(target?:string)=>{
  flush();const state=getState(),anchor=target?targetAnchor(elements,target):null
  state.attachments??={}
  for(const id of ids){if(anchor&&target)state.attachments[id]={target,mode:snapshot.mode,...anchor};else delete state.attachments[id]}
  if(target)state.annotations.elements=state.annotations.elements.map(value=>{const e=value as Record<string,unknown>;return ids.includes(String(e.id))?{...e,frameId:null}:e})
  commit(state,target?'批注附着到研究对象':'解除批注随动');setPicking(false)
 }
 return <div className="annotation-controls">
  <div className="research-ui annotation-toolbar"><strong>{singleArrow?'批注箭头':image?'画布图片':`自由批注 · ${free.length} 项`}</strong>{hasText&&<button onClick={promoteText}>原位置转为研究卡</button>}{image&&<button onClick={()=>{setImagePicking(true);setPicking(false);setConversion(null)}}>加入卡内材料</button>}<button onClick={()=>{setPicking(true);setImagePicking(false);setConversion(null)}}>{bound?'重新附着':'附着到对象'}</button>{bound&&<button onClick={()=>bind()}>解除随动</button>}{singleArrow&&<button onClick={()=>{setPicking(false);setImagePicking(false);setConversion({from:'',to:'',pick:'from'})}}>整理为推导</button>}</div>
  {imagePicking&&<><div className="annotation-prompt research-ui">点击目标研究卡，将原图片保存到它的材料列表。画布图片保留。<button onClick={()=>setImagePicking(false)}>取消</button></div>{snapshot.cards.filter(c=>c.kind==='claim').map(c=>{const e=elements.find(e=>e.customData?.forkwisePart==='card'&&e.customData.forkwiseId===c.id);return e&&<button key={c.id} className="connection-target" aria-label={`图片加入材料：${c.text}`} style={{left:(e.x+app.scrollX)*app.zoom.value,top:(e.y+app.scrollY)*app.zoom.value,width:e.width*app.zoom.value,height:e.height*app.zoom.value}} onClick={()=>addImage(c.id)}/>})}</>}
  {picking&&<><div className="annotation-prompt research-ui">点击卡片或连线，批注会随它移动{free.some(e=>e.frameId)&&<p>附着后移出原框架，避免重复随动；可撤销。</p>}<button onClick={()=>setPicking(false)}>取消</button></div>{snapshot.cards.map(c=>{const e=elements.find(e=>e.customData?.forkwisePart==='card'&&e.customData.forkwiseId===c.id);return e&&<button key={c.id} className="connection-target" aria-label={`附着到：${c.text||'这步推导'}`} style={{left:(e.x+app.scrollX)*app.zoom.value,top:(e.y+app.scrollY)*app.zoom.value,width:e.width*app.zoom.value,height:e.height*app.zoom.value}} onClick={()=>bind(c.id)}/>})}</>}
  {conversion&&<><div className="annotation-prompt research-ui"><strong>把批注箭头整理为推导</strong><p>在图上点击{conversion.pick==='from'?'前提':'结论'}卡</p><button onClick={()=>setConversion({...conversion,pick:'from'})}>1 · 选择前提</button><button onClick={()=>setConversion({...conversion,pick:'to'})}>2 · 选择结论</button><p>{conversion.from&&conversion.to?`${snapshot.cards.find(c=>c.id===conversion.from)?.text} → ${snapshot.cards.find(c=>c.id===conversion.to)?.text}`:'普通箭头仍是批注，保存后才成为推导。'}</p><button onClick={()=>setConversion(null)}>取消</button><button disabled={!conversion.from||!conversion.to||conversion.from===conversion.to} onClick={()=>{flush();convert(ids,conversion.from,conversion.to);setConversion(null)}}>保存为推导</button></div>{snapshot.cards.filter(c=>c.kind==='claim').map(c=>{const e=elements.find(e=>e.customData?.forkwisePart==='card'&&e.customData.forkwiseId===c.id);return e&&<button key={c.id} className="connection-target" aria-label={`作为${conversion.pick==='from'?'前提':'结论'}：${c.text}`} style={{left:(e.x+app.scrollX)*app.zoom.value,top:(e.y+app.scrollY)*app.zoom.value,width:e.width*app.zoom.value,height:e.height*app.zoom.value,borderColor:[conversion.from,conversion.to].includes(c.id)?'#276e68':'transparent'}} onClick={()=>setConversion({...conversion,[conversion.pick]:c.id,pick:conversion.pick==='from'?'to':'to'})}/>})}</>}
 </div>
}
