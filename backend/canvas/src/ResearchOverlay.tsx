import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { CaptureUpdateAction, newElementWith } from '@excalidraw/excalidraw'
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types'
import type { CanvasDraft, CanvasEvent, Card, ObjectTask, Snapshot } from './types'
import { cardResearchStatus } from './types'
import { inferenceDefaultStyle, focusNeighborhood, isStyleTarget, objectSelection, objectStyle } from './objectTools'
import type { ObjectStyle } from './objectTools'
import { getCanvasDraft, putCanvasDraft, getReturnView, putReturnView } from './canvasPersistence'
import { layoutSelection } from './selectionLayout'
import type { SelectionLayoutOperation } from './selectionLayout'
import NotebookCard from './NotebookCard'

type Draft = CanvasDraft
type Props = { selectedRelations:string[]; selectRelations:(ids:string[])=>void; api:ExcalidrawImperativeAPI; snapshot:Snapshot; onEvent:(event:CanvasEvent)=>void; register:(open:()=>void)=>void; registerPromote:(open:()=>void)=>void; registerFocusRange:(focus:(ids:string[])=>void)=>void; registerSource:(open:(id:string,scroll:number)=>void)=>void; measureCard:(card:Card)=>{width:number;height:number}; onDraftChange:()=>void }
type SavedView = { relationIds?:string[]; projectId:string; session:number; mode:string; scrollX:number; scrollY:number; zoom:ReturnType<ExcalidrawImperativeAPI['getAppState']>['zoom']; count:number; selectedElementIds:Record<string,true>; selectedGroupIds:Record<string,boolean> }
const draftKey=(snapshot:Snapshot)=>`${snapshot.projectId}:${snapshot.mode}`
function restoredDraft(snapshot:Snapshot){
  const cached=getCanvasDraft(snapshot.projectId,snapshot.mode)
  if(cached?.id&&(!snapshot.directCanvas&&snapshot.mode!=='mine'||!snapshot.cards.some(c=>c.id===cached.id))){putCanvasDraft(snapshot.projectId,snapshot.mode,null);return null}
  return cached?{...cached}:null
}
function safeOriginalUrl(value?:string){
  if(typeof value!=='string'||!value.trim())return null
  try{
    const url=new URL(value.trim())
    return ['http:','https:'].includes(url.protocol)&&!url.username&&!url.password?url.href:null
  }catch{return null}
}
const colors=['#d5dde3','#276e68','#8297a8','#8a5a00','#8a3f48','#654a86','#ffffff','#f1f6f3']
const colorValue=(value:string|undefined,fallback:string)=>/^#[0-9a-f]{6}$/i.test(value||'')?value!:fallback

export default function ResearchOverlay({api,snapshot,selectedRelations,selectRelations,onEvent,register,registerPromote,registerFocusRange,registerSource,measureCard,onDraftChange}:Props){
  const editable=Boolean(snapshot.directCanvas||snapshot.mode==='mine')
  const [,refresh]=useState(0)
  const [sourceId,setSourceId]=useState<string|null>(null)
  const [draft,setDraftState]=useState<Draft|null>(()=>restoredDraft(snapshot))
  const [more,setMore]=useState(false)
  const [pendingCreate,setPendingCreate]=useState<string|null>(null)
  const [submitError,setSubmitError]=useState('')
  const [arrange,setArrange]=useState(false)
  const [styleIds,setStyleIds]=useState<string[]|null>(null)
  const [styleTouched,setStyleTouched]=useState(false)
  const styleBefore=useRef(new Map<string,ObjectStyle>())
  const [savedView,setSavedViewState]=useState<SavedView|null>(()=>{const view=getReturnView(snapshot.projectId,snapshot.mode);return view?{...view,zoom:view.zoom as SavedView['zoom'],projectId:snapshot.projectId,session:snapshot.session,mode:snapshot.mode}:null})
  const setSavedView=(view:SavedView|null)=>{setSavedViewState(view);putReturnView(snapshot.projectId,snapshot.mode,view);onDraftChange()}
  const previous=useRef(draftKey(snapshot))
  const focus=useRef<HTMLTextAreaElement>(null)
  const overlayRef=useRef<HTMLDivElement>(null)
  const toolbarRef=useRef<HTMLDivElement>(null)
  const [toolbarHeight,setToolbarHeight]=useState(80)
  const [dockTop,setDockTop]=useState<number|null>(null)
  const setDraft=(next:Draft|null)=>{
    putCanvasDraft(snapshot.projectId,snapshot.mode,next)
    setDraftState(next);onDraftChange()
  }
  const state=api.getAppState(),zoom=state.zoom.value,elements=api.getSceneElements()
  const selection=objectSelection(elements,state.selectedElementIds,state.selectedGroupIds,selectedRelations)
  const selectedCards=snapshot.cards.filter(c=>selection.ids.includes(c.id))
  const selectedIds=selectedCards.map(c=>c.id),selectionKey=selectedIds.slice().sort().join('|')
  const neighborhoodIds=snapshot.directCanvas?focusNeighborhood(snapshot,selectedIds):new Set(selectedIds)
  const single=selectedCards.length===1&&!selection.free.length?selectedCards[0]:null
  const cardShape=(id:string)=>elements.find(e=>e.customData?.forkwisePart==='card'&&e.customData.forkwiseId===id)
  const bounds=(card:Card)=>{
    const shape=cardShape(card.id),x=shape?.x??card.x,y=shape?.y??card.y,w=shape?.width??card.width,h=shape?.height??card.height
    return {left:(x+state.scrollX)*zoom,top:(y+state.scrollY)*zoom,width:w*zoom,height:h*zoom}
  }
  const viewport={width:state.width,height:state.height}
  useLayoutEffect(()=>{
    const overlay=overlayRef.current,shell=overlay?.closest('.canvas-shell'),dock=shell?.querySelector('.canvas-extras')
    if(!overlay||!dock||!shell)return
    const controls=shell.querySelector('.connection-controls')
    const obstacles=()=>[dock,...shell.querySelectorAll('.connection-actions,.connection-pick,.connection-status')]
    const measure=()=>{
      const rectangles=obstacles().map(node=>node.getBoundingClientRect()).filter(rect=>rect.width>0&&rect.height>0)
      const top=Math.min(...rectangles.map(rect=>rect.top))-overlay.getBoundingClientRect().top
      setDockTop(previous=>previous!==null&&Math.abs(previous-top)<.5?previous:top)
    }
    measure();const observer=new ResizeObserver(measure);obstacles().forEach(node=>observer.observe(node));observer.observe(overlay)
    const mutations=new MutationObserver(measure)
    if(controls)mutations.observe(controls,{childList:true,subtree:true,attributes:true,attributeFilter:['class','style']})
    return()=>{observer.disconnect();mutations.disconnect()}
  },[viewport.width,viewport.height,snapshot.projectId,selectionKey,state.activeTool.type])
  const anchor=(id?:string)=>{
    const card=snapshot.cards.find(c=>c.id===id),b=card?bounds(card):{left:viewport.width/2-160,top:viewport.height/2-130,width:300,height:150}
    const top=Math.max(84,Math.min(Math.max(84,viewport.height-380),b.top))
    return {left:Math.max(8,Math.min(viewport.width-Math.min(350,viewport.width-16)-8,b.left+b.width+12)),top,maxHeight:Math.max(120,viewport.height-top-8)}
  }
  const center=()=>({x:viewport.width/(2*zoom)-state.scrollX-140,y:viewport.height/(2*zoom)-state.scrollY-100})
  const closeLocal=()=>{setSourceId(null);setDraft(null);setStyleIds(null);setMore(false);setArrange(false);onEvent({type:'overlay',open:false})}
  const announceLocal=()=>{setMore(false);onEvent({type:'overlay',open:true})}
  const canCreate=()=>{
    if(!snapshot.directCanvas&&snapshot.mode==='author'&&snapshot.cards.length){onEvent({type:'notice',message:'先收录候选链，再添加自己的主张；自由文字和绘图随时可用。'});return false}
    return true
  }
  const newClaim=()=>{if(canCreate()){announceLocal();setSourceId(null);setStyleIds(null);setDraft({text:'',reason:'',...center()})}}
  useEffect(()=>api.onChange(()=>refresh(n=>n+1)),[api])
  useEffect(()=>{register(newClaim)},[api,snapshot,zoom])
  useEffect(()=>{if(draft)focus.current?.focus()},[draft?.id,Boolean(draft)])
  // Restored drafts also occupy a local window. Notify before the first paint;
  // normal open actions notify synchronously, never through a delayed effect.
  useLayoutEffect(()=>{
    if(draft)onEvent({type:'overlay',open:true})
    return()=>onEvent({type:'overlay',open:false})
  },[])
  useEffect(()=>{
    setMore(false);setStyleIds(null)
  },[snapshot.projectId,snapshot.mode,snapshot.session])
  useEffect(()=>{
    setMore(false);setArrange(false)
    if(styleIds&&styleIds.slice().sort().join('|')!==selectionKey){setStyleIds(null);onEvent({type:'overlay',open:false})}
  },[selectionKey])
  useEffect(()=>{
    const next=draftKey(snapshot)
    if(next!==previous.current){setSourceId(null);setDraftState(restoredDraft(snapshot));previous.current=next;return}
    if(sourceId&&!snapshot.cards.some(c=>c.id===sourceId)){setSourceId(null);onEvent({type:'overlay',open:false})}
    if(draft?.id&&(!editable||!snapshot.cards.some(c=>c.id===draft.id))){setDraft(null);onEvent({type:'overlay',open:false})}
  },[snapshot])
  const edit=(card:Card)=>{
    if(card.noteCard){closeLocal();onEvent({type:'task',id:card.id,task:'notebook'});return}
    if(snapshot.backend){onEvent({type:'details',id:card.id,view:'edit'});return}
    if(!editable){onEvent({type:'notice',message:'先收录为个人论证，再改写卡片；作者原版保留。'});return}
    announceLocal();setSourceId(null);setStyleIds(null);setDraft({id:card.id,text:card.text,reason:'',x:card.x,y:card.y})
  }
  useEffect(()=>{
    const host=document.querySelector('.excalidraw') as HTMLElement|null
    if(!host)return
    const doubleClick=(event:MouseEvent)=>{
      if((event.target as HTMLElement).closest('.research-ui,input,textarea'))return
      const s=api.getAppState(),x=(event.clientX-s.offsetLeft)/s.zoom.value-s.scrollX,y=(event.clientY-s.offsetTop)/s.zoom.value-s.scrollY
      const shape=[...api.getSceneElements()].reverse().find(e=>e.customData?.forkwisePart==='card'&&x>=e.x&&x<=e.x+e.width&&y>=e.y&&y<=e.y+e.height)
      const card=shape&&snapshot.cards.find(c=>c.id===shape.customData?.forkwiseId)
      if(card){event.preventDefault();event.stopPropagation();edit(card)}
    }
    host.addEventListener('dblclick',doubleClick,true)
    return()=>host.removeEventListener('dblclick',doubleClick,true)
  },[api,snapshot])
  const selectCard=(card:Card,additive=false)=>{
    closeLocal()
    const nextIds=additive?selectedIds.includes(card.id)?selectedIds.filter(id=>id!==card.id):[...selectedIds,card.id]:[card.id]
    const inferIds=nextIds.filter(id=>snapshot.simpleLinks&&snapshot.cards.some(c=>c.id===id&&c.kind==='inference'))
    selectRelations(inferIds)
    const selectedElementIds=Object.fromEntries([...(additive?selection.free:[]),...elements.filter(e=>nextIds.includes(e.customData?.forkwiseId)&&!inferIds.includes(e.customData?.forkwiseId)&&e.customData?.forkwisePart!=='relation')].map(e=>[e.id,true as const]))
    const selectedGroupIds=Object.fromEntries(elements.filter(e=>selectedElementIds[e.id]).flatMap(e=>e.groupIds.map(id=>[id,true])))
    api.updateScene({appState:{selectedElementIds,selectedGroupIds},captureUpdate:CaptureUpdateAction.NEVER})
    if(nextIds.length)onEvent({type:'select',id:additive?nextIds[0]:card.id})
  }
  const openSource=(card:Card)=>{if(!selectedIds.includes(card.id))selectCard(card);announceLocal();setDraft(null);setStyleIds(null);setSourceId(card.id)}
  useEffect(()=>{registerSource((id,scroll)=>{
    const card=snapshot.cards.find(c=>c.id===id);if(!card)return;
    announceLocal();setDraft(null);setStyleIds(null);setSourceId(id);
    requestAnimationFrame(()=>requestAnimationFrame(()=>{const panel=document.querySelector('.source-popover');if(panel)panel.scrollTop=scroll;}));
  })},[snapshot,api])
  const task=(kind:ObjectTask,card=single)=>{
    const multiple=kind==='ai'||kind==='adopt'
    const ids=multiple?selectedIds:card?[card.id]:[]
    if(!ids.length)return
    if(kind!=='ai'&&card&&!selectedIds.includes(card.id))selectCard(card)
    closeLocal();onEvent({type:'task',id:ids[0],...(multiple?{ids}:{}),task:kind})
  }
  const selected=elements.filter(e=>state.selectedElementIds[e.id])
  const texts=elements.filter(e=>e.type==='text'&&!e.customData?.forkwisePart&&(state.selectedElementIds[e.id]||(e.containerId&&state.selectedElementIds[e.containerId])))
  const promote=()=>{
    if(!canCreate()||!texts.length)return
    if(!snapshot.simpleLinks){
      const free=selection.free,text=texts.map(e=>e.type==='text'?e.originalText:'').join('\n').trim()
      announceLocal();setDraft({text,reason:'',x:Math.max(...free.map(e=>e.x+e.width))+40,y:Math.min(...free.map(e=>e.y))});return
    }
    const containers=elements.filter(e=>e.type==='rectangle'&&!e.customData?.forkwisePart&&texts.some(t=>t.type==='text'&&t.containerId===e.id))
    if(texts.some(t=>t.type==='text'&&t.containerId&&!containers.some(e=>e.id===t.containerId))){onEvent({type:'notice',message:'先选择自由文字或带文字的矩形；其他形状保留为绘图。'});return}
    const originals=[...containers,...texts],text=texts.map(e=>e.type==='text'?e.originalText:'').join('\n').trim()
    const signature=JSON.stringify(originals.map(e=>[e.id,e.x,e.y,e.width,e.height,e.angle,e.frameId,e.type==='text'?e.originalText:null]))
    const shape=containers[0],style=shape?Object.fromEntries(['strokeColor','backgroundColor','fillStyle','strokeWidth','strokeStyle','roughness','opacity'].map(field=>[field,(shape as unknown as Record<string,unknown>)[field]])):undefined
    announceLocal();setDraft({text,reason:'',x:Math.min(...originals.map(e=>e.x)),y:Math.min(...originals.map(e=>e.y)),conversion:{ids:originals.map(e=>e.id),signature,style,frameId:originals.every(e=>e.frameId===originals[0].frameId)?originals[0].frameId:null}});setSourceId(null);setStyleIds(null)
  }
  useEffect(()=>{registerPromote(promote)},[api,snapshot,state.selectedElementIds,state.selectedGroupIds])
  const sourceCard=snapshot.cards.find(c=>c.id===sourceId),draftCard=snapshot.cards.find(c=>c.id===draft?.id)
  const draftRelations=draftCard?.kind==='claim'?[...new Set(snapshot.links.filter(link=>link.from===draftCard.id).map(link=>link.relationId))].flatMap(id=>{
    const relation=snapshot.cards.find(card=>card.id===id&&card.kind==='inference');return relation?[relation]:[]
  }):[]
  const needsScope=Boolean(snapshot.directCanvas&&draftCard&&draft&&draft.text.trim()!==draftCard.text.trim()&&draftRelations.length>1)
  const validScope=Boolean(draft?.scope==='all'||draftRelations.some(relation=>relation.id===draft?.scope))
  const stop=(event:React.PointerEvent)=>event.stopPropagation()
  useEffect(()=>{
    const completed=(event:MessageEvent)=>{
      if(event.source!==window.parent||event.origin!==location.origin||event.data?.channel!=='forkwise-study'||event.data?.type!=='commit-result'||event.data.requestId!==pendingCreate)return
      setPendingCreate(null)
      if(event.data.ok)closeLocal();else setSubmitError(String(event.data.message||'保存失败，草稿保留'))
    }
    window.addEventListener('message',completed);return()=>window.removeEventListener('message',completed)
  },[pendingCreate,snapshot.projectId])
  const submit=()=>{
    if(pendingCreate)return
    if(snapshot.backend&&draft&&!draft.id){
      const requestId=crypto.randomUUID();setPendingCreate(requestId);setSubmitError('')
      onEvent({type:'create',requestId,text:draft.text,x:draft.x,y:draft.y,conversion:draft.conversion});return
    }
    if(!draft||!draft.text.trim()&&draftCard?.kind!=='inference')return
    if(draft.id){
      const card=draftCard
      if(!editable||!card){closeLocal();return}
      if(draft.text.trim()===card.text.trim())return
      if(needsScope&&!validScope)return
      const sizes=Object.fromEntries(snapshot.cards.map(c=>{const shape=cardShape(c.id);return [c.id,{width:shape?.width??c.width,height:shape?.height??c.height}]}))
      const previousHeight=sizes[card.id].height
      sizes[card.id]=measureCard({...card,text:draft.text.trim(),verificationSummary:'内容或前提已修改，需要针对当前版本重新查证。'})
      onEvent({type:'edit',id:draft.id,text:draft.text,reason:draft.reason,...(needsScope?{scope:draft.scope}:{}),sizes,previousHeight})
      onEvent({type:'notice',message:'已更新画布。修改记录可从工具条“更多”查看。'})
    }else{
      if(draft.conversion){
        const originals=draft.conversion.ids.map(id=>elements.find(e=>e.id===id&&!e.isDeleted))
        const signature=JSON.stringify(originals.map(e=>e?[e.id,e.x,e.y,e.width,e.height,e.angle,e.frameId,e.type==='text'?e.originalText:null]:null))
        if(signature!==draft.conversion.signature){onEvent({type:'notice',message:'原文字或位置已改变。请取消本次转换，重新选择；原内容保留。'});return}
      }
      // Clear and flush the local draft before the host's atomic scene replacement.
      // A later draft-only update from this old projection would restore the originals.
      closeLocal();onEvent({type:'create',text:draft.text,x:draft.x,y:draft.y,conversion:draft.conversion});return
    }
    closeLocal()
  }
  const openStyles=()=>{
    if(!selectedIds.length)return
    styleBefore.current=new Map(elements.filter(e=>isStyleTarget(e,snapshot.cards,selectedIds)).map(e=>[e.id,objectStyle(e)]))
    setStyleTouched(false);announceLocal();setSourceId(null);setDraft(null);setStyleIds([...selectedIds])
  }
  const applyStyle=(patch:Partial<ObjectStyle>)=>{
    if(!styleIds)return
    api.updateScene({elements:api.getSceneElementsIncludingDeleted().map(e=>isStyleTarget(e,snapshot.cards,styleIds)?newElementWith(e,patch):e),captureUpdate:CaptureUpdateAction.IMMEDIATELY})
    setStyleTouched(true)
  }
  const resetStyle=()=>{
    if(!styleIds)return
    api.updateScene({elements:api.getSceneElementsIncludingDeleted().map(e=>{
      if(!isStyleTarget(e,snapshot.cards,styleIds))return e
      const claim=e.customData?.forkwisePart==='card'
      return newElementWith(e,claim?{strokeColor:'#d5dde3',backgroundColor:'#ffffff',strokeWidth:1,strokeStyle:'solid',fillStyle:'solid',roughness:0}:inferenceDefaultStyle)
    }),captureUpdate:CaptureUpdateAction.IMMEDIATELY});setStyleTouched(true)
  }
  const undoStyle=()=>{
    api.updateScene({elements:api.getSceneElementsIncludingDeleted().map(e=>styleBefore.current.has(e.id)?newElementWith(e,styleBefore.current.get(e.id)!):e),captureUpdate:CaptureUpdateAction.IMMEDIATELY})
    setStyleTouched(false);onEvent({type:'notice',message:'已撤销这次样式调整，研究内容保留。'})
  }
  const focusIds=(ids:Set<string>,replaceSelection=false)=>{
    const current=api.getAppState(),scene=api.getSceneElements()
    const targets=scene.filter(e=>!e.isDeleted&&ids.has(e.customData?.forkwiseId))
    if(!targets.length)return
    if(!savedView)setSavedView({projectId:snapshot.projectId,session:snapshot.session,mode:snapshot.mode,scrollX:current.scrollX,scrollY:current.scrollY,zoom:current.zoom,count:ids.size,relationIds:[...selectedRelations],selectedElementIds:{...current.selectedElementIds},selectedGroupIds:{...current.selectedGroupIds}})
    else setSavedView({...savedView,count:ids.size})
    if(replaceSelection){
      const selected=targets.filter(element=>element.customData?.forkwisePart!=='relation')
      const selectedElementIds=Object.fromEntries(selected.map(element=>[element.id,true as const]))
      const selectedGroupIds=Object.fromEntries(selected.flatMap(element=>element.groupIds.map(id=>[id,true])))
      api.updateScene({appState:{selectedElementIds,selectedGroupIds,editingGroupId:null},captureUpdate:CaptureUpdateAction.NEVER})
      onEvent({type:'select',id:[...ids][0]})
    }
    setMore(false)
    api.scrollToContent(targets,{fitToContent:true,animate:false,canvasOffsets:{top:90,bottom:140,left:20,right:20}})
  }
  const focusObjects=()=>{if(selectedIds.length)focusIds(focusNeighborhood(snapshot,selectedIds))}
  const focusRange=(ids:string[])=>{
    const validIds=new Set(ids.filter(id=>snapshot.cards.some(card=>card.id===id)))
    if(!validIds.size){onEvent({type:'notice',message:'所选研究范围已不存在，请重新选择。'});return}
    closeLocal();focusIds(validIds,true)
  }
  useEffect(()=>{registerFocusRange(focusRange)},[api,snapshot,savedView])
  const returnView=()=>{
    if(!savedView)return
    if(savedView.projectId===snapshot.projectId&&savedView.session===snapshot.session&&savedView.mode===snapshot.mode){selectRelations(savedView.relationIds||[]);api.updateScene({appState:{scrollX:savedView.scrollX,scrollY:savedView.scrollY,zoom:savedView.zoom,selectedElementIds:savedView.selectedElementIds,selectedGroupIds:savedView.selectedGroupIds},captureUpdate:CaptureUpdateAction.NEVER})}
    setSavedView(null)
  }
  const arrangeObjects=(operation:SelectionLayoutOperation)=>{
    if(!snapshot.history||!editable||selectedCards.length<2)return
    const cards=selectedCards.map(card=>{const shape=cardShape(card.id);return {id:card.id,x:shape?.x??card.x,y:shape?.y??card.y,width:shape?.width??card.width,height:shape?.height??card.height}})
    const positions=layoutSelection(cards,operation)
    if(!positions.length){onEvent({type:'notice',message:'所选对象已处于这个排列位置。'});return}
    const labels={left:'左对齐',top:'顶部对齐',horizontal:'水平等距',vertical:'垂直等距'}
    const axis=operation==='horizontal'?'x':'y',size=operation==='horizontal'?'width':'height'
    const expanded=(operation==='horizontal'||operation==='vertical')&&Math.max(...cards.map(card=>card[axis]+card[size]))-Math.min(...cards.map(card=>card[axis]))<cards.reduce((sum,card)=>sum+card[size],0)
    onEvent({type:'commit',positions,label:`${labels[operation]}所选对象`})
    onEvent({type:'notice',message:`已将所选 ${cards.length} 个研究对象${labels[operation]}${expanded?'；空间不足，已向外展开':''}。可一次撤销。`})
  }
  useEffect(()=>{
    const escape=(event:KeyboardEvent)=>{if(!event.defaultPrevented&&event.key==='Escape'&&(draft||sourceId||styleIds||more||arrange)){event.preventDefault();event.stopPropagation();closeLocal()}}
    window.addEventListener('keydown',escape,true)
    return()=>window.removeEventListener('keydown',escape,true)
  },[draft,sourceId,styleIds,more,arrange])
  const toolbarCard=single||selectedCards[0],toolbarBounds=toolbarCard?bounds(toolbarCard):null
  const toolWidth=Math.min(single&&snapshot.directCanvas?310:single?420:360,viewport.width-16)
  useLayoutEffect(()=>{
    const node=toolbarRef.current;if(!node)return
    const measure=()=>{const height=node.getBoundingClientRect().height;setToolbarHeight(previous=>Math.abs(previous-height)>.5?height:previous)}
    measure();const observer=new ResizeObserver(measure);observer.observe(node)
    return()=>observer.disconnect()
  },[selectionKey,more,arrange,viewport.width,Boolean(draft||sourceCard||styleIds)])
  const toolbarPosition=()=>{
    if(!toolbarBounds)return {}
    // The dock and connection controls move and wrap. Reserve their actual footprint;
    // its CSS bottom offset is not the top edge of the area it occupies.
    const gap=12,safe={left:8,top:84,right:viewport.width-8,bottom:Math.min(viewport.height-108,(dockTop??viewport.height-108)-gap)}
    const maxHeight=Math.max(0,safe.bottom-safe.top),height=Math.min(toolbarHeight,maxHeight)
    const clampLeft=(left:number)=>Math.max(safe.left,Math.min(safe.right-toolWidth,left))
    const clampTop=(top:number)=>Math.max(safe.top,Math.min(safe.bottom-height,top))
    const b=toolbarBounds,left=clampLeft(b.left)
    const candidates=[
      {left,top:b.top-height-gap},
      {left,top:b.top+b.height+gap},
      {left:b.left+b.width+gap,top:clampTop(b.top)},
      {left:b.left-toolWidth-gap,top:clampTop(b.top)},
    ].filter(at=>at.left>=safe.left&&at.left+toolWidth<=safe.right&&at.top>=safe.top&&at.top+height<=safe.bottom)
    const overlap=(at:{left:number;top:number})=>snapshot.cards.reduce((area,card)=>{const box=bounds(card);return area+Math.max(0,Math.min(at.left+toolWidth,box.left+box.width)-Math.max(at.left,box.left))*Math.max(0,Math.min(at.top+height,box.top+box.height)-Math.max(at.top,box.top))},0)
    // Prefer the space above the selected object; an expanded toolbar uses its
    // measured height. Below/side placements keep the same protected chrome area.
    const nearby=snapshot.cards.filter(card=>card.kind==='claim').flatMap(card=>{const box=bounds(card);return [
      {left:box.left+box.width+gap,top:clampTop(b.top)},
      {left:box.left-toolWidth-gap,top:clampTop(b.top)},
      {left,top:box.top-height-gap},
      {left,top:box.top+box.height+gap},
    ]}).filter(at=>at.left>=safe.left&&at.left+toolWidth<=safe.right&&at.top>=safe.top&&at.top+height<=safe.bottom)
    const distance=(at:{left:number;top:number})=>Math.hypot(at.left+toolWidth/2-b.left-b.width/2,at.top+height/2-b.top-b.height/2)
    const free=nearby.filter(at=>overlap(at)===0).sort((a,b)=>distance(a)-distance(b))
    const position=candidates.find(at=>overlap(at)===0)||free[0]||candidates.sort((a,b)=>overlap(a)-overlap(b))[0]||{left,top:clampTop(b.top-height-gap)}
    return {...position,width:toolWidth,maxHeight}
  }
  const toolAt=toolbarPosition()
  const styleTargets=styleIds?elements.filter(e=>isStyleTarget(e,snapshot.cards,styleIds)):[]
  const styleValue=(field:keyof ObjectStyle)=>{const values=[...new Set(styleTargets.map(e=>objectStyle(e)[field]))];return values.length===1?values[0]:undefined}
  const allClaims=Boolean(styleIds?.length&&styleIds.every(id=>snapshot.cards.some(c=>c.id===id&&c.kind==='claim')))
  const localOpen=Boolean(draft||sourceCard||styleIds)
  return <div ref={overlayRef} className="research-overlay" data-research-selection={Boolean(selectedCards.length)} data-research-arrow-tool={Boolean(snapshot.simpleLinks&&state.activeTool.type==='arrow')} onKeyDown={event=>{if(event.key==='Escape'){if(!localOpen&&!more&&!arrange)selectRelations([]);closeLocal();event.stopPropagation()}}}>
    {snapshot.simpleLinks&&state.activeTool.type==='selection'&&<svg className="relation-hit-layer" aria-label="推导连线选择">
      <defs><clipPath id="research-line-hits"><path fillRule="evenodd" clipRule="evenodd" d={`M0 0H${viewport.width}V${viewport.height}H0Z `+snapshot.cards.filter(c=>c.kind==='claim').map(c=>{const b=bounds(c);return `M${b.left} ${b.top}h${b.width}v${b.height}h${-b.width}Z`}).join(' ')}/></clipPath></defs>
      <g clipPath="url(#research-line-hits)">{elements.flatMap(e=>{
        if(e.type!=='arrow'||e.customData?.forkwisePart!=='relation')return []
        const card=snapshot.cards.find(c=>c.id===e.customData?.forkwiseId)
        if(!card)return []
        const points=e.points.map(([x,y])=>`${(e.x+x+state.scrollX)*zoom},${(e.y+y+state.scrollY)*zoom}`).join(' ')
        return [<polyline key={e.id} data-relation-hit={card.id} data-relation-segment={e.customData?.forkwiseSegment} points={points} fill="none" stroke="transparent" strokeWidth={14} strokeLinejoin="round" onPointerDown={stop} onClick={event=>selectCard(card,event.shiftKey)} onDoubleClick={()=>edit(card)}/>]
      })}</g>
    </svg>}
    <svg className="relation-highlight" aria-hidden="true">
      {elements.map(e=>{
        if(e.type!=='arrow'||e.customData?.forkwisePart!=='relation')return null
        const card=snapshot.cards.find(c=>c.id===e.customData?.forkwiseId),active=neighborhoodIds.has(card?.id||'')
        if(!card?.affected&&!active)return null
        const points=e.points.map(([x,y])=>`${(e.x+x+state.scrollX)*zoom},${(e.y+y+state.scrollY)*zoom}`).join(' ')
        return <polyline key={e.id} data-relation-highlight={active?card?.id:undefined} points={points} fill="none" stroke={card?.affected?'#8a5a00':'#276e68'} strokeWidth={Math.max(5,7*zoom)} strokeLinejoin="round" opacity=".25"/>
      })}
    </svg>
    {snapshot.cards.map(card=>{
      const b=bounds(card),shape=cardShape(card.id),meta=shape?.customData||{},footerY=Number(meta.forkwiseFooterY??(b.height/zoom-34)),pad=card.kind==='inference'?b.width/zoom-108:20
      const stanceTag=elements.find(e=>e.customData?.forkwiseId===card.id&&(e.customData?.forkwiseField==='stance-tag'||snapshot.simpleLinks&&card.kind==='inference'&&e.customData?.forkwiseField==='stance'))
      const stanceToken=card.stance==='认可'?'accepted':card.stance==='质疑'?'questioned':card.stance==='不认可'?'rejected':'pending'
      if(b.left+b.width<0||b.top+b.height<0||b.left>viewport.width||b.top>viewport.height)return null
      if(card.noteCard)return <NotebookCard key={card.id} card={card} left={b.left} top={b.top} width={b.width/zoom} height={b.height/zoom} zoom={zoom} selected={selectedIds.includes(card.id)} related={neighborhoodIds.has(card.id)&&!selectedIds.includes(card.id)} open={()=>task('notebook',card)} resize={(width,height)=>onEvent({type:'card-size',id:card.id,width,height})}/>
      return <div key={card.id}>
        {selectedIds.includes(card.id)&&card.kind==='claim'&&<div className="card-selection" style={{left:b.left,top:b.top,width:b.width,height:b.height,borderRadius:10*zoom}}/>}
        {snapshot.directCanvas&&neighborhoodIds.has(card.id)&&!selectedIds.includes(card.id)&&<div className="card-neighborhood" data-neighborhood-card={card.id} aria-hidden="true" style={{left:b.left-3,top:b.top-3,width:b.width+6,height:b.height+6,borderRadius:(card.kind==='claim'?10:5)*zoom}}/>}
        {stanceTag&&<button className="research-ui card-hit card-stance" data-stance-card={card.id} data-stance-token={stanceToken} aria-label={`我的立场：${card.stance}，查看或修改`} style={{left:(stanceTag.x+state.scrollX)*zoom,top:(stanceTag.y+state.scrollY)*zoom,width:stanceTag.width*zoom,height:stanceTag.height*zoom}} onPointerDown={stop} onClick={()=>task('stance',card)}>{card.stance}</button>}
        {(snapshot.semanticDensity??3)>=3&&!(snapshot.simpleLinks&&card.kind==='inference')&&<button className="research-ui card-hit card-source" data-source-card={card.id} aria-label={`来源：${card.text}`} style={{left:b.left+pad*zoom,top:b.top+(footerY-5)*zoom,width:82*zoom,height:28*zoom}} onPointerDown={stop} onClick={()=>sourceId===card.id?closeLocal():openSource(card)}>来源 {card.sources.length}</button>}
        <button className="research-ui card-hit card-details" data-details-card={card.id} aria-label={`选择并操作：${card.text}`} style={snapshot.simpleLinks&&card.kind==='inference'?{left:b.left,top:b.top,width:b.width,height:24*zoom}:{left:b.left+b.width-48*zoom,top:(snapshot.semanticDensity??3)>=3?b.top+(footerY-5)*zoom:b.top+b.height-24*zoom,width:40*zoom,height:28*zoom}} onPointerDown={stop} onClick={event=>selectCard(card,event.shiftKey)}>操作</button>
        {(snapshot.semanticDensity??3)>=2&&card.kind==='claim'&&<button className="research-ui card-hit card-check" data-check-card={card.id} aria-label={`查证：${card.verification}。${card.verificationSummary}`} style={{left:b.left+20*zoom,top:b.top+Number(meta.forkwiseCheckY??120)*zoom,width:b.width-40*zoom,height:Number(meta.forkwiseCheckHeight??50)*zoom}} onPointerDown={stop} onClick={()=>task('results',card)}>查证：{card.verification}。{card.verificationSummary}</button>}
      </div>
    })}
    {toolbarCard&&!localOpen&&<div ref={toolbarRef} className={`research-ui object-toolbar ${snapshot.directCanvas&&single?'object-toolbar-compact':''}`} data-object-kind={single?.kind} role="toolbar" aria-label="所选研究对象操作" data-toolbar-count={selectedCards.length} data-selected-ids={selectedIds.join(',')} style={toolAt} onPointerDown={stop}>
      <div className="object-toolbar-range"><strong>{single?single.kind==='inference'?'线上推导':'主张卡':`已选 ${selectedCards.length} 个研究对象`}</strong><span hidden={Boolean(snapshot.directCanvas&&single)}>{selection.free.length?`另选 ${selection.free.length} 个批注，仅操作研究对象`:snapshot.directCanvas&&single&&neighborhoodIds.size>selectedIds.length?'相关前提与结论已高亮':'Shift 点选可多选'}</span></div>
      <div className="object-toolbar-actions">
        {single&&<><button data-object-action="rewrite" data-object-id={single.id} disabled={!editable} title={!editable?'收录后可改写':undefined} onClick={()=>single.noteCard?task('notebook'):edit(single)}>{single.noteCard?'写字板':snapshot.directCanvas?(single.kind==='inference'?'说明':'改写'):'改写'}</button>{snapshot.directCanvas?<button data-object-action="judgment" data-object-id={single.id} onClick={()=>task('judgment')}>查证与立场</button>:<><button data-object-action="stance" data-object-id={single.id} onClick={()=>task('stance')}>立场</button><button data-object-action="results" data-object-id={single.id} onClick={()=>task('results')}>查证</button><button data-object-action="materials" data-object-id={single.id} onClick={()=>task('materials')}>材料</button>
          <button data-object-action="annotations" data-object-id={single.id} onClick={()=>task('annotations')}>随动批注</button>
          <button data-object-action="source" data-object-id={single.id} onClick={()=>openSource(single)}>来源</button><button data-object-action="structure" data-object-id={single.id} onClick={()=>task('structure')}>推导</button></>}</>}
        {!snapshot.directCanvas&&snapshot.history&&snapshot.mode==='author'&&<button data-object-action="adopt" onClick={()=>task('adopt')}>收录所选</button>}
        {(!single||!snapshot.directCanvas)&&<button data-object-action="ai" data-object-id={toolbarCard.id} onClick={()=>task('ai')}>AI{selectedCards.length>1?` · ${selectedCards.length} 项`:''}</button>}
        {!single&&<>{snapshot.history&&editable&&<button data-object-action="arrange" aria-expanded={arrange} onClick={()=>setArrange(!arrange)}>排列</button>}<button data-object-action="style" onClick={openStyles}>样式</button><button data-object-action="focus" onClick={focusObjects}>聚焦</button></>}
        {single&&<button data-object-action="more" aria-expanded={more} aria-controls="object-more-menu" onClick={()=>{onEvent({type:'overlay',open:!more});setMore(!more)}}>更多</button>}
      </div>
      {arrange&&snapshot.history&&editable&&<div className="object-more" role="group" aria-label="局部排版"><button data-layout="left" onClick={()=>arrangeObjects('left')}>左对齐</button><button data-layout="top" onClick={()=>arrangeObjects('top')}>顶部对齐</button><button data-layout="horizontal" disabled={selectedCards.length<3} title="至少选择 3 个研究对象" onClick={()=>arrangeObjects('horizontal')}>水平等距</button><button data-layout="vertical" disabled={selectedCards.length<3} title="至少选择 3 个研究对象" onClick={()=>arrangeObjects('vertical')}>垂直等距</button><span className="layout-note">仅移动所选研究对象，可一次撤销。</span></div>}
      {more&&single&&<div id="object-more-menu" className={`object-more ${snapshot.directCanvas?'object-menu-flat':''}`} role="group" aria-label="更多对象操作">
        {snapshot.directCanvas&&<>
          <button data-object-action="materials" data-object-id={single.id} onClick={()=>task('materials')}>材料</button>
          <button data-object-action="annotations" data-object-id={single.id} onClick={()=>task('annotations')}>随动批注</button>
          <button data-object-action="source" data-object-id={single.id} onClick={()=>openSource(single)}>来源</button>
          <button data-object-action="ai" data-object-id={single.id} onClick={()=>task('ai')}>AI 讨论</button>
          <button data-object-action="question" data-object-id={single.id} onClick={()=>task('question')}>待查问题</button>
          {single.kind==='claim'&&<button data-object-action="preview" data-object-id={single.id} onClick={()=>task('preview')}>试一个假设</button>}
          <hr/>
        </>}
        <button data-object-action="history" data-object-id={single.id} onClick={()=>task('history')}>修改记录</button>
        {single.kind==='claim'&&editable&&<button data-object-action="duplicate" data-object-id={single.id} onClick={()=>{closeLocal();onEvent({type:'duplicate-card',id:single.id})}}>复制为独立研究卡</button>}
        {snapshot.directCanvas&&<hr/>}
        <button data-object-action="style" onClick={openStyles}>{snapshot.directCanvas?(single.kind==='inference'?'线条样式':'卡片样式'):'样式'}</button>
        <button data-object-action="focus" onClick={focusObjects}>{snapshot.directCanvas&&single.kind==='inference'?'聚焦这步推导':'聚焦相关推导'}</button>
        {snapshot.directCanvas&&<hr/>}
        <button className="object-action-danger" data-object-action="delete" data-object-id={single.id} disabled={!editable} title={!editable?'收录后可删除':undefined} onClick={()=>{if(editable){closeLocal();onEvent({type:'delete',id:single.id})}}}>{snapshot.directCanvas?(single.kind==='inference'?'删除这步推导':'删除卡片'):'删除'}</button>
        {snapshot.directCanvas&&<p className="object-menu-note">{single.kind==='inference'?'删除这一步的全部连线，保留前提和结论卡。':'删除此卡及引用它的推导。'}{snapshot.backend?'修改历史保留。':'可撤销。'}</p>}
      </div>}
    </div>}
    {savedView&&<div className="research-ui focus-scope" role="status" onPointerDown={stop}><span>已聚焦当前研究范围，共 {savedView.count} 个对象；全图保留。</span><button data-object-action="return-view" onClick={returnView}>返回上次视图</button></div>}
    {!snapshot.simpleLinks&&texts.length>0&&!selected.some(e=>e.customData?.forkwisePart)&&!draft&&<div className="research-ui convert-text" onPointerDown={stop}><span>已选自由文字</span><button onClick={promote}>整理成主张卡</button></div>}
    {draft&&<section data-object-kind={draftCard?.kind||'claim'} className="research-ui research-popover inline-claim" style={anchor(draft.id)} role="dialog" aria-label={draft.id?'改写当前对象':'写下主张'} onPointerDown={stop}>
      <header><strong>{draft.id?draftCard?.kind==='inference'?'推导说明':'改写正文':'写下主张'}</strong><button onClick={closeLocal} aria-label="关闭当前编辑">×</button></header>
      <label>{draftCard?.kind==='inference'?'为什么这些前提能支持结论？':'一句可研究的表述'}<textarea ref={focus} value={draft.text} placeholder="例如：回款周期可能影响现金流" onChange={e=>setDraft({...draft,text:e.target.value})}/></label>
      {needsScope&&<div className="shared-premise-scope"><p>这项前提被 {draftRelations.length} 步推导使用</p><label>本次修改范围<select aria-label="本次修改范围" aria-required="true" value={validScope?draft.scope:''} onChange={event=>setDraft({...draft,scope:event.target.value})}><option value="" disabled>请选择本次修改范围</option>{draftRelations.map(relation=><option key={relation.id} value={relation.id}>仅这一步：{relation.text}</option>)}<option value="all">统一更新所有引用它的推导</option></select></label><p className="scope-explanation">{draft.scope==='all'?'所有引用这项前提的推导都将使用新版本。':validScope?`为“${draftRelations.find(relation=>relation.id===draft.scope)?.text}”保留局部版本，其他推导继续使用原前提。`:'请选择仅修改哪一步推导的前提，或明确统一更新。'}</p></div>}
      <p>{draft.id?'保存后回到画布，自动保留修改记录；来源与原版保留。关闭或 Esc 不提交。':draft.conversion?'确认后用研究卡替换所选文字／矩形，保留原位置，可一次撤销。普通连线不自动成为推导。':'内容起点记为“用户”，材料引用与个人判断可以之后补充。'}</p>
      <p role="status">{pendingCreate?'正在保存到本机数据库…':submitError}</p><footer><button disabled={Boolean(pendingCreate)} onClick={closeLocal}>取消</button><button className="primary" onClick={submit} disabled={Boolean(pendingCreate)||(!draft.text.trim()&&draftCard?.kind!=='inference')||Boolean(draft.id&&draft.text.trim()===draftCard?.text.trim())||needsScope&&!validScope}>{draft.id?'保存改写':draft.conversion?'确认转卡':'放到画布'}</button></footer>
    </section>}
    {styleIds&&<section className="research-ui research-popover style-popover" style={anchor(styleIds[0])} role="dialog" aria-label="所选对象样式" onPointerDown={stop}>
      <header><strong>样式 · {styleIds.length} 个研究对象</strong><button onClick={closeLocal} aria-label="关闭样式">×</button></header>
      <p className="source-note">{allClaims?'仅调整所选主张卡的外观。':'仅调整所选对象的描边；推导样式作用于这一步的全部线段。'}内容起点、立场和查证保留。{selection.free.length?'已选自由批注不在此范围，取消研究对象选择后可使用原生属性。':''}</p>
      <label className="style-color-control">描边<input type="color" aria-label="描边颜色" value={colorValue(styleValue('strokeColor') as string,'#276e68')} onChange={e=>applyStyle({strokeColor:e.target.value})}/><span>{styleValue('strokeColor')===undefined?'混合':styleValue('strokeColor')}</span></label>
      <div className="style-swatches">{colors.map(color=><button key={color} aria-label={`描边 ${color}`} title={color} style={{backgroundColor:color}} onClick={()=>applyStyle({strokeColor:color})}/>)}</div>
      {allClaims&&<label className="style-color-control">背景<input type="color" aria-label="背景颜色" value={colorValue(styleValue('backgroundColor') as string,'#ffffff')} onChange={e=>applyStyle({backgroundColor:e.target.value})}/><button onClick={()=>applyStyle({backgroundColor:'transparent'})}>透明</button><span>{styleValue('backgroundColor')===undefined?'混合':styleValue('backgroundColor')==='transparent'?'透明':''}</span></label>}
      <label>线宽<select aria-label="线宽" value={styleValue('strokeWidth')??''} onChange={e=>applyStyle({strokeWidth:Number(e.target.value)})}><option value="" disabled>混合</option>{[1,1.5,2,4].map(width=><option key={width} value={width}>{width} px</option>)}</select></label>
      <label>线型<select aria-label="线型" value={styleValue('strokeStyle')??''} onChange={e=>applyStyle({strokeStyle:e.target.value as ObjectStyle['strokeStyle']})}><option value="" disabled>混合</option><option value="solid">实线</option><option value="dashed">虚线</option><option value="dotted">点线</option></select></label>
      <details className="style-more"><summary>更多样式</summary>{allClaims&&<label>填充纹理<select aria-label="填充纹理" value={styleValue('fillStyle')??''} onChange={e=>applyStyle({fillStyle:e.target.value as ObjectStyle['fillStyle']})}><option value="" disabled>混合</option><option value="solid">纯色</option><option value="hachure">斜线</option><option value="cross-hatch">交叉线</option></select></label>}<label>线条风格<select aria-label="线条风格" value={styleValue('roughness')??''} onChange={e=>applyStyle({roughness:Number(e.target.value)})}><option value="" disabled>混合</option><option value="0">简洁</option><option value="1">轻手绘</option><option value="2">手绘</option></select></label></details>
      <p className="source-note">样式仅影响外观，不新增内容版本。{snapshot.history?'随研究自动保存在本机，可统一撤销。':'本次页面内保存。'}</p>
      <footer><button onClick={resetStyle}>恢复默认</button><button disabled={!styleTouched} onClick={undoStyle}>撤销这次样式</button><button className="primary" onClick={closeLocal}>完成</button></footer>
    </section>}
    {sourceCard&&<section className="research-ui research-popover source-popover" style={anchor(sourceCard.id)} role="dialog" aria-label="卡片来源" onPointerDown={stop}>
      <header><strong>来源</strong><button onClick={closeLocal} aria-label="关闭来源">×</button></header>
      <p className="source-meta">内容起点 · {sourceCard.origin}{cardResearchStatus(sourceCard,snapshot.directCanvas)?` · ${cardResearchStatus(sourceCard,snapshot.directCanvas)}`:''}</p><p className="source-target">{sourceCard.text}</p><p className="source-note">{sourceCard.sourceNote}</p>
      {snapshot.directCanvas&&(sourceCard.canCorrectSource??(sourceCard.origin==='来源'&&!sourceCard.editStatus))&&<div className="source-correction"><button data-object-action="correct" data-object-id={sourceCard.id} onClick={()=>task('correct',sourceCard)}>校正整理结果</button><p className="source-note">用于修正系统对材料的整理错误；自己的新想法请使用“改写”。</p></div>}
      {!sourceCard.sources?.length&&<div className="source-empty">{sourceCard.origin.includes('AI')?'原文未明确表达，当前没有可回查引用。':'本人记录，当前没有关联外部原文。'}</div>}
      {sourceCard.sources?.map((source,index)=>{
        const originalUrl=safeOriginalUrl(source.originalUrl)
        const actionLabel=!source.available?'原文暂无法复核':source.coverage==='full'?'查看原文并定位':source.coverage==='excerpt'?'查看已保存摘录':'查看已保存材料'
        return <article key={`${source.ref.source}:${source.ref.start}:${index}`}>
          <span className="source-type">{source.label} · 材料 v{source.ref.version}</span><h3>{source.title}</h3>
          <p className="source-meta">{source.author} · {source.published}<br/>{source.period}</p>
          <blockquote>{source.ref.quote}</blockquote><p className="source-meta">原文位置：{source.locationLabel?.trim()||(source.ref.kind==='image'?'原图人工框选区域':`${source.ref.start+1}–${source.ref.end} 字符`)}<br/>{source.access}</p>
          <div className="source-actions"><button className={source.available?'primary':undefined} disabled={!source.available} onClick={()=>{const returnScroll=document.querySelector('.source-popover')?.scrollTop||0;closeLocal();onEvent({type:'source',id:sourceCard.id,ref:source.ref,returnScroll})}}>{actionLabel}</button>{originalUrl&&<a href={originalUrl} target="_blank" rel="noopener noreferrer">打开原始网页</a>}</div>
          <p className="source-meta">{source.available?<>{source.coverage==='excerpt'?'当前仅保存本次引用的摘录。':source.coverage!=='full'?'材料保存范围尚未确认。':''}在材料浮窗中查看本次引用的版本，点“返回来源”继续，× 退出到画布。</>:'当前仅有引文，未保存可对应本次引用的材料版本，原文暂无法复核。'}</p>
          {originalUrl&&<p className="source-meta">原始网页将在新标签页打开，网站内容可能已更新。</p>}
        </article>
      })}
    </section>}
  </div>
}
