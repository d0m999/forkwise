import { useEffect, useState } from 'react'
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types'
import type { CanvasEvent, PortSide, Snapshot } from './types'
import { objectSelection } from './objectTools'
import { nearestSide, portPoint, sideNames, sides } from './connectionGeometry'

type Gesture={from?:string;id?:string;end?:'premise'|'conclusion';previous?:string; side:PortSide; x:number;y:number}
type Target={id:string;side:PortSide}
type Props={selectedRelations:string[];api:ExcalidrawImperativeAPI;snapshot:Snapshot;onEvent:(event:CanvasEvent)=>void;flush:()=>void}
export default function ConnectionControls({api,snapshot,selectedRelations,onEvent,flush}:Props){
  const [,refresh]=useState(0),[hover,setHover]=useState<string|null>(null),[gesture,setGesture]=useState<Gesture|null>(null),[point,setPoint]=useState({x:0,y:0}),[pick,setPick]=useState<Gesture|null>(null),[proposed,setProposed]=useState<Target|null>(null)
  const app=api.getAppState(),z=app.zoom.value,elements=api.getSceneElements()
  const selection=objectSelection(elements,app.selectedElementIds,app.selectedGroupIds,selectedRelations)
  const selected=snapshot.cards.find(c=>selection.ids.length===1&&selection.ids[0]===c.id)
  const shape=(id:string)=>elements.find(e=>e.customData?.forkwisePart==='card'&&e.customData.forkwiseId===id)
  const box=(id:string)=>{const e=shape(id);return e?{x:(e.x+app.scrollX)*z,y:(e.y+app.scrollY)*z,width:e.width*z,height:e.height*z}:null}
  const spot=(id:string,side:PortSide)=>{const b=box(id);return b?portPoint(b,side):null}
  const targetAt=(x:number,y:number):Target|null=>{const card=[...snapshot.cards].reverse().find(c=>{const b=box(c.id);return c.kind==='claim'&&b&&x>=b.x-14&&x<=b.x+b.width+14&&y>=b.y-14&&y<=b.y+b.height+14});return card?{id:card.id,side:nearestSide(box(card.id)!,{x,y})}:null}
  const action=(g:Gesture,target:Target)=>g.id?{type:'reconnect' as const,id:g.id,end:g.end!,previous:g.previous,target:target.id,side:target.side}:{type:'connect' as const,from:g.from!,to:target.id,fromSide:g.side,toSide:target.side}
  const error=(g:Gesture,target:string|null)=>{
    if(!target)return '请落在主张卡片上；空白松手取消'
    const edge=g.id?snapshot.cards.find(c=>c.id===g.id):null
    const inputs=g.id?snapshot.links.filter(l=>l.to===g.id).map(l=>l.from).map(id=>g.end==='premise'&&id===g.previous?target:id):[g.from!]
    const conclusion=g.id?(g.end==='conclusion'?target:snapshot.links.find(l=>l.from===g.id)?.to):target
    if(inputs.includes(conclusion!)||new Set(inputs).size!==inputs.length)return '不能自连或重复同一步的前提'
    const visited=new Set<string>(),queue=[conclusion!]
    while(queue.length){const id=queue.pop()!;if(inputs.includes(id))return '这次连接会形成回环';if(visited.has(id))continue;visited.add(id);for(const step of snapshot.cards.filter(c=>c.kind==='inference'&&c.id!==edge?.id)){if(snapshot.links.some(l=>l.to===step.id&&l.from===id))queue.push(snapshot.links.find(l=>l.from===step.id)?.to??'')}}
    const duplicate=snapshot.cards.some(c=>c.kind==='inference'&&c.id!==g.id&&(c.combination||'单一前提')===(edge?.combination||'单一前提')&&snapshot.links.find(l=>l.from===c.id)?.to===conclusion&&JSON.stringify(snapshot.links.filter(l=>l.to===c.id).map(l=>l.from).sort())===JSON.stringify([...inputs].sort()))
    return duplicate&&!snapshot.backend?'这一步已经存在，不重复建立':''
  }
  useEffect(()=>api.onChange(()=>refresh(n=>n+1)),[api])
  useEffect(()=>{
    const move=(event:PointerEvent)=>{
      const x=event.clientX-app.offsetLeft,y=event.clientY-app.offsetTop
      if(gesture)setPoint({x,y});else if(!event.buttons)setHover(targetAt(x,y)?.id??null)
    }
    const up=(event:PointerEvent)=>{
      if(!gesture)return
      const target=targetAt(event.clientX-app.offsetLeft,event.clientY-app.offsetTop),problem=error(gesture,target?.id??null)
      setGesture(null)
      if(problem){onEvent({type:'notice',message:problem+'；原连接保留。'});return}
      onEvent(action(gesture,target!))
    }
    const key=(event:KeyboardEvent)=>{if(event.key==='Escape'&&(gesture||pick)){event.preventDefault();setGesture(null);setPick(null);setProposed(null);onEvent({type:'notice',message:'已取消连接，原结构保留。'})}}
    const cancel=()=>{setGesture(null);setPick(null);setProposed(null)};window.addEventListener('pointercancel',cancel);window.addEventListener('blur',cancel);window.addEventListener('pointermove',move);window.addEventListener('pointerup',up);window.addEventListener('keydown',key,true)
    return()=>{window.removeEventListener('pointercancel',cancel);window.removeEventListener('blur',cancel);window.removeEventListener('pointermove',move);window.removeEventListener('pointerup',up);window.removeEventListener('keydown',key,true)}
  },[api,snapshot,gesture,pick,app.scrollX,app.scrollY,z])
  useEffect(()=>{setGesture(null);setPick(null);setProposed(null)},[snapshot.projectId,snapshot.session,snapshot.mode])
  const start=(event:React.PointerEvent,g:Gesture)=>{event.preventDefault();event.stopPropagation();event.currentTarget.setPointerCapture(event.pointerId);flush();setPoint({x:event.clientX-app.offsetLeft,y:event.clientY-app.offsetTop});setGesture(g)}
  if(app.activeTool.type!=='selection'&&!gesture&&!pick)return null
  const buttons:React.ReactNode[]=[]
  const activeTarget=gesture?targetAt(point.x,point.y):null
  const port=(id:string)=>{for(const side of sides){const at=spot(id,side);if(!at)continue;buttons.push(<button key={id+side} className={`connection-port${gesture?' drop-port':''}${activeTarget?.id===id&&activeTarget.side===side?' active':''}`} data-port={id} data-side={side} aria-label={`从此卡${sideNames[side]}拖线到结论`} title="从任意边拖到目标卡任意边；也可按 Enter 点选" style={{left:at.x-12,top:at.y-12}} onPointerDown={e=>{if(!gesture)start(e,{from:id,side,...at})}} onKeyDown={e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();flush();setProposed(null);setPick({from:id,side,...at})}}}>＋</button>)}}
  if(selected?.kind==='claim')port(selected.id)
  const hovering=gesture?activeTarget?.id:hover
  if(hovering&&hovering!==selected?.id)port(hovering)
  const handles:Gesture[]=[]
  if(selected?.kind==='inference'){
    for(const link of snapshot.links.filter(l=>l.to===selected.id)){const side=link.fromSide||'right',at=spot(link.from,side);if(at)handles.push({id:selected.id,end:'premise',previous:link.from,side,...at})}
    const output=snapshot.links.find(l=>l.from===selected.id),side=output?.toSide||'left',at=output&&spot(output.to,side);if(at)handles.push({id:selected.id,end:'conclusion',side,...at})
  }
  for(const g of handles)buttons.push(<button key={g.previous||'conclusion'} className="connection-port endpoint" data-endpoint={g.end} data-side={g.side} data-premise={g.previous} aria-label={`拖动更换${g.end==='premise'?'前提':'结论'}`} title="拖到另一张卡重连；按 Enter 可点选" style={{left:g.x-12,top:g.y-12}} onPointerDown={e=>start(e,g)} onKeyDown={e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();flush();setProposed(null);setPick(g)}}}/> )
  const target=activeTarget,problem=gesture?error(gesture,target?.id??null):'',preview=target?spot(target.id,target.side):point
  return <div className="connection-controls">
    {!pick&&buttons}
    {gesture&&<><svg className="connection-preview"><path d={`M${gesture.x},${gesture.y} L${preview?.x},${preview?.y}`} fill="none" stroke={problem?'#8a3f48':'#276e68'} strokeWidth="3" strokeDasharray="7 4"/></svg><div className="connection-status" role="status">{problem||'松手连接到'+sideNames[target!.side]+'；方向仍为 前提 → 结论'}</div></>}
    {handles.length>0&&!gesture&&!pick&&<div className="connection-actions research-ui"><button onClick={()=>{flush();setPick(handles[0])}}>更换前提</button><button onClick={()=>{flush();setPick(handles.at(-1)! )}}>更换结论</button><span>拖端点也可重连</span></div>}
    {pick&&<><div className="connection-pick research-ui"><strong>{pick.id?'选择新的'+(pick.end==='premise'?'前提':'结论'):'选择结论卡'}</strong>{pick.end==='premise'&&handles.length>2&&<select aria-label="待更换前提" value={pick.previous} onChange={e=>setPick(handles.find(g=>g.previous===e.target.value)!)}>{handles.filter(g=>g.end==='premise').map(g=><option key={g.previous} value={g.previous}>{snapshot.cards.find(c=>c.id===g.previous)?.text}</option>)}</select>}<p>{proposed?error(pick,proposed.id)||'连接到'+sideNames[proposed.side]+'；保存后更新':'点击图上目标卡，预览后保存'}</p><button onClick={()=>{setPick(null);setProposed(null)}}>取消</button><button disabled={!proposed||!!error(pick,proposed.id)} onClick={()=>{onEvent(action(pick,proposed!));setPick(null);setProposed(null)}}>保存连接</button></div>{snapshot.cards.filter(c=>c.kind==='claim').map(c=>{const e=shape(c.id);return e&&<button key={c.id} className="connection-target" aria-label={`选择连接目标：${c.text}`} style={{left:(e.x+app.scrollX)*z,top:(e.y+app.scrollY)*z,width:e.width*z,height:e.height*z,borderColor:proposed?.id===c.id?'#276e68':'transparent'}} onClick={event=>setProposed({id:c.id,side:nearestSide(box(c.id)!,{x:event.clientX-app.offsetLeft,y:event.clientY-app.offsetTop})})}/>})}{snapshot.cards.filter(c=>c.kind==='claim').flatMap(c=>sides.map(side=>{const at=spot(c.id,side);return at&&<button key={c.id+side} className={`connection-port pick-port${proposed?.id===c.id&&proposed.side===side?' active':''}`} aria-label={`选择连接目标${sideNames[side]}：${c.text}`} data-target-port={c.id} data-side={side} style={{left:at.x-12,top:at.y-12}} onClick={()=>setProposed({id:c.id,side})}>＋</button>}))}</>}
  </div>
}
