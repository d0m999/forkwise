import { useCallback, useEffect, useRef, useState } from 'react'
import {
  CaptureUpdateAction,
  Excalidraw,
  convertToExcalidrawElements,
  exportToBlob,
  exportToSvg,
  loadFromBlob,
  serializeAsJSON,
  viewportCoordsToSceneCoords,
} from '@excalidraw/excalidraw'
import type { ExcalidrawElement, ExcalidrawTextElement } from '@excalidraw/excalidraw/element/types'
import type { AppState, BinaryFiles, ExcalidrawImperativeAPI, PointerDownState } from '@excalidraw/excalidraw/types'
import '@excalidraw/excalidraw/index.css'
import { cardResearchStatus, saveBlob } from './types'
import type { CanvasPersistence, Card, EditorProps, Snapshot } from './types'
import { blankCanvasState, captureCanvas, captureCanvasDrafts, captureReturnViews, canvasContentSignature, cloneCanvasState, restoreCanvasDrafts, restoreStyles } from './canvasPersistence'
import ResearchOverlay from './ResearchOverlay'
import { inferenceDefaultStyle, objectSelection } from './objectTools'
import ConnectionControls from './ConnectionControls'
import { nearestSide, portPoint, routePorts, splitRoute, type Point } from './connectionGeometry'
import AnnotationControls from './AnnotationControls'
import CanvasSearch from './CanvasSearch'
import { followAttachments, targetAnchor } from './reasoningGeometry'

// Legacy entries retain page memory; the step entry also persists these layers through its parent.
type MemoryScene = { elements: readonly ExcalidrawElement[]; appState: Partial<AppState>; files: BinaryFiles }
const sceneMemory = new Map<string, MemoryScene>()
const annotationMemory = new Map<string,{elements:readonly ExcalidrawElement[];files:BinaryFiles}>()
const fittedGraphs = new Set<string>()
const keyFor = (snapshot: Snapshot) => `${snapshot.projectId}:${snapshot.mode}`
const sameContext=(a:Snapshot,b:Snapshot)=>a.projectId===b.projectId&&a.session===b.session&&a.mode===b.mode
const rectId = (key: string, id: string) => `forkwise:${key}:card:${id}`
const textId = (key: string, id: string, field='body') => `forkwise:${key}:text:${id}:${field}`
const linkId = (key: string, id: string) => `forkwise:${key}:link:${id}`
const domainId = (element?: ExcalidrawElement | null): string | null => element?.customData?.forkwiseId ?? null
const isDomain = (element?: ExcalidrawElement | null) => Boolean(element?.customData?.forkwisePart)
const styleFields = ['strokeColor', 'backgroundColor', 'fillStyle', 'strokeWidth', 'strokeStyle', 'roughness', 'opacity', 'fontFamily', 'fontSize', 'textAlign'] as const

// Excalidraw 原生工具条、右上角面板与主菜单实测占据画布顶部 16–60px；底部有导出条与缩放控件。
// 研究卡作为画布像素绘制，必然在这些 HTML UI 之下，因此为它们留出安全区：
// 初始布局、看全图与新增对象定位都从安全区下方开始，避免卡片被压在原生工具条下。
const CHROME_TOP = 84
const CHROME_BOTTOM = 108
const CHROME_SIDE = 20
// 低于这个缩放就看不清研究卡正文，此时才允许整体放大定位。
const READABLE_ZOOM = 0.6

// 对象在当前视口中的屏幕矩形，用于判断它是否落在安全区内。
function screenRect(api: ExcalidrawImperativeAPI, elements: readonly ExcalidrawElement[]) {
  const app = api.getAppState(), zoom = app.zoom.value
  const minX = Math.min(...elements.map(element => element.x))
  const minY = Math.min(...elements.map(element => element.y))
  const maxX = Math.max(...elements.map(element => element.x + element.width))
  const maxY = Math.max(...elements.map(element => element.y + element.height))
  return {
    left: (minX + app.scrollX) * zoom, top: (minY + app.scrollY) * zoom,
    right: (maxX + app.scrollX) * zoom, bottom: (maxY + app.scrollY) * zoom,
    width: app.width, height: app.height, zoom,
  }
}

function fitScene(api:ExcalidrawImperativeAPI,elements:readonly ExcalidrawElement[],animate=false){
  const {height,width}=api.getAppState(),limit=Math.max(0,height/3)
  api.scrollToContent(elements,{fitToContent:true,animate,canvasOffsets:{top:Math.min(CHROME_TOP,limit),bottom:Math.min(width<660?CHROME_BOTTOM+52:CHROME_BOTTOM,limit),left:CHROME_SIDE,right:CHROME_SIDE}})
}

function styles(element?: ExcalidrawElement) {
  if (!element) return {}
  const result: Record<string, unknown> = {}
  for (const field of styleFields) if (field in element) result[field] = (element as unknown as Record<string, unknown>)[field]
  return result
}
function removeIdentity(element: ExcalidrawElement): ExcalidrawElement {
  if (!isDomain(element)) return element
  const customData: Record<string, unknown> = { ...element.customData }
  delete customData.forkwiseId
  delete customData.forkwisePart
  delete customData.forkwiseSegment
  delete customData.forkwiseField
  delete customData.forkwiseCheckY
  delete customData.forkwiseCheckHeight
  delete customData.forkwiseFooterY
  delete customData.forkwiseLineY
  return { ...element, customData }
}

const measure = document.createElement('canvas').getContext('2d')!
function wrap(text:string,size:number,width:number){
  measure.font=`${size}px Helvetica, Arial, "PingFang SC", sans-serif`
  return text.split('\n').map(paragraph=>{
    const lines:string[]=[];let line=''
    for(const char of Array.from(paragraph)){
      if(line&&measure.measureText(line+char).width>width){lines.push(line);line=char}else line+=char
    }
    lines.push(line);return lines.join('\n')
  }).join('\n')
}
function relationColor(token:string){
  return getComputedStyle(document.documentElement).getPropertyValue(`--research-${token}`).trim()
}
function stanceColors(stance:string){
  const token=stance==='认可'?'accepted':stance==='质疑'?'questioned':stance==='不认可'?'rejected':'pending'
  const css=getComputedStyle(document.documentElement)
  return {fg:css.getPropertyValue(`--stance-${token}-fg`).trim(),bg:css.getPropertyValue(`--stance-${token}-bg`).trim(),border:css.getPropertyValue(`--stance-${token}-border`).trim()}
}
function cardLayout(card:Card,density=3){
  if(card.noteCard){
    const width=card.width,title=wrap(card.text,16,width-34),body=wrap((card.body||'').replace(/!\[[^\]]*\]\([^\s]+\)/g,'[正文图片]'),14,width-34),bodyY=34+title.split('\n').length*24+16;
    return {width,height:card.height,body:title,summary:body,bodyY:36,lineY:0,comboY:0,stanceY:0,checkY:0,checkHeight:0,footerY:card.height-34,dividerY:bodyY};
  }
  const width=card.kind==='inference'?270:320,pad=20
  const body=wrap(card.text,card.kind==='inference'?14:20,width-(card.kind==='inference'?24:pad*2))
  const bodyHeight=body.split('\n').length*(card.kind==='inference'?21:30)
  if(card.kind==='inference'){
    const bodyY=card.compact?24:44,lineY=bodyY+bodyHeight+9,stanceY=lineY+9,footerY=stanceY
    return {width,height:footerY+26,body,summary:'',bodyY,lineY,comboY:22,stanceY,checkY:0,checkHeight:0,footerY,dividerY:0}
  }
  const summary=wrap(card.verificationSummary||'尚未通过公开资料查证。',13,width-pad*2)
  const bodyY=density>=1?50:20,stanceY=bodyY+bodyHeight+20,checkY=stanceY+34
  const checkHeight=density>=2?(density>=3?22+summary.split('\n').length*19.5:18):0
  const dividerY=checkY+checkHeight+18,footerY=dividerY+14
  const height=density>=3?footerY+34:density>=2?checkY+checkHeight+20:bodyY+bodyHeight+20
  return {width,height,body,summary,bodyY,lineY:0,comboY:0,stanceY,checkY,checkHeight,footerY,dividerY}
}

function project(snapshot: Snapshot, current: readonly ExcalidrawElement[], useCurrentPositions = false) {
  const key = keyFor(snapshot)
  const previous = new Map(current.map(element => [element.id, element]))
  const liveFrames=new Set(current.filter(e=>e.type==='frame'&&!e.isDeleted).map(e=>e.id))
  const frameFor=(shape:ExcalidrawElement|undefined)=>shape?.frameId&&liveFrames.has(shape.frameId)?shape.frameId:null
  const position = (card: Card) => {
    const old = previous.get(rectId(key, card.id))
    return useCurrentPositions && old && !old.isDeleted ? { x: old.x, y: old.y } : { x: card.x, y: card.y }
  }
  const density=snapshot.semanticDensity??3
  const layoutFor=(card:Card)=>snapshot.simpleLinks&&card.kind==='inference'?{...cardLayout(card,density),width:160,height:24,lineY:12}:cardLayout(card,density)
  const layouts=new Map(snapshot.cards.map(card=>[card.id,layoutFor(card)]))
  const positions=new Map(snapshot.cards.filter(c=>c.kind==='claim').map(card=>[card.id,position(card)]))
  const portRoutes=new Map<string,Point[]>()
  const occupied=snapshot.cards.filter(c=>c.kind==='claim').map(c=>({...positions.get(c.id)!,...layouts.get(c.id)!}))
  for(const card of snapshot.cards.filter(c=>c.kind==='inference')){
    const inputs=snapshot.links.filter(link=>link.to===card.id).map(link=>snapshot.cards.find(c=>c.id===link.from)).filter((c):c is Card=>Boolean(c))
    const output=snapshot.cards.find(c=>c.id===snapshot.links.find(link=>link.from===card.id)?.to)
    const count=inputs.length,layout=layoutFor({...card,compact:count===1})
    layouts.set(card.id,layout)
    if(card.manualPosition){positions.set(card.id,position(card));const at=positions.get(card.id)!;occupied.push({...at,y:at.y-26,...layout,height:layout.height+60});continue}
    if(!inputs.length||!output){positions.set(card.id,position(card));continue}
    const inLink=snapshot.links.find(link=>link.to===card.id),outLink=snapshot.links.find(link=>link.from===card.id)
    if(snapshot.simpleLinks&&inputs.length===1&&(inLink?.fromSide||outLink?.toSide)){
      const a={...positions.get(inputs[0].id)!,...layouts.get(inputs[0].id)!},b={...positions.get(output.id)!,...layouts.get(output.id)!}
      const route=splitRoute(routePorts(a,inLink!.fromSide||'right',b,outLink!.toSide||'left'))
      layouts.set(card.id,{...layout,width:24})
      positions.set(card.id,{x:route.mid.x-12,y:route.mid.y-layout.lineY})
      portRoutes.set(inLink!.id,route.first);portRoutes.set(outLink!.id,route.last);continue
    }
    const inputRight=Math.max(...inputs.map(c=>positions.get(c.id)!.x+layouts.get(c.id)!.width)),target=positions.get(output.id)!
    const inputY=inputs.reduce((sum,c)=>sum+positions.get(c.id)!.y+layouts.get(c.id)!.height/2,0)/inputs.length
    const targetY=target.y+layouts.get(output.id)!.height/2
    const x=snapshot.simpleLinks&&target.x<=inputRight+40?inputRight+60:(inputRight+target.x)/2-layout.width/2,baseY=(inputY+targetY)/2-layout.lineY
    let y=baseY
    for(let attempt=0;attempt<18;attempt++){
      y=baseY+(attempt===0?0:Math.ceil(attempt/2)*90*(attempt%2?1:-1))
      if(!occupied.some(box=>x<box.x+box.width+14&&x+layout.width+14>box.x&&y-26<box.y+box.height+18&&y+layout.height+34>box.y))break
    }
    positions.set(card.id,{x,y});occupied.push({x,y:y-26,...layout,height:layout.height+60})
  }
  const skeletons: Parameters<typeof convertToExcalidrawElements>[0] = []
  for (const card of snapshot.cards) {
    const groupIds = [`forkwise:${key}:group:${card.id}`]
    const at=positions.get(card.id)!,layout=layouts.get(card.id)!,shape=previous.get(rectId(key,card.id))
    skeletons.push({
      type: 'rectangle', id: rectId(key, card.id), ...at, width: layout.width, height: layout.height,
      strokeColor:'#d5dde3',backgroundColor:'#ffffff',fillStyle:'solid',strokeWidth:1,roughness:0,
      roundness:{type:3,value:card.kind==='inference'?5:10},...styles(shape),
      // Invisible bounds retain selection, movement and domain identity. Only text and lines are drawn.
      ...(card.kind==='inference'?{strokeColor:'transparent',backgroundColor:'transparent',opacity:0,locked:Boolean(snapshot.simpleLinks)}:{}),
      frameId:frameFor(shape),
      boundElements:[...(shape?.boundElements?.filter(bound=>!bound.id.startsWith(`forkwise:${key}:`))??[]),...snapshot.links.filter(l=>(portRoutes.has(l.id)||l.fromSide||l.toSide)&&(l.from===card.id||l.to===card.id)).map(l=>({id:linkId(key,l.id),type:'arrow' as const}))],
      groupIds,customData:{forkwiseId:card.id,forkwisePart:'card',forkwiseCheckY:layout.checkY,forkwiseCheckHeight:layout.checkHeight,forkwiseFooterY:layout.footerY,forkwiseLineY:layout.lineY},
    })
    const text=(field:string,value:string,x:number,y:number,size:number,color='#24323b')=>skeletons.push({
      type:'text',id:textId(key,card.id,field),x:at.x+x,y:at.y+y,text:value,fontFamily:2,fontSize:size,
      lineHeight:1.5 as ExcalidrawTextElement['lineHeight'],textAlign:'left',strokeColor:color,roughness:0,
      frameId:frameFor(shape),groupIds,customData:{forkwiseId:card.id,forkwisePart:'text',forkwiseField:field},
    })
    if(snapshot.simpleLinks&&card.kind==='inference'){
      // These are labels on the existing inference, never separate domain cards.
      const rows:{field:string;value:string;color:string}[]=[]
      if(density>=1)rows.push({field:'origin',value:[card.origin,cardResearchStatus(card,snapshot.directCanvas)].filter(Boolean).join(' · '),color:relationColor('muted')})
      if(snapshot.selected===card.id&&card.text)rows.push({field:'body',value:wrap(card.text.length>70?card.text.slice(0,70)+'…':card.text,12,240),color:relationColor('reason')})
      if(density>=2){
        rows.push({field:'stance',value:card.stance,color:stanceColors(card.stance).fg})
        rows.push({field:'check',value:`查证：${card.verification}`,color:relationColor('muted')})
      }
      if(density>=3){
        rows.push({field:'summary',value:wrap(card.verificationSummary,12,240),color:relationColor('muted')})
        rows.push({field:'source',value:`来源 ${card.sources.length}`,color:relationColor('muted')})
      }
      let y=-rows.reduce((height,row)=>height+row.value.split('\n').length*18+4,0)-8
      for(const row of rows){text(row.field,row.value,0,y,12,row.color);y+=row.value.split('\n').length*18+4}
      continue
    }
    if(card.noteCard){
      text('origin',card.origin,16,16,11,'#687b8e');text('body',layout.body,16,36,16);
      // Keep a plain-text preview in native canvas exports; the live HTML skin
      // supplies rich image previews and controls without changing the graph.
      const available=Math.max(0,Math.floor((layout.height-layout.dividerY-65)/22));
      if(card.showBody!==false&&card.body)text('notebook-body',layout.summary.split('\n').slice(0,available).join('\n'),16,layout.dividerY,14);
      if(card.showTags!==false&&card.tags?.length)text('tags',card.tags.join(' · '),16,layout.footerY-24,11,'#687b8e');
      text('details','写字板',layout.width-70,layout.footerY,12,'#276e68');continue;
    }
    const originX=card.kind==='inference'?0:20,originY=card.kind==='inference'?0:18
    if(density>=1){
    skeletons.push({type:'rectangle',id:`forkwise:${key}:origin-tag:${card.id}`,x:at.x+originX,y:at.y+originY-3,width:card.origin==='AI'?30:40,height:23,roundness:{type:3},strokeColor:'transparent',backgroundColor:'#eef2f1',fillStyle:'solid',strokeWidth:0,roughness:0,groupIds,frameId:frameFor(shape),customData:{forkwiseId:card.id,forkwisePart:'decoration'}})
    text('origin',card.origin,originX+7,originY,11,'#465b58')
    const researchStatus=cardResearchStatus(card,snapshot.directCanvas)
    if(researchStatus)text('edit-status',researchStatus,originX+54,originY,11,card.editStatus?'#276e68':'#626e79')
    }
    if(density>=2){
    const stance=stanceColors(card.stance),stanceX=card.kind==='inference'?34:84
    skeletons.push({type:'rectangle',id:`forkwise:${key}:stance-tag:${card.id}`,x:at.x+stanceX,y:at.y+layout.stanceY-4,width:card.stance.length*12+16,height:24,roundness:{type:3,value:5},strokeColor:stance.border,backgroundColor:stance.bg,fillStyle:'solid',strokeWidth:1,roughness:0,groupIds,frameId:frameFor(shape),customData:{forkwiseId:card.id,forkwisePart:'decoration',forkwiseField:'stance-tag'}})
    text('stance',card.stance,stanceX+8,layout.stanceY,12,stance.fg)
    }
    if(card.kind==='inference'){
      const count=snapshot.links.filter(link=>link.to===card.id).length
      text('body',layout.body,0,layout.bodyY,14,relationColor('reason'))
      if(count>1)text('combination',`${card.combination||'未说明'} · ${count} 项前提`,0,layout.comboY,12,relationColor('reason'))
      text('stance-label','立场',0,layout.stanceY,12,relationColor('muted'))
      text('source',`来源 ${card.sources.length}`,layout.width-108,layout.footerY,12,relationColor('muted'))
      text('details','操作',layout.width-36,layout.footerY,12,relationColor('muted'))
    }else{
      text('body',layout.body,20,layout.bodyY,20)
      if(density>=2){
      text('stance-label','我的立场',20,layout.stanceY,12,'#626e79')
      text('check',`查证：${card.verification}`,20,layout.checkY,12)
      }
      if(density>=3){
      text('summary',layout.summary,20,layout.checkY+22,13,'#626e79')
      skeletons.push({type:'line',id:`forkwise:${key}:divider:${card.id}`,x:at.x+20,y:at.y+layout.dividerY,points:[[0,0],[layout.width-40,0]],strokeColor:'#e0e5e9',strokeWidth:1,roughness:0,groupIds,frameId:frameFor(shape),customData:{forkwiseId:card.id,forkwisePart:'decoration'}})
      text('source',`来源 ${card.sources.length}`,20,layout.footerY,12)
      text('details','操作',layout.width-44,layout.footerY,12,'#626e79')
      }
    }
  }
  for (const link of snapshot.links) {
    const from = snapshot.cards.find(card => card.id === link.from)
    const to = snapshot.cards.find(card => card.id === link.to)
    if (!from || !to) continue
    const a=positions.get(from.id)!,b=positions.get(to.id)!,aSize=layouts.get(from.id)!,bSize=layouts.get(to.id)!
    const defaultStart={x:from.kind==='inference'?a.x:a.x+aSize.width,y:a.y+(from.kind==='inference'?aSize.lineY:aSize.height/2)}
    const defaultEnd={x:b.x,y:b.y+(to.kind==='inference'?bSize.lineY:bSize.height/2)}
    const hasPorts=Boolean(link.fromSide||link.toSide||portRoutes.has(link.id))
    const start=link.fromSide?portPoint({...a,...aSize},link.fromSide):defaultStart,end=link.toSide?portPoint({...b,...bSize},link.toSide):defaultEnd
    const middle=from.kind==='inference'?end.x-24:(start.x+end.x)/2
    const route=portRoutes.get(link.id)||(hasPorts?routePorts(from.kind==='claim'?{...a,...aSize}:{...defaultStart,width:0,height:0},link.fromSide||'right',to.kind==='claim'?{...b,...bSize}:{...defaultEnd,width:0,height:0},link.toSide||'left'):[start,{x:middle,y:start.y},{x:middle,y:end.y},end])
    const sx=route[0].x,sy=route[0].y
    skeletons.push({
      type: 'arrow', id: linkId(key, link.id), x: sx, y: sy, locked:Boolean(snapshot.simpleLinks),
      points:route.map(p=>[p.x-sx,p.y-sy]),
      ...inferenceDefaultStyle,
      ...styles(previous.get(linkId(key, link.id))),
      endArrowhead:to.kind==='claim'?'arrow':null,
      ...(from.kind==='claim'?(hasPorts?{startBinding:{elementId:rectId(key,from.id),focus:0,gap:0}}:{start:{id:rectId(key,from.id),type:'rectangle' as const}}):{}),
      ...(to.kind==='claim'?(hasPorts?{endBinding:{elementId:rectId(key,to.id),focus:0,gap:0}}:{end:{id:rectId(key,to.id),type:'rectangle' as const}}):{}),
      customData: { forkwiseId: link.relationId, forkwisePart: 'relation', forkwiseSegment: link.id },
    })
  }
  const converted=convertToExcalidrawElements(skeletons,{regenerateIds:false})
  // Links stay behind every card and its native text; exports keep the same hierarchy.
  return [...converted.filter(e=>e.type==='arrow'),...converted.filter(e=>e.type!=='arrow')]
}

function mergeProjection(snapshot: Snapshot, elements: readonly ExcalidrawElement[], useCurrentPositions = false) {
  const projected = project(snapshot, elements, useCurrentPositions)
  const expected = new Map(projected.map(element => [element.id, element]))
  const seen = new Set<string>()
  const merged = elements.flatMap(element => {
    const wanted = expected.get(element.id)
    if (wanted) { seen.add(element.id); return [{ ...wanted, version: element.version + 1, versionNonce: Math.floor(Math.random() * 2147483647) }] }
    // Domain objects removed by a research edit disappear; duplicated identities become annotations.
    if (isDomain(element) && element.id.startsWith(`forkwise:${keyFor(snapshot)}:`)) return []
    return [removeIdentity(element)]
  })
  for (const element of projected) if (!seen.has(element.id)) merged.push(element)
  return merged
}

function protectedChange(snapshot: Snapshot, elements: readonly ExcalidrawElement[], allowMovement = true) {
  const projected = project(snapshot, elements, allowMovement)
  const byId = new Map(elements.map(element => [element.id, element]))
  for (const expected of projected) {
    const actual = byId.get(expected.id)
    if (!actual || actual.isDeleted || actual.type !== expected.type) return true
    if (expected.type === 'text' && actual.type === 'text' && actual.originalText !== expected.originalText) return true
    if (expected.type === 'rectangle' && (Math.abs(actual.width - expected.width) > 0.5 || Math.abs(actual.height - expected.height) > 0.5 || Math.abs(actual.angle) > 0.001)) return true
    if (!allowMovement && expected.type === 'rectangle' && (Math.abs(actual.x - expected.x) > 0.5 || Math.abs(actual.y - expected.y) > 0.5)) return true
  }
  return false
}

export default function ExcalidrawCanvas({ snapshot, onEvent, onReady }: EditorProps) {
  const [api, setApi] = useState<ExcalidrawImperativeAPI | null>(null)
  const [nativeReady, setNativeReady] = useState(false)
  const [dropHint, setDropHint] = useState('')
  const [selectedRelations,setSelectedRelations]=useState<string[]>([])
  const relationSelection=useRef<string[]>([])
  const selectRelations=useCallback((ids:string[])=>{relationSelection.current=ids;setSelectedRelations(ids)},[])
  const latest = useRef(snapshot); latest.current = snapshot
  const emit = useRef(onEvent); emit.current = onEvent
  const ready = useRef(onReady); ready.current = onReady
  const key = useRef(keyFor(snapshot))
  const storedInitial=sceneMemory.get(key.current),sharedInitial=annotationMemory.get(snapshot.projectId)
  const initial = useRef<MemoryScene>({elements:[...(storedInitial?.elements.filter(isDomain)??[]),...(sharedInitial?.elements??storedInitial?.elements.filter(e=>!isDomain(e))??[])],appState:storedInitial?.appState??{},files:sharedInitial?.files??storedInitial?.files??{}})
  const projectionSignature=useRef('')
  const projecting = useRef(false)
  const cacheReady = useRef(false)
  const mounted = useRef(true)
  const fitFrame = useRef<number | null>(null)
  const repairFrame = useRef<number | null>(null)
  const lastNotice = useRef(0)
  const pointer = useRef<{ state: PointerDownState; child: string | null; positions:Record<string,{x:number;y:number}>;context:Snapshot; tool:string; elementIds:Set<string>; before:CanvasPersistence } | null>(null)
  const newClaim = useRef<()=>void>(()=>{})
  const registerClaim = useCallback((open:()=>void)=>{newClaim.current=open},[])
  const promoteText=useRef<()=>void>(()=>{})
  const registerPromote=useCallback((open:()=>void)=>{promoteText.current=open},[])
  const openSearch=useRef<()=>void>(()=>{})
  const registerSearch=useCallback((open:()=>void)=>{openSearch.current=open},[])
  const restoreSource=useRef<(id:string,scroll:number)=>void>(()=>{})
  const registerSource=useCallback((open:(id:string,scroll:number)=>void)=>{restoreSource.current=open},[])
  const focusRange = useRef<(ids:string[])=>void>(()=>{})
  const registerFocusRange = useCallback((focus:(ids:string[])=>void)=>{focusRange.current=focus},[])
  const persistence=useRef<CanvasPersistence>(snapshot.canvasState?cloneCanvasState(snapshot.canvasState):blankCanvasState())
  const pendingBefore=useRef<CanvasPersistence|null>(null)
  const persistenceTimer=useRef<ReturnType<typeof setTimeout>|null>(null)
  const restoreRevision=useRef<number|undefined>(undefined)
  const restoreDone=useRef(false)
  const [draftRevision,setDraftRevision]=useState(0)
  const canceledPointer=useRef(false)
  const syncPersistence=useCallback((commit?:string,elements?:readonly ExcalidrawElement[],app?:AppState,files?:BinaryFiles)=>{
    if(!api||!latest.current.history||!cacheReady.current||projecting.current)return
    const previous=persistence.current
    const captured=captureCanvas(previous,latest.current.mode,elements??api.getSceneElementsIncludingDeleted(),app??api.getAppState(),files??api.getFiles(),relationSelection.current)
    const next={...captured,drafts:captureCanvasDrafts(latest.current.projectId),returnViews:captureReturnViews(latest.current.projectId)}
    const changed=canvasContentSignature(previous)!==canvasContentSignature(next)
    if(changed&&!pendingBefore.current)pendingBefore.current=cloneCanvasState(previous)
    const before=commit?pendingBefore.current:null
    const contentCommit=Boolean(before&&canvasContentSignature(before)!==canvasContentSignature(next))
    if(commit){pendingBefore.current=null;if(persistenceTimer.current){clearTimeout(persistenceTimer.current);persistenceTimer.current=null}}
    // Restoring a projection establishes a baseline. Selection effects and the
    // native idle timer may repeat it without a user edit. A pending gesture's
    // final commit must still flush even when its last continuous state is equal.
    if(!contentCommit&&JSON.stringify(previous)===JSON.stringify(next))return
    persistence.current=next
    // Continuous view, selection, and draft updates are durable but never history entries.
    emit.current({type:'canvas-state',state:cloneCanvasState(next),...(before&&contentCommit?{commit,before}: {})})
  },[api])
  useEffect(()=>{syncPersistence()},[selectedRelations,syncPersistence])
  const schedulePersistenceCommit=useCallback(()=>{
    if(persistenceTimer.current)clearTimeout(persistenceTimer.current)
    persistenceTimer.current=setTimeout(()=>{
      persistenceTimer.current=null
      if(!pointer.current&&!api?.getAppState().editingTextElement)syncPersistence('调整画布批注或样式')
    },320)
  },[api,syncPersistence])

  const notice = useCallback((message: string) => {
    if (Date.now() - lastNotice.current < 1000) return
    lastNotice.current = Date.now()
    emit.current({ type: 'notice', message })
  }, [])

  const putProjection = useCallback((useCurrentPositions = false, elements?: readonly ExcalidrawElement[]) => {
    if (!api) return
    projecting.current = true
    const merged = mergeProjection(latest.current, elements ?? api.getSceneElementsIncludingDeleted(), useCurrentPositions)
    const followed=followAttachments(merged,persistence.current,latest.current.mode)
    persistence.current=followed.state
    const next=followed.elements
    api.updateScene({ elements: next, captureUpdate: CaptureUpdateAction.NEVER })
    projecting.current = false
    return next
  }, [api])

  useEffect(()=>{
    if(!api)return
    let frame:number|null=null
    const ready=()=>{if(api.getAppState().isLoading){frame=requestAnimationFrame(ready);return}setNativeReady(true)}
    ready()
    return()=>{if(frame!==null)cancelAnimationFrame(frame)}
  },[api])

  useEffect(() => {
    if (!api||!nativeReady) return
    const nextKey = keyFor(snapshot)
    let restoredElements:readonly ExcalidrawElement[]|undefined
    const explicitRestore=Boolean(snapshot.history)&&(!restoreDone.current||restoreRevision.current!==snapshot.canvasRestoreRevision)
    const signature=JSON.stringify([snapshot.projectId,snapshot.session,snapshot.mode,snapshot.directCanvas,snapshot.simpleLinks,snapshot.semanticDensity,snapshot.selected,snapshot.cards,snapshot.links])
    if(!explicitRestore&&cacheReady.current&&key.current===nextKey&&projectionSignature.current===signature)return
    projectionSignature.current=signature
    if(explicitRestore){
      persistence.current=snapshot.canvasState?cloneCanvasState(snapshot.canvasState):blankCanvasState()
      restoreCanvasDrafts(snapshot.projectId,snapshot.canvasState);setDraftRevision(value=>value+1)
      pendingBefore.current=null
      if(persistenceTimer.current){clearTimeout(persistenceTimer.current);persistenceTimer.current=null}
      restoreDone.current=true;restoreRevision.current=snapshot.canvasRestoreRevision
    }
    if (!cacheReady.current||key.current !== nextKey||explicitRestore) {
      const stored = sceneMemory.get(nextKey)
      const shared = annotationMemory.get(snapshot.projectId)
      cacheReady.current=false;pointer.current=null;setDropHint('');selectRelations([])
      if(repairFrame.current!==null){cancelAnimationFrame(repairFrame.current);repairFrame.current=null}
      key.current = nextKey
      projecting.current = true
      const persisted=snapshot.history?persistence.current:undefined
      const persistedView=persisted?.scenes[snapshot.mode]?.view
      selectRelations((persistedView?.relationIds??[]).filter(id=>snapshot.cards.some(card=>card.id===id&&card.kind==='inference')))
      restoredElements=persisted?restoreStyles(project(snapshot,[]),persisted,snapshot.mode).concat(persisted.annotations.elements as ExcalidrawElement[]):[...(stored?.elements.filter(isDomain)??[]),...(shared?.elements??stored?.elements.filter(e=>!isDomain(e))??[])]
      api.updateScene({ elements:restoredElements, appState: { ...api.getAppState(), ...stored?.appState, selectedElementIds: {}, selectedGroupIds: {}, ...persistedView, zoom:(persistedView?.zoom??stored?.appState.zoom??api.getAppState().zoom) as AppState['zoom'], editingGroupId: null }, captureUpdate: CaptureUpdateAction.NEVER })
      if(persisted)api.addFiles(Object.values(persisted.annotations.files) as BinaryFiles[string][])
      else if (shared||stored) api.addFiles(Object.values(shared?.files??stored!.files))
      if(persistedView)fittedGraphs.add(nextKey)
      api.history.clear()
      projecting.current = false
    }
    const projected = putProjection(false,restoredElements)
    cacheReady.current=true
    if(snapshot.history&&projected){
      persistence.current={...captureCanvas(persistence.current,snapshot.mode,projected,api.getAppState(),api.getFiles(),relationSelection.current),drafts:captureCanvasDrafts(snapshot.projectId),returnViews:captureReturnViews(snapshot.projectId)}
      if(explicitRestore)pendingBefore.current=null
      if(Object.keys(persistence.current.attachments||{}).length)emit.current({type:'canvas-state',state:cloneCanvasState(persistence.current)})
    }
    if (snapshot.cards.length && projected && !fittedGraphs.has(nextKey)) {
      // The imperative scene can still contain the previous mode in this frame.
      // Fit the exact projection we just submitted instead of an empty native scene.
      fitFrame.current=requestAnimationFrame(() => {fitFrame.current=null;if(mounted.current&&sameContext(snapshot,latest.current)){fittedGraphs.add(nextKey);fitScene(api,projected.filter(element => !element.isDeleted))}})
    }
    return()=>{if(fitFrame.current!==null){cancelAnimationFrame(fitFrame.current);fitFrame.current=null}}
  }, [api,nativeReady,snapshot,putProjection])

  useEffect(() => {
    if (!api) return
    const unDown = api.onPointerDown((tool, state, event) => {
      if(!event.shiftKey)selectRelations([])
      const hit = state.hit.element
      canceledPointer.current=false
      // Excalidraw inserts the initial one-point arrow before firing pointerDown.
      const fresh=tool.type==='arrow'?api.getSceneElements().filter(e=>e.type==='arrow'&&!isDomain(e)&&e.points.length===1&&e.width===0&&e.height===0).at(-1)?.id:undefined
      syncPersistence()
      const before=cloneCanvasState(persistence.current)
      if(fresh)before.annotations.elements=before.annotations.elements.filter(e=>(e as ExcalidrawElement).id!==fresh)
      pointer.current = { tool:tool.type, elementIds:new Set(api.getSceneElements().filter(e=>e.id!==fresh).map(e=>e.id)), before, state, child: hit?.customData?.forkwisePart === 'card' || hit?.customData?.forkwisePart === 'text' ? domainId(hit) : null, positions:Object.fromEntries(api.getSceneElements().filter(e=>e.customData?.forkwisePart==='card').map(e=>[domainId(e)!,{x:e.x,y:e.y}])),context:latest.current }
    })
    const unUp = api.onPointerUp((_tool, state, event) => {
      const start = pointer.current
      pointer.current = null
      setDropHint('')
      if(canceledPointer.current){
        canceledPointer.current=false
        if(start?.tool==='arrow'&&sameContext(start.context,latest.current)){
          requestAnimationFrame(()=>{
            if(!mounted.current||!sameContext(start.context,latest.current))return
            if(persistenceTimer.current){clearTimeout(persistenceTimer.current);persistenceTimer.current=null}
            pendingBefore.current=null;persistence.current=cloneCanvasState(start.before)
            projecting.current=true
            api.updateScene({elements:[...api.getSceneElementsIncludingDeleted().filter(isDomain),...start.before.annotations.elements as ExcalidrawElement[]],appState:{selectedElementIds:{},selectedGroupIds:{}},captureUpdate:CaptureUpdateAction.NEVER})
            projecting.current=false
            emit.current({type:'canvas-state',state:cloneCanvasState(persistence.current)})
          })
        }else putProjection()
        return
      }
      if (!start ||!sameContext(start.context,latest.current)) return
      // Classify only the native arrow created by this gesture, never imports or copies.
      // Native bindings may point at a generated label inside a research card.
      if(start.tool==='arrow'&&latest.current.simpleLinks&&!state.hit.hasBeenDuplicated){
        requestAnimationFrame(()=>{
          if(!mounted.current||!sameContext(start.context,latest.current))return
          const elements=api.getSceneElements(),arrow=elements.find(e=>e.type==='arrow'&&!isDomain(e)&&!start.elementIds.has(e.id))
          if(arrow?.type==='arrow'&&arrow.points.length>1){
            const current=latest.current,key=keyFor(current),byId=new Map(elements.map(e=>[e.id,e]))
            const endpoint=(end:'start'|'end')=>{
              const binding=end==='start'?arrow.startBinding:arrow.endBinding,point=arrow.points[end==='start'?0:arrow.points.length-1]
              const pos={x:arrow.x+point[0],y:arrow.y+point[1]},bound=binding?byId.get(binding.elementId):undefined
              const boundId=domainId(bound),margin=14/api.getAppState().zoom.value
              // An ordinary bound drawing shape remains an ordinary drawing connection.
              if(binding&&!boundId)return null
              const card=current.cards.find(c=>c.kind==='claim'&&(boundId?c.id===boundId:(()=>{const b=byId.get(rectId(key,c.id));return b&&pos.x>=b.x-margin&&pos.x<=b.x+b.width+margin&&pos.y>=b.y-margin&&pos.y<=b.y+b.height+margin})()))
              const shape=card&&byId.get(rectId(key,card.id))
              return card&&shape?{id:card.id,side:nearestSide(shape,pos)}:null
            }
            const from=endpoint('start'),to=endpoint('end')
            if(from&&to){
              const next={...captureCanvas(persistence.current,current.mode,api.getSceneElementsIncludingDeleted(),api.getAppState(),api.getFiles(),relationSelection.current),drafts:captureCanvasDrafts(current.projectId),returnViews:captureReturnViews(current.projectId)}
              persistence.current=next;pendingBefore.current=null
              if(persistenceTimer.current){clearTimeout(persistenceTimer.current);persistenceTimer.current=null}
              emit.current({type:'convert-arrow',ids:[arrow.id],from:from.id,to:to.id,fromSide:from.side,toSide:to.side,nativeDraw:true,canvasState:cloneCanvasState(next),canvasBefore:start.before})
              return
            }
          }
          syncPersistence('绘制自由箭头')
        })
        return
      }
      requestAnimationFrame(()=>{if(sameContext(start.context,latest.current)&&!api.getAppState().editingTextElement)syncPersistence('调整画布批注或样式')})
      if(state.hit.hasBeenDuplicated)return
      if (state.resize.isResizing) { putProjection(); return }
      if (!state.drag.hasOccurred) {
        const selectedId = domainId(state.hit.element)
        if(selectedId){
          emit.current({type:'select',id:selectedId})
        }
        return
      }
      const current = latest.current, currentKey = keyFor(current)
      const scene = new Map(api.getSceneElements().map(element => [element.id, element]))
      const positions = current.cards.flatMap(card => {
        const element = scene.get(rectId(currentKey, card.id))
        const before=start.positions[card.id]
        return element && before && (Math.abs(element.x - before.x) > 0.5 || Math.abs(element.y - before.y) > 0.5) ? [{ id: card.id, x: element.x, y: element.y }] : []
      })
      if (!positions.length) { if (isDomain(state.hit.element)) putProjection(); return }
      const point = viewportCoordsToSceneCoords({ clientX: event.clientX, clientY: event.clientY }, api.getAppState())
      const selectedState=api.getAppState()
      const freeSelected=api.getSceneElements().some(element=>!isDomain(element)&&(selectedState.selectedElementIds[element.id]||element.groupIds.some(group=>selectedState.selectedGroupIds[group])))
      const child = !freeSelected && positions.length === 1 && current.cards.find(card => card.id === start.child && card.kind === 'claim')
      const parent = child && [...current.cards].reverse().find(card => {
        if (card.id === child.id || card.kind !== 'claim') return false
        const element = scene.get(rectId(currentKey, card.id))
        return element && point.x >= element.x && point.x <= element.x + element.width && point.y >= element.y && point.y <= element.y + element.height
      })
      if(current.history&&positions.length&&Object.keys(persistence.current.attachments||{}).length){
        const beforeState=pendingBefore.current||current.canvasState||persistence.current
        const byId=new Map(api.getSceneElementsIncludingDeleted().map(e=>[e.id,e]))
        const attachments={...persistence.current.attachments}
        for(const [id,binding] of Object.entries(attachments)){
          const old=(beforeState.annotations.elements as ExcalidrawElement[]).find(e=>e.id===id),note=byId.get(id),anchor=targetAnchor([...byId.values()],binding.target)
          if(!old||!note||!anchor||binding.mode!==current.mode||!positions.some(p=>p.id===binding.target))continue
          byId.set(id,{...note,x:old.x+anchor.x-binding.x,y:old.y+anchor.y-binding.y});attachments[id]={...binding,...anchor}
        }
        projecting.current=true;api.updateScene({elements:[...byId.values()],captureUpdate:CaptureUpdateAction.NEVER});projecting.current=false
        if(!pendingBefore.current)pendingBefore.current=cloneCanvasState(beforeState)
        persistence.current={...persistence.current,attachments}
      }
      let canvasChange:{}|{canvasState:CanvasPersistence;canvasBefore:CanvasPersistence}={}
      if(current.history&&pendingBefore.current){
        const next={...captureCanvas(persistence.current,current.mode,api.getSceneElementsIncludingDeleted(),api.getAppState(),api.getFiles(),relationSelection.current),drafts:captureCanvasDrafts(current.projectId),returnViews:captureReturnViews(current.projectId)}
        canvasChange={canvasState:cloneCanvasState(next),canvasBefore:cloneCanvasState(pendingBefore.current)}
        persistence.current=next;pendingBefore.current=null
        if(persistenceTimer.current){clearTimeout(persistenceTimer.current);persistenceTimer.current=null}
      }
      if (child && parent) {
        // The authoritative reducer will accept/reject the relation and choose the layout.
        putProjection()
        const sizes=Object.fromEntries(current.cards.map(card=>{const shape=scene.get(rectId(currentKey,card.id));return [card.id,{width:shape?.width??card.width,height:shape?.height??card.height}]}))
        emit.current({ type: 'commit', label:'拖放建立推导', positions: [], sizes, drop: { child: child.id, parent: parent.id },...canvasChange })
      } else {
        emit.current({ type: 'commit', label:positions.length>1?'整体移动所选对象':'移动研究对象', positions,...canvasChange })
      }
    })
    return () => { unDown(); unUp() }
  }, [api, putProjection,syncPersistence])

  useEffect(() => {
    if (!api) return
    ready.current({
      fit: () => fitScene(api,api.getSceneElements()),
      flush: () => syncPersistence('调整画布批注或样式'),
      revealAnnotation:id=>{const element=api.getSceneElements().find(e=>e.id===id&&!isDomain(e));if(element){api.updateScene({appState:{selectedElementIds:{[id]:true},selectedGroupIds:{}},captureUpdate:CaptureUpdateAction.NEVER});api.scrollToContent([element],{animate:false})}},
      reveal: id => {
        if(!latest.current.cards.some(card=>card.id===id)){notice('当前对象暂无法定位。');return}
        if(fitFrame.current!==null){cancelAnimationFrame(fitFrame.current);fitFrame.current=null}
        const targets=api.getSceneElements().filter(element=>domainId(element)===id&&element.customData?.forkwisePart!=='relation')
        if(!targets.length){notice('当前对象暂无法定位。');return}
        const selectedElementIds=Object.fromEntries(targets.map(element=>[element.id,true as const]))
        const selectedGroupIds=Object.fromEntries(targets.flatMap(element=>element.groupIds.map(group=>[group,true])))
        api.updateScene({appState:{selectedElementIds,selectedGroupIds,editingGroupId:null},captureUpdate:CaptureUpdateAction.NEVER})
        const rect=screenRect(api,targets)
        const inside=rect.top>=CHROME_TOP&&rect.bottom<=rect.height-CHROME_BOTTOM&&rect.left>=CHROME_SIDE&&rect.right<=rect.width-CHROME_SIDE
        if(inside){if(!latest.current.backend)emit.current({type:'select',id});return}
        if(rect.zoom>=READABLE_ZOOM){
          // 已在可读尺度时只做最小幅度平移，把对象带进安全区：保持缩放，避免把相邻研究卡
          // 一起推出视口或推到原生工具条下面。
          const dx=rect.left<CHROME_SIDE?CHROME_SIDE-rect.left:Math.min(0,rect.width-CHROME_SIDE-rect.right)
          const dy=rect.top<CHROME_TOP?CHROME_TOP-rect.top:Math.min(0,rect.height-CHROME_BOTTOM-rect.bottom)
          const app=api.getAppState()
          api.updateScene({appState:{scrollX:app.scrollX+dx/rect.zoom,scrollY:app.scrollY+dy/rect.zoom},captureUpdate:CaptureUpdateAction.NEVER})
          if(!latest.current.backend)emit.current({type:'select',id})
          return
        }
        api.scrollToContent(targets,{fitToContent:true,animate:false,maxZoom:1,canvasOffsets:{top:CHROME_TOP,bottom:CHROME_BOTTOM+32,left:CHROME_SIDE,right:CHROME_SIDE}})
        if(!latest.current.backend)emit.current({type:'select',id})
      },
      newClaim: () => newClaim.current(),
      search: () => openSearch.current(),
      restoreSource: (id,scroll) => restoreSource.current(id,scroll),
      focusRange: ids => focusRange.current(ids),
      exportFile: () => saveBlob(new Blob([serializeAsJSON(api.getSceneElements(), api.getAppState(), api.getFiles(), 'local')], { type: 'application/json' }), '见岔-画布.excalidraw'),
      exportSvg: async () => {
        const svg = await exportToSvg({ elements: api.getSceneElements(), appState: api.getAppState(), files: api.getFiles(), exportPadding: 24 })
        saveBlob(new Blob([svg.outerHTML], { type: 'image/svg+xml' }), '见岔-画布.svg')
      },
      exportPng: async () => {
        const blob = await exportToBlob({ elements: api.getSceneElements(), appState: api.getAppState(), files: api.getFiles(), exportPadding: 24, mimeType: 'image/png' })
        if (blob) saveBlob(blob, '见岔-画布.png')
      },
      getScene: () => JSON.parse(serializeAsJSON(api.getSceneElements(), api.getAppState(), api.getFiles(), 'local')),
      loadScene: async input => {
        const context=latest.current
        const blob = input instanceof Blob ? input : new Blob([typeof input === 'string' ? input : JSON.stringify(input)], { type: 'application/json' })
        const restored = await loadFromBlob(blob, null, null)
        if(!mounted.current||!sameContext(context,latest.current))return
        const imported = (restored.elements ?? []).map(element => {
          const clean = removeIdentity(element)
          // Imported graph projections are ordinary graphics, never existing research objects.
          return { ...clean, locked:isDomain(element)?false:clean.locked, id: `import:${crypto.randomUUID()}`, groupIds: clean.groupIds.map(group => `import:${group}`) }
        })
        // Preserve binding and group relationships while assigning fresh imported IDs.
        const ids = new Map((restored.elements ?? []).map((element, index) => [element.id, imported[index].id]))
        const linked = imported.map(element => ({
          ...element,
          frameId: element.frameId ? ids.get(element.frameId) ?? null : null,
          boundElements: element.boundElements?.map(bound => ({ ...bound, id: ids.get(bound.id) ?? bound.id })) ?? null,
          ...(element.type === 'text' ? { containerId: element.containerId ? ids.get(element.containerId) ?? null : null } : {}),
          ...(element.type === 'arrow' ? {
            startBinding: element.startBinding ? { ...element.startBinding, elementId: ids.get(element.startBinding.elementId) ?? element.startBinding.elementId } : null,
            endBinding: element.endBinding ? { ...element.endBinding, elementId: ids.get(element.endBinding.elementId) ?? element.endBinding.elementId } : null,
          } : {}),
        })) as ExcalidrawElement[]
        api.addFiles(Object.values(restored.files ?? {}))
        api.updateScene({ elements: mergeProjection(latest.current, linked), captureUpdate: CaptureUpdateAction.IMMEDIATELY })
        notice('画布文件已作为普通批注导入；研究卡片与论证未被覆盖。')
      },
    })
    return () => ready.current(null)
  }, [api, notice,syncPersistence])

  useEffect(() => () => { if(persistenceTimer.current)clearTimeout(persistenceTimer.current);mounted.current=false;cacheReady.current=false;pointer.current=null;if (repairFrame.current !== null) cancelAnimationFrame(repairFrame.current);if(fitFrame.current!==null)cancelAnimationFrame(fitFrame.current) }, [])

  const changed = useCallback((elements: readonly ExcalidrawElement[], appState: AppState, files: BinaryFiles) => {
    if(!mounted.current||!cacheReady.current||!nativeReady||projecting.current||!api||key.current!==keyFor(latest.current))return
    // Research materials have their own entry; native drawing-library UI is disabled.
    if(appState.openSidebar?.name==='default'&&(!appState.openSidebar.tab||appState.openSidebar.tab==='library')){api.toggleSidebar({name:null,force:false});return}
    if(latest.current.simpleLinks){
      const selected=objectSelection(elements,appState.selectedElementIds,appState.selectedGroupIds)
      const inferred=selected.ids.filter(id=>latest.current.cards.some(c=>c.id===id&&c.kind==='inference'))
      if(inferred.length){
        const ids=[...new Set([...relationSelection.current,...inferred])]
        selectRelations(ids)
        const nativeIds=Object.fromEntries(Object.entries(appState.selectedElementIds).filter(([id])=>!inferred.includes(domainId(elements.find(e=>e.id===id))||'')))
        const inferenceGroups=new Set(elements.filter(e=>inferred.includes(domainId(e)||'')).flatMap(e=>e.groupIds))
        const nativeGroups=Object.fromEntries(Object.entries(appState.selectedGroupIds).filter(([id])=>!inferenceGroups.has(id)))
        // Research inference selection is an entire semantic step, not native segment transforms.
        api.updateScene({appState:{selectedElementIds:nativeIds,selectedGroupIds:nativeGroups,editingGroupId:null},captureUpdate:CaptureUpdateAction.NEVER})
        return
      }
    }
    sceneMemory.set(key.current, { elements, appState: { scrollX: appState.scrollX, scrollY: appState.scrollY, zoom: appState.zoom, viewBackgroundColor: appState.viewBackgroundColor, theme: appState.theme }, files })
    annotationMemory.set(latest.current.projectId,{elements:elements.filter(e=>!isDomain(e)),files})
    syncPersistence(undefined,elements,appState,files)
    if(!pointer.current&&!appState.editingTextElement)schedulePersistenceCommit()
    if (protectedChange(latest.current, elements, Boolean(pointer.current)) && repairFrame.current === null) {
      repairFrame.current = requestAnimationFrame(() => {
        repairFrame.current = null
        const current = api.getSceneElementsIncludingDeleted()
        if (!protectedChange(latest.current, current, Boolean(pointer.current))) return
        const contentChanged = protectedChange(latest.current, current)
        putProjection(Boolean(pointer.current))
        if (contentChanged) notice(latest.current.directCanvas?'双击研究对象可改写文字；选中后可删除或查看推导。自由批注仍可直接编辑。':'双击个人卡片可改写文字；选中后可删除或查看推导。自由批注仍可直接编辑。')
      })
    }
  }, [api,nativeReady,notice,putProjection,syncPersistence,schedulePersistenceCommit])

  const duplicate = useCallback((next: readonly ExcalidrawElement[], previous: readonly ExcalidrawElement[]) => {
    const old = new Set(previous.map(element => element.id))
    return next.map(element => old.has(element.id) ? element : removeIdentity(element))
  }, [])

  const pointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const active = pointer.current
    if (!active?.child || active.tool==='arrow' || !api || !event.buttons||!sameContext(active.context,latest.current)) return
    const current = latest.current
    const child = current.cards.find(card => card.id === active.child && card.kind === 'claim')
    if (!child) return
    const moved=api.getSceneElements().filter(e=>e.customData?.forkwisePart==='card'&&active.positions[domainId(e)!]&&(Math.abs(e.x-active.positions[domainId(e)!].x)>.5||Math.abs(e.y-active.positions[domainId(e)!].y)>.5))
    if(moved.length>1){setDropHint(`正在移动 ${moved.length} 个研究对象 · Esc 取消`);return}
    const point = viewportCoordsToSceneCoords({ clientX: event.clientX, clientY: event.clientY }, api.getAppState())
    const scene = new Map(api.getSceneElements().map(element => [element.id, element]))
    const parent = [...current.cards].reverse().find(card => {
      if (card.id === child.id || card.kind !== 'claim') return false
      const element = scene.get(rectId(keyFor(current), card.id))
      return element && point.x >= element.x && point.x <= element.x + element.width && point.y >= element.y && point.y <= element.y + element.height
    })
    setDropHint(parent ? !current.directCanvas&&current.mode !== 'mine' ? '先收录当前候选链，再在个人论证中拖放建立推导。' : `松手建立父卡「${parent.text.slice(0, 22)}」→ 子卡「${child.text.slice(0, 22)}」，保留原连接` : '把子卡拖到父卡上建立推导 · 空白处只移动 · Esc 取消')
  }

  useEffect(()=>{
    if(!api)return
    const runHistory=(direction:'undo'|'redo')=>{syncPersistence('调整画布批注或样式');api.updateScene({appState:{openDialog:null},captureUpdate:CaptureUpdateAction.NEVER});emit.current({type:'history',direction})}
    const nativeHistoryDirection=(element:Element|null)=>{
      const command=element?.closest('.command-item'),name=command?.querySelector('.name')?.textContent?.trim()
      const testId=element?.closest('[data-testid]')?.getAttribute('data-testid')
      if(name==='撤销'||name==='Undo'||testId==='undo'||testId==='button-undo')return 'undo' as const
      if(name==='重做'||name==='Redo'||testId==='redo'||testId==='button-redo')return 'redo' as const
      return null
    }
    const click=(event:MouseEvent)=>{if(!latest.current.history)return;const direction=nativeHistoryDirection(event.target as Element);if(direction){event.preventDefault();event.stopImmediatePropagation();runHistory(direction)}}
    const keydown=(event:KeyboardEvent)=>{
      const target=event.target as HTMLElement
      if(latest.current.history&&event.key==='Enter'&&api.getAppState().openDialog?.name==='commandPalette'){const direction=nativeHistoryDirection(document.querySelector('.command-item.item-selected'));if(direction){event.preventDefault();event.stopImmediatePropagation();runHistory(direction);return}}
      const editing=Boolean(target.closest('input,textarea,[contenteditable="true"]')||api.getAppState().editingTextElement)
      const libraryEditing=Boolean(target.closest('textarea,select,[contenteditable="true"],input:not([type=radio]):not([type=checkbox]):not([type=button])')||api.getAppState().editingTextElement)
      if(event.key==='0'&&!event.metaKey&&!event.ctrlKey&&!event.altKey&&!libraryEditing){event.preventDefault();event.stopImmediatePropagation();return}
      if(latest.current.history&&(event.metaKey||event.ctrlKey)&&(event.key.toLowerCase()==='z'||event.ctrlKey&&event.key.toLowerCase()==='y')&&!editing){
        event.preventDefault();event.stopImmediatePropagation();runHistory(event.shiftKey||event.key.toLowerCase()==='y'?'redo':'undo');return
      }
      if((event.key==='Delete'||event.key==='Backspace')&&!event.metaKey&&!event.ctrlKey&&!event.altKey){
        // A focused form/menu owns its keys; canvas selection does not override it.
        if(libraryEditing)return
        if(target.closest('button:not([data-details-card]),a,[role="menu"],[role="dialog"]')||api.getAppState().openDialog||api.getAppState().openMenu||document.querySelector('.research-popover,.object-more,.connection-pick,.connection-status,.annotation-prompt,.canvas-search')){event.preventDefault();event.stopImmediatePropagation();return}
        if(pointer.current||event.repeat){event.preventDefault();event.stopImmediatePropagation();return}
        const current=latest.current,app=api.getAppState(),elements=api.getSceneElementsIncludingDeleted()
        const selection=objectSelection(elements,app.selectedElementIds,app.selectedGroupIds,relationSelection.current)
        const ids=selection.ids.filter(id=>current.cards.some(card=>card.id===id))
        if(!ids.length)return // Free drawing deletion continues through Excalidraw.
        event.preventDefault();event.stopImmediatePropagation()
        if(!current.directCanvas&&current.mode!=='mine'){notice('作者整理原版保留，请回到研究画布删除。');return}
        syncPersistence('调整画布批注或样式')
        const before=cloneCanvasState(persistence.current),removed=new Set(ids)
        for(const link of current.links)if(removed.has(link.from)||removed.has(link.to))removed.add(link.relationId)
        const freeIds=new Set(selection.free.map(element=>element.id))
        // Bound text follows its deleted container; frames only lose memberships.
        for(const element of elements)if(element.type==='text'&&element.containerId&&freeIds.has(element.containerId))freeIds.add(element.id)
        const deleted=new Set(elements.filter(element=>freeIds.has(element.id)||removed.has(domainId(element)||'')).map(element=>element.id))
        const nextElements=elements.map(element=>({...element,
          ...(deleted.has(element.id)?{isDeleted:true}:{}),
          ...(element.frameId&&deleted.has(element.frameId)?{frameId:null}:{}),
          ...('boundElements' in element&&element.boundElements?{boundElements:element.boundElements.filter(bound=>!deleted.has(bound.id))}:{}),
          ...(element.type==='arrow'?{startBinding:element.startBinding&&deleted.has(element.startBinding.elementId)?null:element.startBinding,endBinding:element.endBinding&&deleted.has(element.endBinding.elementId)?null:element.endBinding}:{}),
        })) as ExcalidrawElement[]
        const next=captureCanvas(before,current.mode,nextElements,{...app,selectedElementIds:{},selectedGroupIds:{}} as AppState,api.getFiles(),[])
        if(next.attachments)next.attachments=Object.fromEntries(Object.entries(next.attachments).filter(([id,binding])=>!freeIds.has(id)&&!(binding.mode===current.mode&&removed.has(binding.target))))
        emit.current({type:'delete',id:ids[0],ids,canvasState:next,canvasBefore:before})
        return
      }
      if(event.key==='Escape'&&!pointer.current&&!editing&&!latest.current.linkFrom&&!api.getAppState().openDialog&&!api.getAppState().openMenu&&!document.querySelector('.research-popover,.object-more,.connection-pick,.connection-status,.annotation-prompt,.canvas-search')){
        const app=api.getAppState()
        if(objectSelection(api.getSceneElements(),app.selectedElementIds,app.selectedGroupIds,relationSelection.current).ids.length){
          event.preventDefault();event.stopImmediatePropagation();selectRelations([])
          api.updateScene({appState:{selectedElementIds:{},selectedGroupIds:{},editingGroupId:null},captureUpdate:CaptureUpdateAction.NEVER});return
        }
      }
      if(event.key==='Escape'&&pointer.current?.tool==='arrow'&&!editing){canceledPointer.current=true;return}
      if(event.key==='Escape'&&pointer.current?.tool!=='arrow'&&pointer.current?.state.drag.hasOccurred){
        event.preventDefault();canceledPointer.current=true;pointer.current=null;setDropHint('');putProjection();notice('已取消拖动，回到原来的位置。');return
      }
      if(event.key==='Escape'&&!event.defaultPrevented&&latest.current.linkFrom&&!editing&&!api.getAppState().openDialog&&!api.getAppState().openMenu&&!document.querySelector('.research-popover,.object-more')){
        event.preventDefault();event.stopImmediatePropagation();emit.current({type:'cancel-link'});notice('已取消建立推导。')
      }
    }
    const pagehide=()=>syncPersistence('调整画布批注或样式')
    window.addEventListener('keydown',keydown,true);window.addEventListener('click',click,true);window.addEventListener('pagehide',pagehide)
    return()=>{window.removeEventListener('keydown',keydown,true);window.removeEventListener('click',click,true);window.removeEventListener('pagehide',pagehide)}
  },[api,notice,putProjection,syncPersistence])

  const commitCanvas=(state:CanvasPersistence,label:string)=>{
    const before=cloneCanvasState(persistence.current)
    if(persistenceTimer.current){clearTimeout(persistenceTimer.current);persistenceTimer.current=null}
    pendingBefore.current=null;persistence.current=cloneCanvasState(state)
    projecting.current=true
    api?.updateScene({elements:[...(api.getSceneElementsIncludingDeleted().filter(isDomain)??[]),...state.annotations.elements as ExcalidrawElement[]],captureUpdate:CaptureUpdateAction.NEVER})
    projecting.current=false
    emit.current({type:'canvas-state',state:cloneCanvasState(state),commit:label,before})
  }
  return <div className={snapshot.history?'unified-canvas-history':undefined} style={{ width: '100%', height: '100%', position: 'relative' }} onPointerMoveCapture={pointerMove} onPointerDownCapture={() => {
    // In an iframe, browser focus may arrive after the native pointerdown handler.
    // Excalidraw cleans hanging interactions on window focus, which would then
    // cancel this new drag. Transfer focus before it creates the pointer state.
    window.focus()
  }}>
    <Excalidraw
      excalidrawAPI={setApi}
      initialData={{ elements: initial.current?.elements ?? [], appState: { ...initial.current?.appState, currentItemFontFamily: 2,frameRendering:{enabled:true,name:true,outline:true,clip:false} }, files: initial.current?.files ?? {} }}
      onChange={changed}
      onDuplicate={duplicate}
      langCode="zh-CN"
      autoFocus
      showDeprecatedFonts
      name="见岔-研究画布"
    />
    {api&&<ResearchOverlay key={`${keyFor(snapshot)}:${draftRevision}`} api={api} snapshot={snapshot} selectedRelations={selectedRelations} selectRelations={selectRelations} onEvent={onEvent} register={registerClaim} registerPromote={registerPromote} registerFocusRange={registerFocusRange} registerSource={registerSource} onDraftChange={()=>syncPersistence()} measureCard={card=>cardLayout({...card,compact:snapshot.links.filter(link=>link.to===card.id).length===1},snapshot.semanticDensity??3)}/>}
    {api&&snapshot.simpleLinks&&<ConnectionControls api={api} snapshot={snapshot} selectedRelations={selectedRelations} onEvent={event=>{if(event.type==='connect'||event.type==='reconnect')emit.current(event);else onEvent(event)}} flush={()=>syncPersistence('调整画布批注或样式')}/>}
    {api&&<CanvasSearch key={keyFor(snapshot)} api={api} snapshot={snapshot} selectedRelations={selectedRelations} selectRelations={selectRelations} register={registerSearch} onEvent={onEvent}/>}
    {api&&snapshot.simpleLinks&&<AnnotationControls api={api} snapshot={snapshot} selectedRelations={selectedRelations} flush={()=>syncPersistence('调整画布批注或样式')} getState={()=>cloneCanvasState(persistence.current)} commit={commitCanvas} convert={(ids,from,to)=>emit.current({type:'convert-arrow',ids,from,to})} onEvent={onEvent} promoteText={()=>promoteText.current()}/>}
    {dropHint && <div role="status"  style={{ position: 'absolute', bottom: 72, left: '50%', transform: 'translateX(-50%)', maxWidth: '90%', padding: '10px 14px', borderRadius: 8, background: '#e7f6ef', color: '#214c3c', border: '1px solid #5f9b81', pointerEvents: 'none', zIndex: 3, fontSize: 13 }}>{dropHint}</div>}
  </div>
}
