import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types'
import type { Card, Snapshot } from './types'

export type ObjectStyle = Pick<ExcalidrawElement,'strokeColor'|'backgroundColor'|'strokeWidth'|'strokeStyle'|'fillStyle'|'roughness'|'opacity'>
export const inferenceDefaultStyle={strokeColor:'#8297a8',backgroundColor:'transparent',strokeWidth:1.5,strokeStyle:'solid' as const,fillStyle:'solid' as const,roughness:0,opacity:100}
export const objectStyleFields = ['strokeColor','backgroundColor','strokeWidth','strokeStyle','fillStyle','roughness','opacity'] as const

export function objectSelection(elements:readonly ExcalidrawElement[], selected:Readonly<Record<string,boolean>>, groups:Readonly<Record<string,boolean>>,relations:readonly string[]=[] ){
  const chosen=elements.filter(e=>!e.isDeleted&&(selected[e.id]||e.groupIds.some(id=>groups[id])))
  const ids=[...new Set([...relations,...chosen.flatMap(e=>typeof e.customData?.forkwiseId==='string'?[e.customData.forkwiseId]:[])])]
  return {ids,free:chosen.filter(e=>!e.customData?.forkwisePart)}
}

export function isStyleTarget(element:ExcalidrawElement, cards:readonly Card[], ids:readonly string[]){
  const id=element.customData?.forkwiseId,card=cards.find(c=>c.id===id)
  return !element.isDeleted&&Boolean(card&&ids.includes(card.id)&&(card.kind==='claim'?element.customData?.forkwisePart==='card':element.customData?.forkwisePart==='relation'))
}

export function objectStyle(element:ExcalidrawElement):ObjectStyle{
  return {strokeColor:element.strokeColor,backgroundColor:element.backgroundColor,strokeWidth:element.strokeWidth,strokeStyle:element.strokeStyle,fillStyle:element.fillStyle,roughness:element.roughness,opacity:element.opacity}
}

export function focusNeighborhood(snapshot:Snapshot,selected:readonly string[]){
  const ids=new Set(selected),relations=new Set(selected.filter(id=>snapshot.cards.some(c=>c.id===id&&c.kind==='inference')))
  for(const link of snapshot.links)if(ids.has(link.from)||ids.has(link.to))relations.add(link.relationId)
  for(const link of snapshot.links)if(relations.has(link.relationId)){ids.add(link.from);ids.add(link.to)}
  return ids
}
