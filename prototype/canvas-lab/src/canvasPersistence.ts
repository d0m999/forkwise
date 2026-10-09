import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types'
import type { AppState, BinaryFiles } from '@excalidraw/excalidraw/types'
import type { CanvasDraft, CanvasPersistence, CanvasView } from './types'

export const blankCanvasState=():CanvasPersistence=>({scenes:{},annotations:{elements:[],files:{}},drafts:{}})
export const cloneCanvasState=(value:CanvasPersistence):CanvasPersistence=>JSON.parse(JSON.stringify(value))
const styleFields=['strokeColor','backgroundColor','fillStyle','strokeWidth','strokeStyle','roughness','opacity','fontFamily','fontSize','textAlign'] as const
const isDomain=(element:ExcalidrawElement)=>Boolean(element.customData?.forkwisePart)
export function canvasView(app:AppState):CanvasView{
  return {scrollX:app.scrollX,scrollY:app.scrollY,zoom:{value:app.zoom.value},selectedElementIds:{...app.selectedElementIds},selectedGroupIds:{...app.selectedGroupIds},viewBackgroundColor:app.viewBackgroundColor,theme:app.theme}
}
export function captureCanvas(previous:CanvasPersistence,mode:string,elements:readonly ExcalidrawElement[],app:AppState,files:BinaryFiles,relationIds?:readonly string[]):CanvasPersistence{
  const styles:Record<string,Record<string,unknown>>={}
  const frames:Record<string,string>={}
  const liveFrames=new Set(elements.filter(e=>e.type==='frame'&&!e.isDeleted).map(e=>e.id))
  for(const element of elements){
    // Only author-editable appearance is stored. Generated projection text, positions
    // and Excalidraw version nonces are owned by the study and never enter history.
    if(!isDomain(element)||!['card','relation'].includes(element.customData!.forkwisePart)||element.isDeleted)continue
    styles[element.id]=Object.fromEntries(styleFields.filter(field=>field in element).map(field=>[field,(element as unknown as Record<string,unknown>)[field]]))
    if(element.customData!.forkwisePart==='card'&&element.frameId&&liveFrames.has(element.frameId))frames[element.id]=element.frameId
  }
  const annotations=elements.filter(element=>!isDomain(element))
  const fileIds=new Set<string>(annotations.flatMap(element=>element.type==='image'&&element.fileId?[element.fileId]:[]))
  // Excalidraw keeps a cumulative file cache. Persist only files referenced by
  // this project's annotation layer, including deleted elements for Undo.
  const referencedFiles=Object.fromEntries(Object.entries(files).filter(([fileId])=>fileIds.has(fileId)))
  // Native dragging mutates existing element objects in place. A captured state
  // must own its values, or the next pointer move silently changes the before image.
  const scenes=Object.fromEntries(Object.entries(previous.scenes).map(([key,scene])=>[key,{...scene,...(scene.frames?{frames:Object.fromEntries(Object.entries(scene.frames).filter(([,id])=>liveFrames.has(id)))}:{})}]))
  return cloneCanvasState({...previous,scenes:{...scenes,[mode]:{styles,frames,view:{...canvasView(app),...(relationIds?{relationIds:[...relationIds]}:{})}}},annotations:{elements:annotations,files:referencedFiles}})
}
export function restoreStyles(elements:readonly ExcalidrawElement[],value:CanvasPersistence|undefined,mode:string):ExcalidrawElement[]{
  const styles=value?.scenes[mode]?.styles??{}
  const frames=value?.scenes[mode]?.frames??{},liveFrames=new Set((value?.annotations.elements??[]).filter(e=>{const v=e as ExcalidrawElement;return v.type==='frame'&&!v.isDeleted}).map(e=>(e as ExcalidrawElement).id))
  return elements.map(element=>{
    const cardId=element.customData?.forkwiseId?`${element.id.split(':').slice(0,3).join(':')}:card:${element.customData.forkwiseId}`:element.id
    const frameId=frames[cardId]
    return {...element,...styles[element.id],frameId:frameId&&liveFrames.has(frameId)?frameId:null} as ExcalidrawElement
  })
}
export function canvasContentSignature(value:CanvasPersistence):string{
  const free=value.annotations.elements.map(element=>{
    const {version:_version,versionNonce:_nonce,updated:_updated,...content}=element as Record<string,unknown>
    return content
  })
  // Anchor coordinates follow the domain projection. They are derived bookkeeping,
  // not a separate user edit; recording them again would split one drag into two Undos.
  const attachments=Object.fromEntries(Object.entries(value.attachments??{}).map(([id,{target,mode}])=>[id,{target,mode}]))
  return JSON.stringify({scenes:Object.fromEntries(Object.entries(value.scenes).map(([mode,scene])=>[mode,{styles:scene.styles,frames:scene.frames??{}}])),elements:free,files:value.annotations.files,attachments})
}
const draftMemory=new Map<string,CanvasDraft>()
const draftKey=(projectId:string,mode:string)=>`${projectId}:${mode}`
export function getCanvasDraft(projectId:string,mode:string){const value=draftMemory.get(draftKey(projectId,mode));return value?{...value}:null}
export function putCanvasDraft(projectId:string,mode:string,draft:CanvasDraft|null){const key=draftKey(projectId,mode);if(draft)draftMemory.set(key,{...draft});else draftMemory.delete(key)}
export function restoreCanvasDrafts(projectId:string,value:CanvasPersistence|undefined){
  for(const key of draftMemory.keys())if(key.startsWith(`${projectId}:`))draftMemory.delete(key)
  for(const [mode,draft] of Object.entries(value?.drafts??{}))putCanvasDraft(projectId,mode,draft)
  for(const key of returnViewMemory.keys())if(key.startsWith(`${projectId}:`))returnViewMemory.delete(key)
  for(const [mode,view] of Object.entries(value?.returnViews??{}))putReturnView(projectId,mode,view)
}
export function captureCanvasDrafts(projectId:string){
  return Object.fromEntries([...draftMemory.entries()].filter(([key])=>key.startsWith(`${projectId}:`)).map(([key,draft])=>[key.slice(projectId.length+1),{...draft}]))
}

type ReturnView=CanvasView & {count:number}
const returnViewMemory=new Map<string,ReturnView>()
export function getReturnView(projectId:string,mode:string){const view=returnViewMemory.get(draftKey(projectId,mode));return view?{...view}:null}
export function putReturnView(projectId:string,mode:string,view:ReturnView|null){const key=draftKey(projectId,mode);if(view)returnViewMemory.set(key,{...view});else returnViewMemory.delete(key)}
export function captureReturnViews(projectId:string){return Object.fromEntries([...returnViewMemory.entries()].filter(([key])=>key.startsWith(`${projectId}:`)).map(([key,view])=>[key.slice(projectId.length+1),{...view}]))}
