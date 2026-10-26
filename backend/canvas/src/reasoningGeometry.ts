import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types'
import type { CanvasPersistence } from './types'

export function targetAnchor(elements:readonly ExcalidrawElement[],target:string){
  const shape=elements.find(e=>!e.isDeleted&&e.customData?.forkwisePart==='card'&&e.customData.forkwiseId===target)
  return shape?{x:shape.x+shape.width/2,y:shape.y+shape.height/2}:null
}
// Attachments are ordinary annotations. Domain identity is never put on them.
export function followAttachments(elements:readonly ExcalidrawElement[],state:CanvasPersistence,mode:string){
  const attachments={...state.attachments},byId=new Map(elements.map(e=>[e.id,e]))
  let moved=false
  for(const [id,binding] of Object.entries(attachments)){
    const note=byId.get(id)
    if(!note||note.isDeleted||binding.mode!==mode)continue
    const anchor=targetAnchor(elements,binding.target)
    if(!anchor){delete attachments[id];continue}
    const dx=anchor.x-binding.x,dy=anchor.y-binding.y
    if(Math.abs(dx)>.01||Math.abs(dy)>.01){byId.set(id,{...note,x:note.x+dx,y:note.y+dy,version:note.version+1});moved=true}
    attachments[id]={...binding,...anchor}
  }
  return {elements:moved?elements.map(e=>byId.get(e.id)!):elements,state:{...state,attachments}}
}
