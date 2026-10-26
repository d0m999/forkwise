import {useLayoutEffect,useRef,useState} from 'react'
import type {Card} from './types'
import './card-module.js'
import './card-module.css'

declare global {interface Window {ForkwiseCards:{markup:(card:Card)=>string;fill:(card:Card,node:HTMLElement)=>void;minimum:(node:HTMLElement)=>number}}}
type Props={card:Card;left:number;top:number;width:number;height:number;zoom:number;selected:boolean;related:boolean;open:()=>void;resize:(width:number,height:number)=>void}
export default function NotebookCard({card,left,top,width,height,zoom,selected,related,open,resize}:Props){
  const node=useRef<HTMLDivElement>(null),gesture=useRef<{x:number;y:number;width:number;height:number;pointer:number}|null>(null)
  const [live,setLive]=useState<{width:number;height:number}|null>(null)
  const size=live||{width,height}
  useLayoutEffect(()=>setLive(null),[width,height,card.id])
  useLayoutEffect(()=>{if(node.current)window.ForkwiseCards.fill(card,node.current)},[card,size.width,size.height])
  const change=(w:number,h:number)=>{if(!node.current)return;const width=Math.max(220,w);node.current.style.width=width+'px';const height=Math.max(window.ForkwiseCards.minimum(node.current),h);setLive({width,height});return {width,height}}
  return <div ref={node} className={`fc-card${selected?' fc-selected':''}${related?' fc-related':''}`} data-notebook-card={card.id} style={{left,top,width:size.width,height:size.height,transform:`scale(${zoom})`,transformOrigin:'0 0'}} dangerouslySetInnerHTML={{__html:window.ForkwiseCards.markup(card)}}
    onClick={event=>{if((event.target as HTMLElement).closest('[data-card-notebook]')){event.stopPropagation();open()}}}
    onPointerDown={event=>{if(!(event.target as HTMLElement).closest('.fc-resize'))return;event.preventDefault();event.stopPropagation();gesture.current={x:event.clientX,y:event.clientY,width:size.width,height:size.height,pointer:event.pointerId};event.currentTarget.setPointerCapture(event.pointerId)}}
    onPointerMove={event=>{const g=gesture.current;if(!g||g.pointer!==event.pointerId)return;event.stopPropagation();change(g.width+(event.clientX-g.x)/zoom,g.height+(event.clientY-g.y)/zoom)}}
    onPointerUp={event=>{if(!gesture.current)return;event.stopPropagation();gesture.current=null;if(live)resize(live.width,live.height)}}
    onPointerCancel={()=>{gesture.current=null;setLive(null)}}
    onKeyDown={event=>{if(!(event.target as HTMLElement).closest('.fc-resize'))return;const deltas:Record<string,[number,number]>={ArrowLeft:[-22,0],ArrowRight:[22,0],ArrowUp:[0,-22],ArrowDown:[0,22]};const delta=deltas[event.key];if(delta){event.preventDefault();event.stopPropagation();const next=change(size.width+delta[0],size.height+delta[1]);if(next)resize(next.width,next.height)}}}/>
}
