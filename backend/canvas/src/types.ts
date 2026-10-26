export type SourceRef = {source:string;version:number;quote:string} & ({kind?:'text';start:number;end:number} | {kind:'image';width:number;height:number;region:{x:number;y:number;width:number;height:number};start?:never;end?:never})
export type SourceEntry = {
  ref:SourceRef; label:string; title:string; author:string; published:string; period:string; access:string; available:boolean;
  coverage?:'full'|'excerpt'|'unknown'; originalUrl?:string; locationLabel?:string;
}
export type Card = {
  id: string; kind: 'claim' | 'inference'; text: string; origin: string; editStatus?: string;
  stance: string; checked: string; verification: string; verificationSummary:string; version: number;
  x: number; y: number; width: number; height: number; compact: boolean;
  affected: boolean; children: number; sources:SourceEntry[]; sourceNote:string;
  combination?:string;
  manualPosition?:boolean;
  researchUse?:'reference'|'research';
  reconstructionCorrected?:boolean;
  canCorrectSource?:boolean;
  body?:string; tags?:string[]; showBody?:boolean; showTags?:boolean; customSize?:boolean; noteCard?:boolean;
}
export type PortSide = 'top'|'right'|'bottom'|'left'
export type Link = { id: string; relationId: string; from: string; to: string; fromSide?:PortSide; toSide?:PortSide }
export type TextConversion = {ids:string[]; signature:string; style?:Record<string,unknown>; frameId?:string|null}
export type CanvasDraft = { id?:string; text:string; reason:string; x:number; y:number; scope?:string; conversion?:TextConversion }
export type CanvasView = { relationIds?:string[]; scrollX:number; scrollY:number; zoom:{value:number}; selectedElementIds:Record<string,true>; selectedGroupIds:Record<string,boolean>; viewBackgroundColor?:string; theme?:'light'|'dark' }
export type CanvasPersistence = {
  scenes: Record<string,{styles:Record<string,Record<string,unknown>>;frames?:Record<string,string>;view?:CanvasView}>;
  annotations: {elements:unknown[];files:Record<string,unknown>};
  drafts?:Record<string,CanvasDraft>;
  attachments?:Record<string,{target:string;mode:string;x:number;y:number}>;
  returnViews?:Record<string,CanvasView & {count:number}>;
}
export type Snapshot = {
  projectId: string; session: number; mode: string; cards: Card[]; links: Link[];
  selected: string | null; linkFrom: string | null;
  canvasState?:CanvasPersistence; canvasRestoreRevision?:number; history?:{undoLabel:string|null;redoLabel:string|null};
  backend?:boolean; directCanvas?:boolean; simpleLinks?:boolean; semanticDensity?:0|1|2|3;
}
export type Position = { id: string; x: number; y: number }
export type ObjectTask = 'judgment'|'stance'|'results'|'structure'|'history'|'ai'|'question'|'preview'|'adopt'|'correct'|'materials'|'annotations'|'notebook'
export type CanvasEvent =
 | { type:'card-size'; id:string; width:number; height:number }
 | { type:'convert-arrow'; ids:string[]; from:string; to:string; fromSide?:PortSide; toSide?:PortSide; nativeDraw?:boolean; canvasState?:CanvasPersistence; canvasBefore?:CanvasPersistence }
 | { type:'connect'; from:string; to:string; text?:string; fromSide?:PortSide; toSide?:PortSide }
 | { type:'reconnect'; id:string; end:'premise'|'conclusion'; previous?:string; target:string; side?:PortSide }
 | { type:'select'; id:string }
 | { type:'task'; id:string; ids?:string[]; task:ObjectTask }
 | { type:'commit'; label?:string; positions:Position[]; sizes?:Record<string,{width:number;height:number}>; drop?:{child:string;parent:string}; canvasState?:CanvasPersistence; canvasBefore?:CanvasPersistence }
 | { type:'notice'; message:string }
 | { type:'details'; id:string; view?:'results'|'edit' }
 | { type:'source'; id:string; ref:SourceRef; returnScroll?:number }
 | { type:'create'; requestId?:string; text:string; x:number; y:number; conversion?:TextConversion }
 | { type:'duplicate-card'; id:string }
 | { type:'image-material'; id:string; imageId:string; fileId:string; data:string; width:number; height:number }
 | { type:'edit'; id:string; text:string; reason:string; scope?:string; sizes?:Record<string,{width:number;height:number}>; previousHeight?:number }
 | { type:'delete'; id:string; ids?:string[]; canvasState?:CanvasPersistence; canvasBefore?:CanvasPersistence }
 | { type:'overlay'; open:boolean }
 | { type:'canvas-state'; state:CanvasPersistence; commit?:string; before?:CanvasPersistence }
 | { type:'history'; direction:'undo'|'redo' }
 | { type:'cancel-link' }
export type EditorHandle = {
  fit: () => void;
  reveal: (id:string) => void;
  revealAnnotation: (id:string) => void;
  focusRange: (ids:string[]) => void;
  exportFile: () => Promise<void> | void;
  exportSvg: () => Promise<void> | void;
  exportPng: () => Promise<void> | void;
  getScene: () => unknown;
  loadScene: (scene: unknown) => Promise<void> | void;
  newClaim: () => void;
  search: () => void;
  restoreSource: (id:string,scroll:number) => void;
  flush: () => void;
}
export type EditorProps = {
  snapshot: Snapshot;
  onEvent: (event:CanvasEvent) => void;
  onReady: (handle:EditorHandle|null) => void;
}
export function cardResearchStatus(card:Card,directCanvas=false):string{
  if(!directCanvas)return card.editStatus||''
  const state=card.editStatus||(card.researchUse==='reference'?(card.origin.includes('AI')?'AI 候选':'参考内容'):card.researchUse==='research'?'研究中':'')
  return [state,card.reconstructionCorrected?'整理已校正':''].filter(Boolean).join(' · ')
}
export function saveBlob(blob:Blob,name:string){
 const url=URL.createObjectURL(blob), a=document.createElement('a');
 a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
