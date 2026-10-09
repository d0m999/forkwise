import {useEffect,useRef,useState} from 'react'
import {CaptureUpdateAction} from '@excalidraw/excalidraw'
import type {ExcalidrawImperativeAPI} from '@excalidraw/excalidraw/types'
import type {CanvasEvent,CanvasView,Snapshot} from './types'
import {canvasView} from './canvasPersistence'

type Props={api:ExcalidrawImperativeAPI;snapshot:Snapshot;register:(open:()=>void)=>void;onEvent:(event:CanvasEvent)=>void;selectedRelations:string[];selectRelations:(ids:string[])=>void}
export default function CanvasSearch({api,snapshot,register,onEvent,selectedRelations,selectRelations}:Props){
 const [open,setOpen]=useState(false),[query,setQuery]=useState(''),[located,setLocated]=useState(false)
 const before=useRef<CanvasView|null>(null),input=useRef<HTMLInputElement>(null)
 const launch=()=>{if(!open){before.current={...canvasView(api.getAppState()),relationIds:[...selectedRelations]};setLocated(false)}setOpen(true)}
 useEffect(()=>{register(launch)},[api,open,selectedRelations])
 useEffect(()=>{if(open)input.current?.focus()},[open])
 useEffect(()=>{setOpen(false);setQuery('');setLocated(false);before.current=null},[snapshot.projectId,snapshot.mode,snapshot.session])
 useEffect(()=>{
  const key=(event:KeyboardEvent)=>{
   // Native tool buttons are radio inputs. They must not be mistaken for a text editor.
   const writing=(event.target as HTMLElement).closest('textarea,input:not([type="radio"]):not([type="checkbox"]):not([type="button"]),[contenteditable="true"]')
   if((event.metaKey||event.ctrlKey)&&event.key.toLowerCase()==='f'&&!writing){event.preventDefault();event.stopImmediatePropagation();launch()}
   if(event.key==='Escape'&&open){event.preventDefault();event.stopImmediatePropagation();setOpen(false)}
  }
  window.addEventListener('keydown',key,true);return()=>window.removeEventListener('keydown',key,true)
 },[open,selectedRelations])
 if(!open)return null
 const term=query.trim().toLocaleLowerCase(),scene=api.getSceneElements(),matches=term?[
  ...snapshot.cards.filter(c=>c.text.toLocaleLowerCase().includes(term)).map(c=>({id:c.id,text:c.text,kind:c.kind==='claim'?'研究卡':'推导说明',domain:true})),
  ...scene.filter(e=>e.type==='text'&&!e.customData?.forkwisePart&&e.originalText.toLocaleLowerCase().includes(term)).map(e=>({id:e.id,text:e.type==='text'?e.originalText:'',kind:'自由文字',domain:false}))
 ]:[]
 const locate=(id:string,domain:boolean)=>{
  const targets=scene.filter(e=>domain?e.customData?.forkwiseId===id:e.id===id)
  if(!targets.length){onEvent({type:'notice',message:'对象已经移除，请重新搜索。'});return}
  const inference=domain&&snapshot.cards.find(c=>c.id===id)?.kind==='inference'
  selectRelations(inference?[id]:[])
  api.updateScene({appState:{selectedElementIds:inference?{}:Object.fromEntries(targets.map(e=>[e.id,true as const])),selectedGroupIds:inference?{}:Object.fromEntries(targets.flatMap(e=>e.groupIds.map(group=>[group,true]))),editingGroupId:null},captureUpdate:CaptureUpdateAction.NEVER})
  api.scrollToContent(targets,{animate:false,minZoom:0.65,maxZoom:1})
  if(domain)onEvent({type:'select',id})
  setLocated(true)
 }
 const back=()=>{if(before.current){const v=before.current;selectRelations(v.relationIds??[]);api.updateScene({appState:{scrollX:v.scrollX,scrollY:v.scrollY,zoom:v.zoom as ReturnType<typeof api.getAppState>['zoom'],selectedElementIds:v.selectedElementIds,selectedGroupIds:v.selectedGroupIds},captureUpdate:CaptureUpdateAction.NEVER});setLocated(false)}}
 return <section className="research-ui canvas-search" role="dialog" aria-label="搜索画布">
  <header><strong>搜索当前画布</strong><button aria-label="关闭搜索" onClick={()=>setOpen(false)}>×</button></header>
  <input ref={input} aria-label="搜索卡片、推导说明或自由文字" placeholder="卡片、推导说明或自由文字" value={query} onChange={e=>setQuery(e.target.value)}/>
  <p className="search-summary">{term?`${matches.length} 项匹配`:'输入文字，点击结果定位。材料全文暂不搜索。'}</p>
  <div className="search-results">{matches.map(m=><button key={`${m.domain}:${m.id}`} onClick={()=>locate(m.id,m.domain)}><small>{m.kind}</small><span>{m.text}</span></button>)}{term&&!matches.length&&<p>没有匹配内容</p>}</div>
  <footer><button disabled={!located} onClick={back}>返回搜索前的位置</button><button onClick={()=>setOpen(false)}>完成</button></footer>
 </section>
}
