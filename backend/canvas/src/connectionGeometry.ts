import type { PortSide } from './types'
export type Point={x:number;y:number}
export type Box=Point&{width:number;height:number}
export const sides:PortSide[]=['top','right','bottom','left']
export const sideNames:Record<PortSide,string>={top:'上边',right:'右边',bottom:'下边',left:'左边'}
export const normals:Record<PortSide,Point>={top:{x:0,y:-1},right:{x:1,y:0},bottom:{x:0,y:1},left:{x:-1,y:0}}
export function portPoint(b:Box,side:PortSide):Point{
  return {x:b.x+(side==='left'?0:side==='right'?b.width:b.width/2),y:b.y+(side==='top'?0:side==='bottom'?b.height:b.height/2)}
}
export function nearestSide(b:Box,p:Point):PortSide{
  return sides.reduce((best,side)=>Math.abs((side==='left'||side==='right')?p.x-portPoint(b,side).x:p.y-portPoint(b,side).y)<Math.abs((best==='left'||best==='right')?p.x-portPoint(b,best).x:p.y-portPoint(b,best).y)?side:best,'left')
}
// Route around the two endpoint cards, keeping a short outward segment at each port.
// Other graph objects do not influence the semantic endpoints or stored ports.
export function routePorts(a:Box,fromSide:PortSide,b:Box,toSide:PortSide):Point[]{
  const start=portPoint(a,fromSide),end=portPoint(b,toSide),gap=32;
  const first={x:start.x+normals[fromSide].x*gap,y:start.y+normals[fromSide].y*gap},last={x:end.x+normals[toSide].x*gap,y:end.y+normals[toSide].y*gap};
  const boxes=[a,b],xs=[...new Set([first.x,last.x,...boxes.flatMap(r=>[r.x-gap,r.x+r.width+gap])])].sort((x,y)=>x-y),ys=[...new Set([first.y,last.y,...boxes.flatMap(r=>[r.y-gap,r.y+r.height+gap])])].sort((x,y)=>x-y);
  const inside=(p:Point)=>boxes.some(r=>p.x>r.x-.5&&p.x<r.x+r.width+.5&&p.y>r.y-.5&&p.y<r.y+r.height+.5);
  const blocked=(p:Point,q:Point)=>boxes.some(r=>p.x===q.x?p.x>r.x-.5&&p.x<r.x+r.width+.5&&Math.max(p.y,q.y)>r.y&&Math.min(p.y,q.y)<r.y+r.height:p.y>r.y-.5&&p.y<r.y+r.height+.5&&Math.max(p.x,q.x)>r.x&&Math.min(p.x,q.x)<r.x+r.width);
  const nodes=xs.flatMap(x=>ys.map(y=>({x,y}))).filter(p=>!inside(p)),index=(p:Point)=>nodes.findIndex(q=>q.x===p.x&&q.y===p.y),s=index(first),t=index(last);
  const dist=nodes.map(()=>Infinity),previous=nodes.map(()=>-1),done=new Set<number>();if(s>=0)dist[s]=0;
  for(let n=0;n<nodes.length;n++){
    let u=-1;for(let i=0;i<nodes.length;i++)if(!done.has(i)&&(u<0||dist[i]<dist[u]))u=i;
    if(u<0||!Number.isFinite(dist[u])||u===t)break;done.add(u);
    for(let v=0;v<nodes.length;v++){const p=nodes[u],q=nodes[v];if(done.has(v)||p.x!==q.x&&p.y!==q.y||blocked(p,q))continue;const d=dist[u]+Math.abs(p.x-q.x)+Math.abs(p.y-q.y);if(d<dist[v]){dist[v]=d;previous[v]=u}}
  }
  const middle:Point[]=[];if(t>=0&&Number.isFinite(dist[t]))for(let v=t;v>=0;v=previous[v]){middle.unshift(nodes[v]);if(v===s)break}
  const points=[start,...(middle.length?middle:[first,{x:last.x,y:first.y},last]),end];
  return points.filter((p,i)=>!(i&&p.x===points[i-1].x&&p.y===points[i-1].y)).filter((p,i,all)=>!i||i===all.length-1||(all[i-1].x!==p.x||p.x!==all[i+1].x)&&(all[i-1].y!==p.y||p.y!==all[i+1].y));
}
export function splitRoute(points:Point[]){
  const lengths=points.slice(1).map((p,i)=>Math.hypot(p.x-points[i].x,p.y-points[i].y)),half=lengths.reduce((a,b)=>a+b,0)/2;
  let rest=half;for(let i=0;i<lengths.length;i++){if(rest<=lengths[i]){const ratio=lengths[i]?rest/lengths[i]:0,mid={x:points[i].x+(points[i+1].x-points[i].x)*ratio,y:points[i].y+(points[i+1].y-points[i].y)*ratio};return {mid,first:[...points.slice(0,i+1),mid],last:[mid,...points.slice(i+1)]}}rest-=lengths[i]}
  const mid=points[0];return {mid,first:[mid,mid],last:[mid,mid]}
}
