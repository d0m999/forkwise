// Pure research model; workspace persistence and the combined history live in the shell.
const OpenStudy = (() => {
  const clone = x => JSON.parse(JSON.stringify(x));
  const emptyGraph = () => ({nodes:{},edges:{}});
  const authorLines = [
    'Intel 18A 将在 2026 上半年按期进入量产。',
    '18A 的良率会接近可比水平。',
    '只要有按期量产和良率，外部大客户就会把订单交给 Intel Foundry。',
    '客户本来就希望有第二家先进制程供应商。',
    '外部订单落地之后，代工营收会在 2027 年前显著放量；这取决于资本开支压力会不会连续两个季度恶化。'
  ];
  const disclosureLines = [
    '公司披露 18A 仍处于试产阶段，未给出良率数据。',
    '本季度资本开支为 46 亿元，营收为 100 亿元。',
    '上季度资本开支为 38 亿元，营收为 102 亿元。',
    '管理层表示外部客户尚未形成正式订单承诺。',
    '本季度另一家厂商下调了先进制程报价。'
  ];
  const sampleSources = [
    {id:'m1',title:'模拟作者观点（Intel 代工）',author:'模拟作者',version:1,coverage:'full',published:'模拟日期：2026-09-18',period:'2026 下半年至 2027 年',text:authorLines.join('\n')},
    {id:'m2',title:'模拟官方季度披露（示例）',author:'模拟公司',version:1,coverage:'full',published:'模拟日期：2026-10-01',period:'模拟期间：最近两个季度',access:'模拟公开资料，尚未连接真实数据源',text:disclosureLines.join('\n')}
  ];
  function seed(){return {directCanvas:true,question:'这位作者关于 Intel 代工的核心判断依赖哪些前提，我认可哪些、质疑哪些？',pipeline:'input',sources:clone(sampleSources),source:'m1',mode:'mine',author:emptyGraph(),mine:emptyGraph(),baseline:null,selected:null,draft:null,linkFrom:null,preview:null,anchor:null,next:1,undo:[],log:[],message:'示例演示连线上的推导理由：共同依赖明确标注，独立支持各自保留推导线。分析与公开资料为模拟。',error:''};}
  function graph(s){return s.mode==='author'?s.author:(s.mine||emptyGraph());}
  function item(s,id=s.selected){const g=graph(s);return g.nodes[id]||g.edges[id];}
  function ref(s,source,start,end){const m=s.sources.find(x=>x.id===source);if(!m||start<0||end>m.text.length||end<=start)return null;return {source,version:m.version,start,end,quote:m.text.slice(start,end)};}
  function webUrl(value){
    try{const url=new URL(String(value||'').trim());return ['http:','https:'].includes(url.protocol)&&!url.username&&!url.password?url.href:'';}catch{return '';}
  }
  function resolveRef(s,r){
    if(r?.kind==='image')return materialRefValid(s,r)?s.sources.find(m=>m.id===r.source&&m.version===r.version):null;
    if(!r||!Number.isInteger(r.start)||!Number.isInteger(r.end)||r.start<0||r.end<=r.start||typeof r.quote!=='string')return null;
    const m=s.sources.find(x=>x.id===r.source&&x.version===r.version);
    return m&&r.end<=m.text.length&&m.text.slice(r.start,r.end)===r.quote?m:null;
  }
  function parts(m){let at=0;return m.text.split('\n').map(text=>{const p={text,start:at,end:at+text.length};at+=text.length+1;return p;}).filter(p=>p.text.trim());}
  function remember(s){const snap=clone(s);delete snap.undo;s.undo.push(snap);if(s.undo.length>25)s.undo.shift();}
  function nextObjectId(s,g,prefix='q'){let id;do{id=prefix+s.next++;}while(g.nodes[id]||g.edges[id]);return id;}
  function log(s,text){s.log.push(text);s.message=text;}
  function reachable(g,start,target){const visited=new Set(),stack=[start];while(stack.length){const id=stack.pop();if(id===target)return true;if(visited.has(id))continue;visited.add(id);Object.values(g.edges).filter(e=>e.premises.includes(id)).forEach(e=>stack.push(e.conclusion));}return false;}
  function linkError(g,parent,child){
    if(!g.nodes[parent]||!g.nodes[child])return '请连接两张主张卡片；线上推导可以移动，或选中后从对象旁改写理由。';
    if(parent===child)return '不能把一张卡片连接到自己。';
    if(Object.values(g.edges).some(e=>e.premises.includes(parent)&&e.conclusion===child))return '这两张卡片已经按这个方向连接，不重复新增。';
    if(reachable(g,child,parent))return '这条推导会形成回环。涉及不同期间时，请另建带时间范围的主张。';
    return '';
  }

  function connectionCheck(s,a){
    const g=graph(s),old=a.id?g.edges[a.id]:null;
    if([a.fromSide,a.toSide,a.side].some(side=>side!==undefined&&!['top','right','bottom','left'].includes(side)))return '连接边无效，请重新选择。';
    if(s.mode!=='mine'||a.id&&!old)return '请在研究画布选择有效推导。';
    const premises=old?(a.end==='premise'?old.premises.map(id=>id===a.previous?a.target:id):old.premises):[a.from];
    const conclusion=old?(a.end==='conclusion'?a.target:old.conclusion):a.to;
    if(old&&(!['premise','conclusion'].includes(a.end)||a.end==='premise'&&!old.premises.includes(a.previous)))return '待重连端点已变化，请重新选择。';
    if(!premises.length||premises.some(id=>!g.nodes[id])||!g.nodes[conclusion])return '请落在主张卡片上。';
    if(new Set(premises).size!==premises.length||premises.includes(conclusion))return '不能自连或重复同一步中的前提。';
    const others={nodes:g.nodes,edges:Object.fromEntries(Object.entries(g.edges).filter(([id])=>id!==old?.id))};
    const combination=old?.combination||'单一前提';
    if(Object.values(others.edges).some(e=>e.conclusion===conclusion&&e.combination===combination&&JSON.stringify([...e.premises].sort())===JSON.stringify([...premises].sort())))return '这一步推导已经存在，不重复建立。';
    if(premises.some(id=>reachable(others,conclusion,id)))return '这次连接会形成回环，请拆分不同时间范围。';
    return '';
  }
  function materialRefValid(s,r){
    if(r?.kind!=='image')return !!resolveRef(s,r);
    const m=s.sources.find(m=>m.id===r.source&&m.version===r.version),b=r.region;
    return !!(m?.kind==='image'&&m.width===r.width&&m.height===r.height&&b&&[b.x,b.y,b.width,b.height].every(Number.isFinite)&&b.x>=0&&b.y>=0&&b.width>0&&b.height>0&&b.x+b.width<=m.width+.01&&b.y+b.height<=m.height+.01);
  }
  function dropCheck(s,child,parent){
    const g=graph(s),error=linkError(g,parent,child);
    if(error)return {allowed:false,message:error};
    if(s.mode!=='mine')return {allowed:false,message:'这里是保留的整理原版。回到研究画布后可以直接建立自己的推导。'};
    return {allowed:true,message:'松手新增“落点卡片 → 拖动卡片”；原有连接保留。'};
  }
  // 内容起点固定；只比较正文与推导结构，位置、判断和证据不算内容编辑。
  const originKind=n=>n.originKind||(n.origin==='AI 推断'?'ai':n.origin==='作者表达'?'source':'user');
  const originLabel=n=>({source:'来源',user:'用户',ai:'AI'})[originKind(n)];
  const content=n=>({text:n.text,...(n.type==='inference'?{premises:n.premises,conclusion:n.conclusion,combination:n.combination}:{})});
  function stanceTarget(s,n){
    const g=graph(s),endpoint=id=>{const x=g.nodes[id];return {id,version:x.version,text:x.text};};
    return {id:n.id,type:n.type,version:n.version,text:n.text,signature:signature(g,n),...(n.type==='inference'?{premises:n.premises.map(endpoint),conclusion:endpoint(n.conclusion),combination:n.combination}:{})};
  }
  const isEdited=n=>!!n.initialContent&&JSON.stringify(content(n))!==JSON.stringify(n.initialContent);
  const editLabel=n=>isEdited(n)?'我已编辑':'';
  const researchUse=n=>n.researchUse||(originKind(n)==='user'?'research':'reference');
  const sharedPremises=(s,id)=>Object.values(graph(s).edges).filter(e=>e.premises.includes(id));
  const canCorrect=n=>!!n&&originKind(n)==='source'&&!n.edit&&!isEdited(n)&&!n.history?.some(previous=>previous.edit||isEdited(previous));
  function revise(n,reason,at){
    n.initialContent??=clone(content(n));
    const old=clone(n);delete old.history;n.history.push(old);n.version+=1;
    n.edit={by:'user',at:at||null,reason};n.changeReason=reason;
  }
  function affected(s,id){return Object.values(graph(s).edges).filter(e=>e.premises.includes(id)||e.conclusion===id).map(e=>e.id);}
  // Displaying a reconstruction makes it editable, not personally adopted.
  // Keep the original graph and the first comparison baseline independent.
  function addReferenceGraph(s){
    s.mine??=emptyGraph();s.baseline??=emptyGraph();const mapped=new Map();
    for(const collection of ['nodes','edges'])for(const original of Object.values(s.author[collection])){
      const type=collection==='nodes'?'claim':'inference',existing=adoptedObject(s,original.id,type);
      if(existing){mapped.set(original.id,existing.id);continue;}
      const value=clone(original),sourceId=original.id;
      if(s.mine.nodes[value.id]||s.mine.edges[value.id])value.id=nextObjectId(s,s.mine,'ref');
      mapped.set(sourceId,value.id);value.adoptedFrom=sourceId;value.researchUse='reference';
      if(type==='inference'){value.premises=value.premises.map(id=>mapped.get(id));value.conclusion=mapped.get(value.conclusion);if(value.ports)value.ports.premises=Object.fromEntries(Object.entries(value.ports.premises).map(([id,side])=>[mapped.get(id),side]));}
      value.base=clone(original);delete value.base.history;
      if(!s.baseline[collection][value.id])s.baseline[collection][value.id]=clone(value);
      s.mine[collection][value.id]=value;
    }
    return mapped;
  }
  function upgradeStudy(value){
    const s=clone(value);if(s.directCanvas)return s;
    const hadWorkingGraph=!!s.mine;
    if(hadWorkingGraph){
      for(const collection of ['nodes','edges'])for(const n of Object.values(s.mine[collection]))n.researchUse??='research';
    }else if(Object.keys(s.author?.nodes||{}).length){addReferenceGraph(s);}
    else s.mine=emptyGraph();
    s.directCanvas=true;s.mode='mine';s.linkFrom=null;s.preview=null;
    if(s.selected&&!s.mine.nodes[s.selected]&&!s.mine.edges[s.selected])s.selected=null;
    return s;
  }
  function clearCurrentAssessment(n){
    n.stance='待研究';n.reason='';n.checked='待核对';
    n.evidence=n.evidence.map(e=>({...e,previousEffect:e.effect==='尚待判断'?e.previousEffect:e.effect,previousReason:e.reason||e.previousReason,effect:'尚待判断',reason:'',targetVersion:n.version}));
  }
  function editScopeError(s,n,scope){
    if(n.type!=='claim')return scope&&scope!=='all'?'只有共享前提可以指定局部推导范围。':'';
    const uses=sharedPremises(s,n.id);
    if(scope&&scope!=='all'&&!uses.some(e=>e.id===scope))return '指定的推导没有引用这项前提，请重新选择修改范围。';
    return uses.length>1&&!scope?'这项前提被 '+uses.length+' 步推导共用。请选择只修改其中一步，或明确更新所有引用。':'';
  }
  function localEditTarget(s,n,scope,at,operation='edit'){
    if(!scope||scope==='all'||n.type!=='claim')return n;
    const g=graph(s),relation=g.edges[scope],local=clone(n),id=nextObjectId(s,g,'local');
    local.id=id;local.localOf=n.id;local.localFor=scope;local.x+=35;local.y+=80;
    g.nodes[id]=local;place(g,local);
    if(operation==='correction'){
      const previous=clone(relation),beforeContent=clone(content(relation)),fromVersion=relation.version;delete previous.history;
      relation.history.push(previous);relation.version+=1;
      relation.premises=relation.premises.map(p=>p===n.id?id:p);
      // Rebind only the corrected endpoint in the personal-edit comparison.
      // Existing personal text/structure differences remain differences.
      if(relation.initialContent?.premises)relation.initialContent.premises=relation.initialContent.premises.map(p=>p===n.id?id:p);
      relation.correctionHistory??=[];relation.correctionHistory.push({kind:'reconstruction-correction',by:'user',at:at||null,reason:'这一步推导使用来源整理校正后的局部前提',before:previous.text,after:relation.text,beforeContent,afterContent:clone(content(relation)),fromVersion,toVersion:relation.version,sourceRef:clone(n.sourceRef),correctedPremise:{before:n.id,after:id}});
    }else{
      revise(relation,'为这一步推导使用前提的局部版本',at);
      relation.premises=relation.premises.map(p=>p===n.id?id:p);relation.researchUse='research';
    }
    if(relation.ports&&relation.ports.premises[n.id]){relation.ports.premises[id]=relation.ports.premises[n.id];delete relation.ports.premises[n.id];}
    clearCurrentAssessment(relation);relation.needsReview=true;s.selected=id;
    return local;
  }
  function adoptedObject(s,id,type){
    const collection=type==='inference'?'edges':'nodes';
    return Object.values(s.mine?.[collection]||{}).find(x=>x.adoptedFrom===id||x.base?.id===id)||null;
  }
  function adoptionPlan(s,ids){
    const requested=[...new Set(Array.isArray(ids)?ids:[])],nodes=new Set(),edges=[];
    const result={requested,nodes:[],edges,required:[],existing:[],newIds:[],error:''};
    if(!requested.length){result.error='先选择要收录的主张或推导。';return result;}
    for(const id of requested){
      const n=s.author.nodes[id]||s.author.edges[id];
      if(!n){result.error='所选候选已不存在，请重新选择范围。';return result;}
      if(n.type==='claim')nodes.add(id);
      else{
        edges.push(id);
        for(const endpoint of [...n.premises,n.conclusion]){
          if(!s.author.nodes[endpoint]){result.error='这一步存在缺失前提或结论，暂不能按完整推导收录。';return result;}
          nodes.add(endpoint);
        }
      }
    }
    result.nodes=[...nodes];result.required=result.nodes.filter(id=>!requested.includes(id));
    for(const id of [...result.nodes,...edges]){
      const n=s.author.nodes[id]||s.author.edges[id];
      (adoptedObject(s,id,n.type)?result.existing:result.newIds).push(id);
    }
    // Reused personal endpoints may already point the other way. Validate the
    // complete proposed merge before either preview confirmation or mutation.
    const merged={edges:{...(s.mine?.edges||{})}},mapped=new Map();let serial=0;
    const taken=new Set([...Object.keys(s.mine?.nodes||{}),...Object.keys(s.mine?.edges||{})]);
    const fresh=()=>{let id;do{id='__adoption_preview_'+serial++;}while(taken.has(id));taken.add(id);return id;};
    for(const id of result.nodes)mapped.set(id,adoptedObject(s,id,'claim')?.id||fresh());
    for(const id of edges){
      if(adoptedObject(s,id,'inference'))continue;
      const candidate=s.author.edges[id],premises=candidate.premises.map(p=>mapped.get(p)),conclusion=mapped.get(candidate.conclusion);
      if(premises.some(p=>reachable(merged,conclusion,p))){result.error='收录“'+candidate.text+'”会与个人版已有推导形成回环。请调整选择或先处理个人推导；本次不会更改已有内容。';return result;}
      merged.edges[fresh()]={premises,conclusion};
    }
    return result;
  }
  function place(g,n,sizes={}){
    if(n.type==='inference')return; // D54: the relation label is attached to its connecting lines.
    const height=x=>sizes[x.id]?.height||(250+Math.ceil(x.text.length/14)*27),width=x=>sizes[x.id]?.width||320;
    const other=Object.values(g.nodes).filter(x=>x.id!==n.id);
    for(let attempt=0;attempt<40;attempt++){
      const hit=other.find(x=>n.x<x.x+width(x)+16&&n.x+width(n)+16>x.x&&n.y<x.y+height(x)+24&&n.y+height(n)+24>x.y);
      if(!hit)break;n.y=hit.y+height(hit)+35;
    }
  }
  function signature(g,n){return JSON.stringify([n.id,n.version,n.text,n.type==='inference'?n.premises.map(id=>[id,g.nodes[id].version,g.nodes[id].text]):null,n.type==='inference'?[n.conclusion,g.nodes[n.conclusion].version,g.nodes[n.conclusion].text,n.combination]:null]);}
  // D60 example: each inference retains its premise set and is displayed on its connections.
  // j1 needs two premises together; s2 and s3 each rest on a single premise.
  function sampleGraph(s){
    const g=emptyGraph(),quote=text=>{const m=s.sources.find(x=>x.id==='m1'),start=m.text.indexOf(text);return ref(s,'m1',start,start+text.length);};
    const lineRef=(lines,source,index)=>{const before=lines.slice(0,index).join('\n');const start=before?before.length+1:0;const text=lines[index]||'';return ref(s,source,start,start+text.length);};
    const authorRef=index=>lineRef(authorLines,'m1',index);
    const common=(id,type,text,origin,x,y,r)=>({id,type,text,origin,originKind:origin==='AI 推断'?'ai':'source',x,y,sourceRef:r,version:1,checked:'待核对',stance:'待研究',reason:'',notes:[],evidence:[],history:[],base:null});
    g.nodes.p1={...common('p1','claim','18A 按期进入量产','作者表达',60,40,authorRef(0)),role:'前提'};
    g.nodes.p2={...common('p2','claim','18A 良率接近可比水平','作者表达',60,330,authorRef(1)),role:'前提'};
    g.nodes.p3={...common('p3','claim','客户希望有第二家先进制程供应商','作者表达',60,620,authorRef(3)),role:'前提'};
    g.nodes.c1={...common('c1','claim','外部大客户会把订单交给 Intel Foundry','作者表达',930,150,authorRef(2)),role:'预测'};
    g.nodes.c2={...common('c2','claim','代工营收在 2027 年前显著放量','作者表达',1750,150,authorRef(4)),role:'结论'};
    g.nodes.q4={...common('q4','claim','外部客户已完成产能认证','AI 推断',930,470,null),role:'可能缺失的前提',proposedFor:'j1'};
    g.edges.j1={...common('j1','inference','有量产也有良率，才谈得上外部订单','作者表达',520,120,authorRef(2)),premises:['p1','p2'],conclusion:'c1',combination:'共同依赖',needsReview:false};
    g.edges.s2={...common('s2','inference','第二供应商动机单独就足以带来订单','作者表达',520,600,authorRef(3)),premises:['p3'],conclusion:'c1',combination:'单一前提',needsReview:false};
    g.edges.s3={...common('s3','inference','订单落地才谈得上营收放量，还要看资本开支压力是否连续两季恶化','作者表达',1130,150,authorRef(4)),premises:['c1'],conclusion:'c2',combination:'单一前提',needsReview:false};
    return g;
  }
  function sampleChecks(s){
    const m=s.sources.find(x=>x.id==='m2'),ps=parts(m),basis=(index,effect)=>({ref:ref(s,'m2',ps[index].start,ps[index].end),effect});
    return {
      p1:{status:'证据不足',signal:'当期反向信号',explanation:'模拟披露把 18A 描述为仍处于试产阶段，没有给出量产时间表。这条相反依据只针对“按期量产”这一前提，不自动否定整条论证。',basis:[basis(0,'相反信号：仅针对当前')],scope:'示例口径，未经原文核验；只覆盖当期披露'},
      p2:{status:'证据不足',explanation:'模拟披露未给出良率数据，无法核对“接近可比水平”。未知不填零，也不等同于未满足。',basis:[basis(0,'资料缺口')],scope:'缺少良率口径与可比对象'},
      p3:{status:'证据不足',explanation:'作者表达了客户的动机，但模拟材料没有外部客户的正式承诺。原文表达核对与条件是否满足是两件事。',basis:[basis(3,'限定')],scope:'外部客户承诺的正式口径尚未取得'},
      c1:{status:'暂无法核验',reason:'等待观察',explanation:'外部订单尚未形成正式承诺，属于预测；当期材料不能证明未来结果。',basis:[basis(3,'资料缺口')],scope:'订单承诺的确认时间尚未取得'},
      c2:{status:'暂无法核验',reason:'等待观察',explanation:'结论涉及 2027 年，且挂着资本开支连续两季的条件；观察窗口未结束，不能确认。',basis:[basis(1,'背景'),basis(2,'背景')],scope:'预测期间与条件观察窗口分别记录'},
      j1:{status:'证据不足',signal:'当期反向信号',explanation:'这一步要两项前提一起成立。当前量产有反向信号、良率缺数据，因此“两条一起推出外部订单”缺乏可直接核验的桥梁。',basis:[basis(0,'相反信号：仅针对当前'),basis(3,'限定')],scope:'这组前提缺一不可；少一条不等于结论被推翻，但这一步失去这组前提的支持'},
      s2:{status:'证据不足',signal:'当期反向信号',explanation:'管理层表示尚未形成正式订单承诺，削弱“动机单独就足以带来订单”这一步。这是针对这一步的反驳，不影响 p3 这句话本身。',basis:[basis(3,'相反信号：仅针对当前')],scope:'与 j1 分开评估；另一条路是否保留单独判断'},
      s3:{status:'证据不足',explanation:'资本开支占营收由约 37.3% 升至 46.0%（示例口径）。这是条件状态的计算结果，条件是否满足仍由本人确认；不是投资建议。',basis:[basis(1,'支持'),basis(2,'限定')],scope:'两期口径一致时才可比较',calculation:'46 ÷ 100 = 46.0%；38 ÷ 102 = 37.3%'},
      q4:{status:'证据不足',explanation:'这是 AI 补充的候选前提，尚未合入作者推导，没有可回查的原文；采用前保持待核对。',basis:[basis(3,'资料缺口')],scope:'AI 推断，不因收录改写归属'}
    };
  }
  // D97–D101: never infer a future report period from the project history range.
  function verificationContext(s,n){
    const v=n.verification;if(!v||v.signature!==signature(graph(s),n))return null;
    if(v.timeContext)return v.timeContext;
    const original=sampleGraph(s),known=original.nodes[n.id]||original.edges[n.id];
    if(!known||signature(original,known)!==signature(graph(s),n))return null;
    const period={p1:'原文指向 2026 年上半年',p2:'良率观察期间待明确',p3:'客户动机的适用期间待明确',c1:'订单落地的目标期间待明确',c2:'原文为“2027 年前”，具体期间与放量标准待明确'}[n.id]||'按这步前提和结论分别核对期间';
    return {period,asOf:'2026-10-01（模拟查证时点）',current:'核对当时已取得的披露与预测依据',future:['c1','c2'].includes(n.id)?'待观察':''};
  }
  function nodeCandidate(s,n){
    const v=n.verification;if(!v||v.signature!==signature(graph(s),n))return null;
    if(v.nodeCandidate)return clone(v.nodeCandidate);
    const original=sampleGraph(s),known=original.nodes[n.id]||original.edges[n.id];
    if(!known||signature(original,known)!==signature(graph(s),n))return null;
    if(n.id==='c1')return {event:'外部客户正式订单披露',goal:'核对是否形成与 Intel Foundry 的正式订单承诺',period:'',date:'',gap:'订单应落地的期间待明确；披露日期未知',origin:'AI 建议（模拟）'};
    if(n.id==='c2')return {event:'',goal:'核对代工营收放量及资本开支条件',period:'',date:'',gap:'“2027 年前”的具体期间、放量标准及对应报告待明确',origin:'AI 建议（模拟）'};
    return null;
  }
  function verificationLabel(s,n){
    const v=n.verification;if(!v)return '待查证';
    if(v.signature!==signature(graph(s),n))return '需重新查证';
    return v.cardStatus||(verificationContext(s,n)?.future?`依据待补充 · 结果待观察`:v.status||'待查证');
  }
  function reduce(old,a){
    const s=clone(old);s.error='';s.message='';let g=graph(s),n=item(s);
    const fail=text=>{s.error=text;return s;};
    switch(a.type){
      case 'card-size':{
        n=item(s,a.id);if(!n||n.type!=='claim')return fail('请选择一张卡片。');
        if(a.reset){remember(s);delete n.cardSize;log(s,'已恢复初始卡片尺寸。');break;}
        if(![a.width,a.height].every(Number.isFinite))return fail('卡片尺寸无效。');
        remember(s);n.cardSize={width:Math.max(220,a.width),height:Math.max(120,a.height)};log(s,'已调整卡片大小；正文按可用空间预览。');break;
      }
      case 'card-notebook':{
        if(!n||n.type!=='claim'||typeof a.text!=='string'||!a.text.trim()||typeof a.body!=='string')return fail('请填写卡片标题。');
        const textChanged=a.text.trim()!==n.text,bodyChanged=a.body!==(n.cardBody||'');
        if(textChanged){const error=editScopeError(s,n,a.scope);if(error)return fail(error);}
        remember(s);if(textChanged)n=localEditTarget(s,n,a.scope,a.at);
        if(textChanged||bodyChanged){revise(n,'写字板编辑',a.at);n.text=a.text.trim();n.cardBody=a.body;n.researchUse='research';if(textChanged){clearCurrentAssessment(n);affected(s,n.id).forEach(id=>g.edges[id].needsReview=true);}}
        n.cardTags=[...new Set(String(a.tags||'').split(/[,，\n]/).map(tag=>tag.trim()).filter(Boolean))];n.cardShowTags=a.showTags;n.cardShowBody=a.showBody;
        log(s,'已保存写字板；标题、正文与自定义 tag 分别显示。');break;
      }
      case 'reconstruct':{
        if(s.source!=='m1')return fail('当前原型只内置这一段观点的分析样本。你的文本已保留；真实模型接入后才能自动分析它，暂不套用示例答案。');
        if(Object.keys(s.author.nodes).length)return fail('当前已有作者候选链。请重新开始后分析示例，以免覆盖已有内容。');
        remember(s);s.author=sampleGraph(s);const mapped=addReferenceGraph(s);s.directCanvas=true;s.pipeline='reconstructed';s.mode='mine';s.selected=mapped.get('j1');s.draft=null;s.linkFrom=null;log(s,'观点已整理到研究画布（模拟），可以直接改写、补充和推理。尚未操作的来源与 AI 内容仍为参考候选；显示不表示个人采用或认可，整理原版保留供对照。');break;
      }
      case 'verify':{
        const objects=a.id?[g.nodes[a.id]||g.edges[a.id]].filter(Boolean):[...Object.values(g.nodes),...Object.values(g.edges)];if(!objects.length)return fail('先自动梳理观点，得到需要查证的主张与推导。');
        remember(s);const initial=sampleGraph(s),checks=sampleChecks(s);
        objects.forEach(x=>{const original=initial.nodes[x.id]||initial.edges[x.id];
          if(x.verification){x.verificationHistory=x.verificationHistory||[];x.verificationHistory.push(clone(x.verification));}
          x.verification={...(original&&signature(initial,original)===signature(g,x)?clone(checks[x.id]):{status:'暂无法核验',reason:'尚未接入真实查证',explanation:'这项内容已经由你修改或新建。本原型不把旧样本的查证结果套到新表述；需要针对当前版本重新检索与分析。',basis:[],scope:'仅当前版本'}),targetVersion:x.version,signature:signature(g,x),origin:'AI 查证候选（模拟）'};
        });s.pipeline=s.mode==='mine'?'editing':'verified';if(!a.id)s.selected=g.edges.j1?'j1':objects[0].id;s.draft=null;log(s,(a.id?'当前项的':'')+'模拟公开资料查证已返回：有支持依据，也有反向信号、资料缺口与等待观察项；个人立场未改变。');break;
      }
      case 'research-question':if(!a.text.trim())return fail('写下你想研究的问题。');remember(s);s.question=a.text.trim();log(s,'研究问题已改为“'+s.question+'”。');break;
      case 'source':s.source=a.id;s.anchor=null;break;
      case 'quote':{
        const r=ref(s,a.source,a.start,a.end);if(!r)return fail('请在材料内选取原句。');
        s.draft={ref:r,text:r.quote,role:'主张'};s.anchor=r;s.source=r.source;s.message='已摘取原句。你可以整理为主张，也可以关联到当前对象。';break;
      }
      case 'new':s.draft={ref:null,text:'',role:'主张'};s.linkFrom=null;break;
      case 'cancel-draft':s.draft=null;break;
      case 'add':{
        if(!a.text.trim())return fail('先写下你想研究的一句话。');
        const r=s.draft?.ref||null;
        if(!r||a.personal){if(!s.mine)s.mine=emptyGraph();s.mode='mine';g=s.mine;}
        remember(s);const id=nextObjectId(s,g),role=a.role||'主张';
        const count=Object.values(g.nodes).filter(x=>x.role===role).length;
        g.nodes[id]={id,type:'claim',text:a.text.trim(),role,origin:(!r||a.personal)?'本人补充':'作者表达',originKind:(!r||a.personal)?'user':'source',researchUse:'research',sourceRef:r,version:1,checked:'待核对',stance:'待研究',reason:'',notes:[],evidence:[],history:[],base:null,x:role==='结论'?660:60,y:80+count*215};
        place(g,g.nodes[id]);
        s.selected=id;s.draft=null;s.preview=null;log(s,'新增“'+a.text.trim()+'”。尚未表达立场。');break;
      }
      case 'canvas-create':{
        if(typeof a.text!=='string'||!a.text.trim()||!Number.isFinite(a.x)||!Number.isFinite(a.y))return fail('先写一句主张，并选择有效的画布位置。');
        if(s.mode==='author'&&Object.keys(s.author.nodes).length)return fail('请回到研究画布添加自己的主张；整理原版保留。');
        remember(s);if(!s.mine)s.mine=emptyGraph();s.mode='mine';g=s.mine;
        const id=nextObjectId(s,g);
        g.nodes[id]={id,type:'claim',text:a.text.trim(),role:'主张',origin:'本人补充',originKind:'user',researchUse:'research',sourceRef:null,version:1,checked:'待核对',stance:'待研究',reason:'',notes:[],evidence:[],history:[],base:null,x:a.x,y:a.y};
        s.selected=id;s.draft=null;s.linkFrom=null;log(s,'主张已放到画布；自由文字和绘图保留，来源与判断可继续补充。');break;
      }
      case 'canvas-duplicate':{
        const original=g.nodes[a.id];
        if(s.mode!=='mine'||!original||original.type!=='claim')return fail('请在研究画布选择一张研究卡复制。');
        remember(s);const id=nextObjectId(s,g),copy=clone(original);
        Object.assign(copy,{id,version:1,stance:'待研究',checked:'待核对',reason:'',notes:[],history:[],stanceHistory:[],evidence:[],researchUse:'research',x:original.x+380,y:original.y+40,copiedFrom:{id:original.id,version:original.version,text:original.text,at:a.at||null}});
        delete copy.verification;delete copy.verificationNode;delete copy.correctionHistory;delete copy.relatedTo;
        // Preserve source and material references, never the original's judgment or connections.
        copy.materials=[...(copy.materials||[]),...(original.evidence||[]).filter(e=>e.ref).map(e=>({source:e.ref.source,version:e.ref.version}))].filter((r,i,all)=>all.findIndex(x=>x.source===r.source&&x.version===r.version)===i);
        g.nodes[id]=copy;s.selected=id;s.linkFrom=null;s.preview=null;
        log(s,'已复制为独立研究卡：来源和材料保留，默认待研究，连线及个人判断没有复制。');break;
      }
      case 'ai-add-candidate':{
        if(s.mode!=='mine'||!s.mine)return fail('请回到研究画布，再明确把 AI 候选加入本次研究。');
        if(typeof a.text!=='string'||!a.text.trim())return fail('候选内容为空，请先生成本地演示回答。');
        const targets=Array.isArray(a.context)?a.context:[];
        if(!targets.length||targets.some(ref=>{const target=g.nodes[ref.id]||g.edges[ref.id];return !target||ref.signature!==signature(g,target);}))return fail('讨论范围中的内容已改变，请按当前内容重新生成候选。');
        remember(s);const id=nextObjectId(s,g,'ai'),first=g.nodes[targets[0].id]||g.edges[targets[0].id];
        g.nodes[id]={id,type:'claim',text:a.text.trim(),role:'AI 候选',origin:'AI 推断',originKind:'ai',researchUse:'research',sourceRef:null,version:1,checked:'待核对',stance:'待研究',reason:'',notes:[],evidence:[],history:[],base:null,x:first.x+380,y:first.y+100,relatedTo:targets.map(ref=>ref.id),aiContext:{kind:'local-demo',label:'本地演示，未请求模型',question:String(a.question||''),intent:String(a.intent||''),objects:clone(targets),at:a.at||null}};
        place(g,g.nodes[id]);s.selected=id;s.draft=null;s.linkFrom=null;s.preview=null;
        log(s,'已添加一张 AI 候选卡，默认待研究；保留讨论范围，尚未建立推导连线。');break;
      }
      case 'canvas-delete':{
        const selected=[...new Set(Array.isArray(a.ids)?a.ids:[a.id])];
        if(s.mode!=='mine'||!selected.length||selected.some(id=>!g.nodes[id]&&!g.edges[id]))return fail('请在研究画布选中当前对象再删除；整理原版保留。');
        const cards=new Set(selected.filter(id=>g.nodes[id])),edges=new Set(selected.filter(id=>g.edges[id]));
        for(const edge of Object.values(g.edges))if(cards.has(edge.conclusion)||edge.premises.some(id=>cards.has(id)))edges.add(edge.id);
        remember(s);edges.forEach(id=>delete g.edges[id]);cards.forEach(id=>delete g.nodes[id]);s.selected=null;s.linkFrom=null;s.preview=null;
        log(s,'已删除 '+cards.size+' 张研究卡、'+edges.size+' 步推导（含全部连线）；材料与整理原版保留，可撤销。');break;
      }
      case 'select':
        if(s.linkFrom&&g.nodes[a.id]&&a.id!==s.linkFrom){s.selected=a.id;s.draft=null;return s;}
        s.selected=a.id;s.draft=null;break;
      case 'mode':s.mode=a.mode;s.selected=null;s.draft=null;s.linkFrom=null;s.preview=null;break;
      case 'adopt':
      case 'adopt-selected':{
        const plan=adoptionPlan(s,a.type==='adopt-selected'?a.ids:[...Object.keys(s.author.nodes),...Object.keys(s.author.edges)]);
        if(plan.error)return fail(plan.error);
        if(!plan.newIds.length)return fail('这个范围已经收录；已有个人改写与判断保留。');
        remember(s);if(!s.mine)s.mine=emptyGraph();if(!s.baseline)s.baseline=emptyGraph();
        const mapped=new Map();
        const copy=(id,type)=>{
          const collection=type==='claim'?'nodes':'edges',x=s.author[collection][id],existing=adoptedObject(s,id,type);
          if(existing){mapped.set(id,existing.id);return;}
          let target=id;if(s.mine.nodes[target]||s.mine.edges[target])target=nextObjectId(s,s.mine,'adopt');
          mapped.set(id,target);
          const baseline=clone(x);baseline.id=target;baseline.adoptedFrom=id;
          if(type==='inference'){baseline.premises=x.premises.map(p=>mapped.get(p));baseline.conclusion=mapped.get(x.conclusion);if(baseline.ports)baseline.ports.premises=Object.fromEntries(Object.entries(baseline.ports.premises).map(([id,side])=>[mapped.get(id),side]));}
          if(!s.baseline[collection][target])s.baseline[collection][target]=clone(baseline);
          const y=clone(baseline);y.base=clone(x);delete y.base.history;y.stance='待研究';y.reason='';y.researchUse=s.directCanvas?'reference':'research';
          place(s.mine,y);s.mine[collection][target]=y;
          if(type==='inference'&&y.verification&&y.verification.signature!==signature(s.mine,y))y.needsReview=true;
        };
        plan.nodes.forEach(id=>copy(id,'claim'));plan.edges.forEach(id=>copy(id,'inference'));
        s.mode='mine';s.pipeline='editing';s.selected=mapped.get(plan.requested[0])||mapped.get(plan.nodes[0]);s.draft=null;s.linkFrom=null;s.preview=null;
        log(s,'已按预览范围收录 '+plan.nodes.length+' 项主张与 '+plan.edges.length+' 步推导，其中新增 '+plan.newIds.length+' 项；已有个人修改保留，新收录内容待研究，AI 归属保留。');break;
      }
      case 'start-link':if(!n||n.type!=='claim')return fail('先选择一项主张。');s.linkFrom=n.id;s.draft=null;s.preview=null;s.message='现在点它要推向的结论。连线的含义由你填写。';break;
      case 'cancel-link':s.linkFrom=null;s.message='已取消连线，现有推导保持原样。';break;
      case 'connect-direct':{
        const error=connectionCheck(s,a);if(error)return fail(error);
        remember(s);const from=g.nodes[a.from],to=g.nodes[a.to],id=nextObjectId(s,g,'r');
        g.edges[id]={id,type:'inference',text:String(a.text||'').trim(),premises:[from.id],conclusion:to.id,combination:'单一前提',origin:'本人推导',originKind:'user',researchUse:'research',sourceRef:null,version:1,checked:'待核对',stance:'待研究',reason:'',notes:[],evidence:[],history:[],base:null,needsReview:false,x:(from.x+to.x)/2,y:(from.y+to.y)/2};
        if(a.fromSide||a.toSide)g.edges[id].ports={premises:{[from.id]:a.fromSide||'right'},conclusion:a.toSide||'left'};
        from.researchUse='research';to.researchUse='research';s.selected=id;s.linkFrom=null;s.draft=null;s.preview=null;
        log(s,'已连接前提 → 结论；说明选填，新推导待研究，可撤销。');break;
      }
      case 'reconnect':{
        const error=connectionCheck(s,a);if(error)return fail(error);const edge=g.edges[a.id];
        const same=a.target===(a.end==='conclusion'?edge.conclusion:a.previous),oldSide=a.end==='conclusion'?(edge.ports?.conclusion||'left'):(edge.ports?.premises?.[a.previous]||'right');
        if(same){
          if(!a.side||a.side===oldSide)break;
          remember(s);edge.ports=clone(edge.ports||{premises:{},conclusion:'left'});
          if(a.end==='conclusion')edge.ports.conclusion=a.side;else edge.ports.premises[a.previous]=a.side;
          s.selected=edge.id;log(s,'已调整连接边；推导内容、查证和立场保持，可撤销。');break;
        }
        remember(s);revise(edge,'重连'+(a.end==='conclusion'?'结论':'前提'),a.at);
        if(a.side||edge.ports){
          edge.ports=clone(edge.ports||{premises:{},conclusion:'left'});
          if(a.end==='conclusion')edge.ports.conclusion=a.side||oldSide;
          else{delete edge.ports.premises[a.previous];edge.ports.premises[a.target]=a.side||oldSide;}
        }
        if(a.end==='conclusion')edge.conclusion=a.target;else edge.premises=edge.premises.map(id=>id===a.previous?a.target:id);
        edge.researchUse='research';g.nodes[a.target].researchUse='research';
        // Evidence stays tied to the version it was judged against.
        edge.stance='待研究';edge.reason='';edge.checked='待核对';edge.needsReview=true;
        s.selected=edge.id;s.preview=null;s.linkFrom=null;
        log(s,'已重连这一步；其他连接和卡片立场保留，原说明及旧版依据需重新检查。');break;
      }
      case 'verification-node':{
        const target=g.nodes[a.id]||g.edges[a.id];
        if(s.mode!=='mine'||!target)return fail('当前研究对象已不存在。');
        if(a.signature!==signature(g,target))return fail('内容或前提已变化，请重新核对验证节点；草稿仍保留。');
        const clean=key=>String(a.node?.[key]||'').trim(),node={event:clean('event'),goal:clean('goal'),period:clean('period'),date:clean('date')};
        if(!node.event||!node.goal)return fail('请明确要等待的事件和核对内容；期间或披露日期未知时可以留空。');
        if(Object.values(node).some(value=>value.length>500))return fail('节点信息过长，请精简后保存。');
        if(target.verificationNode?.targetSignature===a.signature&&Object.keys(node).every(k=>target.verificationNode[k]===node[k]))break;
        remember(s);target.verificationNode={...node,by:'user',at:a.at||null,targetVersion:target.version,targetSignature:a.signature};
        target.researchUse='research';log(s,'验证节点已确认；预测结果与个人立场保持原状态。');break;
      }
      case 'material-add':{
        const target=g.nodes[a.id]||g.edges[a.id],m=a.material;
        if(s.mode!=='mine'||!target||!m||!['text','image','pdf'].includes(m.kind))return fail('材料或作用对象已失效。');
        if(typeof m.title!=='string'||!m.title.trim()||typeof m.text!=='string'||m.kind==='text'&&!m.text.trim())return fail('材料内容不完整。');
        if(m.kind!=='text'&&(!/^data:(image\/(png|jpeg|webp|gif)|application\/pdf);base64,[A-Za-z0-9+/=]+$/.test(m.data||'')||m.kind==='pdf'&&!m.data.startsWith('data:application/pdf;')||m.kind==='image'&&!m.data.startsWith('data:image/')))return fail('文件格式无效。');
        if(m.kind==='image'&&(!Number.isFinite(m.width)||!Number.isFinite(m.height)||m.width<=0||m.height<=0))return fail('图像尺寸无效。');
        if(m.kind==='pdf'&&(!Number.isInteger(m.pages)||m.pages<1))return fail('PDF 尚未成功读取，材料没有保存。');
        const existing=m.canvasFileId&&s.sources.find(x=>x.canvasFileId===m.canvasFileId&&x.data===m.data);
        if(existing&&!a.replaces){
          if(target.materials?.some(r=>r.source===existing.id&&r.version===existing.version)&&!target.materialExclusions?.some(r=>r.source===existing.id&&r.version===existing.version))break;
          remember(s);target.materials??=[];if(!target.materials.some(r=>r.source===existing.id&&r.version===existing.version))target.materials.push({source:existing.id,version:existing.version});target.materialExclusions=(target.materialExclusions||[]).filter(r=>r.source!==existing.id||r.version!==existing.version);target.researchUse='research';break;
        }
        let id,version=1;const prior=a.replaces?s.sources.filter(x=>x.id===a.replaces).sort((a,b)=>b.version-a.version)[0]:null;
        if(a.replaces&&!prior)return fail('旧材料已不存在，无法添加新版本。');
        remember(s);if(prior){id=prior.id;version=prior.version+1;}else do{id='m'+s.next++;}while(s.sources.some(x=>x.id===id));
        s.sources.push({...clone(m),id,version,author:m.author||prior?.author||'来源未填写',published:m.published||'发布时间未知',period:m.period||prior?.period||'业务期间未知',acquired:a.at||null,coverage:'full'});
        target.materials??=[];target.materials.push({source:id,version});target.materialExclusions=(target.materialExclusions||[]).filter(r=>r.source!==id);target.researchUse='research';
        log(s,'材料已加入本对象，来源与版本保留；立场没有改变。');break;
      }
      case 'material-attach':{
        const target=g.nodes[a.id]||g.edges[a.id],m=s.sources.find(m=>m.id===a.source&&m.version===a.version);
        if(s.mode!=='mine'||!target||!m)return fail('材料或作用对象已不存在。');
        if(target.materials?.some(r=>r.source===m.id&&r.version===m.version)&&!target.materialExclusions?.some(r=>r.source===m.id&&r.version===m.version))break;
        remember(s);target.materials??=[];if(!target.materials.some(r=>r.source===m.id&&r.version===m.version))target.materials.push({source:m.id,version:m.version});target.materialExclusions=(target.materialExclusions||[]).filter(r=>r.source!==m.id||r.version!==m.version);target.researchUse='research';log(s,'已有项目材料已加入本对象。');break;
      }
      case 'material-remove':{
        const target=g.nodes[a.id]||g.edges[a.id];if(!target)return fail('作用对象已不存在。');
        const versions=s.sources.filter(m=>m.id===a.source);if(s.mode!=='mine'||!versions.length)return fail('材料或作用对象无效。');
        if(versions.every(m=>target.materialExclusions?.some(r=>r.source===m.id&&r.version===m.version)))break;
        remember(s);target.materials=(target.materials||[]).filter(r=>r.source!==a.source);target.materialExclusions=(target.materialExclusions||[]).filter(r=>r.source!==a.source);target.materialExclusions.push(...versions.map(m=>({source:m.id,version:m.version})));
        log(s,'已从本对象列表移除，原文件和已记录引用保留，可撤销。');break;
      }
      case 'material-meta':{
        const m=s.sources.find(m=>m.id===a.source&&m.version===a.version);if(!m)return fail('材料版本已不存在。');
        const author=String(a.author||'').trim()||'来源未知',period=String(a.period||'').trim()||'业务期间未知';
        if(m.author===author&&m.period===period)break;remember(s);m.author=author;m.period=period;log(s,'来源信息已保存；发布时间与获取时间分别保留。');break;
      }
      case 'material-evidence-remove':{
        const target=g.nodes[a.id]||g.edges[a.id];if(s.mode!=='mine'||!target)return fail('请在研究画布操作。');
        const index=target.evidence.findIndex(e=>e.id===a.evidence);if(index<0)break;
        remember(s);target.evidence.splice(index,1);log(s,'已解除此项引用，材料与立场保留。');break;
      }
      case 'material-evidence':{
        const target=g.nodes[a.id]||g.edges[a.id],r=a.ref;
        if(s.mode!=='mine'||!target||!materialRefValid(s,r)||!['支持','反驳','限定','背景','尚待判断'].includes(a.effect))return fail('引用位置或作用无效，原记录保留。');
        const same=target.evidence.find(e=>JSON.stringify(e.ref)===JSON.stringify(r)&&e.targetVersion===target.version);
        if(same&&same.effect===a.effect&&same.reason===String(a.reason||''))break;
        remember(s);const evidence={id:same?.id||'ev'+s.next++,ref:clone(r),effect:a.effect,reason:String(a.reason||''),targetVersion:target.version,targetSignature:signature(g,target)};
        if(same)Object.assign(same,evidence);else target.evidence.push(evidence);
        target.researchUse='research';log(s,'引用已记录，立场未改变。');break;
      }
      case 'connect':{
        const from=g.nodes[s.linkFrom],to=g.nodes[s.selected];if(!from||!to||from.id===to.id)return fail('请选择另一个主张作为结论。');
        const error=linkError(g,from.id,to.id);if(error)return fail(error);
        if(s.mode==='author'&&!a.ref)return fail('请回到研究画布建立自己的推导；整理原版保留。');
        remember(s);const id='r'+s.next++;
        if(to.x<from.x+670){to.x=from.x+670;place(g,to);}
        g.edges[id]={id,type:'inference',text:a.text.trim()||'由这项前提推向这个结论',premises:[from.id],conclusion:to.id,combination:'单一前提',origin:s.mode==='author'?'作者表达':'本人推导',originKind:s.mode==='author'?'source':'user',researchUse:'research',sourceRef:a.ref||null,version:1,checked:'待核对',stance:'待研究',reason:'',notes:[],evidence:[],history:[],base:null,needsReview:false,x:from.x+290,y:(from.y+to.y)/2+20};
        from.researchUse='research';to.researchUse='research';
        place(g,g.edges[id]);
        s.selected=id;s.linkFrom=null;log(s,'你建立了这一步推导；前提和推导的立场分别保留。');break;
      }
      case 'drop-connect':{
        const check=dropCheck(s,a.child,a.parent);if(!check.allowed)return fail(check.message);
        remember(s);const from=g.nodes[a.parent],to=g.nodes[a.child],id='r'+s.next++;
        // A drop adds a new personal inference; it never reparents or merges existing steps.
        const spacing=(a.sizes?.[from.id]?.width||320)+350;
        if(to.x<from.x+spacing){to.x=from.x+spacing;place(g,to,a.sizes);}
        g.edges[id]={id,type:'inference',text:'',premises:[from.id],conclusion:to.id,combination:'单一前提',origin:'本人推导',originKind:'user',researchUse:'research',sourceRef:null,version:1,checked:'待核对',stance:'待研究',reason:'',notes:[],evidence:[],history:[],base:null,needsReview:false,compact:true,x:from.x+300,y:(from.y+to.y)/2+30};
        from.researchUse='research';to.researchUse='research';
        place(g,g.edges[id],a.sizes);s.selected=to.id;s.linkFrom=null;s.draft=null;s.preview=null;
        log(s,'已建立“'+from.text+' → '+to.text+'”。原有连接保留；新推导待研究，点击连接标签可补充说明。');break;
      }
      case 'premise':{
        if(s.mode!=='mine'||!n||n.type!=='inference')return fail('请在个人论证中选择一步推导。');
        if(!g.nodes[a.id]||n.premises.includes(a.id)||a.id===n.conclusion)return fail('请选择另一项主张。');
        if(reachable(g,n.conclusion,a.id))return fail('这项前提会形成回环，请先拆分时间范围。');
        remember(s);revise(n,'补充前提：'+g.nodes[a.id].text,a.at);n.researchUse='research';g.nodes[a.id].researchUse='research';n.premises.push(a.id);n.combination='未说明';n.stance='待研究';n.reason='';n.checked='待核对';n.needsReview=true;n.evidence=n.evidence.map(e=>({...e,previousEffect:e.effect,previousReason:e.reason,effect:'尚待判断',reason:'',targetVersion:n.version}));s.preview=null;log(s,'已补充前提；组合方式尚未说明，推导新版本待研究。');break;
      }
      case 'combination':{
        if(s.mode!=='mine'||!n||n.type!=='inference')return fail('请先选择个人推导。');
        if(n.combination===a.value)break;
        remember(s);revise(n,'前提组合改为：'+a.value,a.at);n.researchUse='research';n.combination=a.value;n.stance='待研究';n.reason='';n.checked='待核对';n.needsReview=true;n.evidence=n.evidence.map(e=>({...e,previousEffect:e.effect==='尚待判断'?e.previousEffect:e.effect,previousReason:e.reason||e.previousReason,effect:'尚待判断',reason:'',targetVersion:n.version}));s.preview=null;log(s,'你把前提组合设为“'+a.value+'”；不自动确认推导成立。');break;
      }
      case 'edit':{
        if(s.mode!=='mine'||!n)return fail('请回到研究画布直接改写；整理原版和材料原句保留供对照。');
        if(n.type==='claim'&&!a.text.trim())return fail('填写新的表述后保存。');
        if(a.text.trim()===n.text.trim())return fail('表述尚未改变；可以直接记录立场或待查问题。');
        const scopeError=editScopeError(s,n,a.scope);if(scopeError)return fail(scopeError);
        remember(s);n=localEditTarget(s,n,a.scope,a.at);const before=n.text,changeReason=(a.reason||'').trim();revise(n,changeReason,a.at);n.text=a.text.trim();n.researchUse='research';clearCurrentAssessment(n);
        const impacted=affected(s,n.id);impacted.forEach(id=>g.edges[id].needsReview=true);s.preview=null;
        let spaced=false;
        if(n.type==='claim'){
          const sizes=a.sizes||{},height=x=>sizes[x.id]?.height||(250+Math.ceil(x.text.length/14)*27),width=x=>sizes[x.id]?.width||320;
          const oldHeight=Number.isFinite(a.previousHeight)?a.previousHeight:250+Math.ceil(before.length/14)*27;
          if(height(n)>oldHeight){
            // Only make room below a growing claim; user positions and annotations remain freely editable.
            Object.values(g.nodes).filter(x=>x.id!==n.id&&x.y>=n.y+oldHeight&&x.y<n.y+height(n)+24&&x.x<n.x+width(n)+16&&x.x+width(x)+16>n.x).sort((a,b)=>a.y-b.y).forEach(x=>{place(g,x,sizes);spaced=true;});
          }
        }
        log(s,'你将“'+before+'”改为“'+n.text+'”；'+(a.scope&&a.scope!=='all'?'仅用于选定推导，其他引用保留原前提。':a.scope==='all'?'已明确更新这个前提的全部引用。':'')+(impacted.length?impacted.length+' 步相关推导待检查。':'新版本待研究。')+(spaced?' 已为增高的卡片留出下方空间，可继续自由拖动。':''));break;
      }
      case 'correct-reconstruction':{
        if(s.mode!=='mine'||!canCorrect(n))return fail('只能校正尚未有个人正文或结构改写的来源整理；已有个人内容请使用改写。');
        if(!resolveRef(s,n.sourceRef))return fail('当前来源锚点无法复核，先找到对应版本原文再校正。');
        if(typeof a.text!=='string'||!a.text.trim())return fail('请填写对照原文后的整理表述。');
        if(a.text.trim()===n.text.trim())return fail('整理表述尚未改变；只确认对应关系时可使用核对。');
        const scopeError=editScopeError(s,n,a.scope);if(scopeError)return fail(scopeError);
        remember(s);n=localEditTarget(s,n,a.scope,a.at,'correction');
        const previous=clone(n);delete previous.history;n.history.push(previous);
        const before=n.text,fromVersion=n.version;n.version+=1;n.text=a.text.trim();
        n.correctionHistory??=[];n.correctionHistory.push({kind:'reconstruction-correction',by:'user',at:a.at||null,reason:(a.reason||'').trim(),before,after:n.text,fromVersion,toVersion:n.version,sourceRef:clone(n.sourceRef)});
        clearCurrentAssessment(n);affected(s,n.id).forEach(id=>g.edges[id].needsReview=true);s.preview=null;
        log(s,'已保存来源整理校正，原材料与初始整理保留；这次校正独立记录，不作为个人改写。新版本待研究、待核对，旧查证仍只对应旧版本。');break;
      }
      case 'stance':{
        if(s.mode!=='mine'||!n)return fail('请在个人论证中表达你的立场。');
        if(!['待研究','认可','质疑','不认可'].includes(a.value))return fail('请选择有效的个人立场。');
        const reason=a.value==='待研究'?'':String(a.reason||'').trim();
        if(['质疑','不认可'].includes(a.value)&&!reason)return fail('请写出具体理由；当前立场尚未改变。');
        const changed=n.stance!==a.value||(n.reason||'').trim()!==reason;
        if(!changed&&researchUse(n)==='research')break;
        remember(s);n.researchUse='research';
        if(changed){
          n.stanceHistory??=[];
          n.stanceHistory.push({by:'user',at:a.at||null,target:clone(stanceTarget(s,n)),before:{value:n.stance,reason:n.reason||''},after:{value:a.value,reason}});
        }
        n.stance=a.value;n.reason=reason;log(s,'你对这'+(n.type==='claim'?'项主张':'步推导')+'的立场是“'+a.value+'”'+(n.reason?'，理由已保存。':'。'));break;
      }
      case 'evidence':{
        const r=s.draft?.ref;if(s.mode!=='mine'||!n||!r)return fail('先选择个人论证中的对象，再从材料摘取要关联的原句。');
        remember(s);n.researchUse='research';n.evidence.push({id:'ev'+s.next++,ref:r,effect:a.effect,reason:a.reason.trim(),targetVersion:n.version});s.draft=null;
        log(s,'你把这句材料关联为“'+a.effect+'”；目标立场没有自动改变。');break;
      }
      case 'question':{
        if(s.mode!=='mine'||!n)return fail('先选择个人主张或推导。');if(!a.text.trim())return fail('写下你还需要查证的问题。');
        remember(s);n.researchUse='research';n.notes.push({text:a.text.trim(),version:n.version,status:'待查问题'});log(s,'这'+(n.type==='claim'?'项主张':'步推导')+'留了一个待查问题，仍可继续整理。');break;
      }
      case 'checked':if(n&&isEdited(n))return fail('当前内容已经编辑；原句仅对应内容起点，不能将当前版本标为作者原文。');if(!n||originKind(n)!=='source')return fail(n?.origin==='AI 推断'?'这项内容为 AI 补充，原文未明确表达；采用后仍保留 AI 归属。':'这项内容为本人补充，请对照来源并记录你的判断。');remember(s);n.checked='已核对';log(s,'你确认重建与原文对应；个人立场没有改变。');break;
      case 'preview':if(s.mode!=='mine'||!n||n.type!=='claim')return fail('选择个人前提后，才能查看假设影响。');s.preview=n.id;s.draft=null;s.message='临时假设这项前提不成立：仅检查已有推导结构，不改内容或立场。';break;
      case 'exit-preview':s.preview=null;break;
      case 'move':if(!n&& !a.id)break;remember(s);{const obj=g.nodes[a.id]||g.edges[a.id];if(obj){obj.x=Math.max(10,a.x);obj.y=Math.max(15,Math.min(1380,a.y));if(obj.type==='inference')obj.manualPosition=true;}}break;
      case 'layout-batch':{
        const positions=(a.positions||[]).filter(p=>g.nodes[p.id]||g.edges[p.id]);
        if(positions.some(p=>!Number.isFinite(p.x)||!Number.isFinite(p.y)))return fail('位置数据无效，研究内容保留。');
        const changed=positions.filter(p=>{const x=g.nodes[p.id]||g.edges[p.id];return Math.abs(x.x-p.x)>.1||Math.abs(x.y-p.y)>.1;});
        if(changed.length){remember(s);changed.forEach(p=>{const x=g.nodes[p.id]||g.edges[p.id];x.x=p.x;x.y=p.y;if(x.type==='inference')x.manualPosition=true;});}
        break;
      }
      case 'anchor':if(!resolveRef(s,a.ref))return fail('原文暂无法复核：未找到对应材料版本或引用位置；保留原引用，不用当前内容替代。');s.source=a.ref.source;s.anchor=clone(a.ref);s.draft=null;s.message='已在材料浮窗定位到本次引用的版本与原句；关闭后继续当前研究。';break;
      case 'add-source':{
        if(!a.text.trim())return fail('先贴入你要研究的文本。');if(a.originalUrl?.trim()&&!webUrl(a.originalUrl))return fail('原始网页地址请填写不含账户密码的 http 或 https 链接。');remember(s);let id;do{id='m'+s.next++;}while(s.sources.some(m=>m.id===id));
        s.sources.push({id,title:a.title.trim()||'用户提供材料',author:a.author.trim()||'作者未填写',version:1,published:'发布时间未填写',period:'业务期间未填写',coverage:['full','excerpt','unknown'].includes(a.coverage)?a.coverage:'excerpt',originalUrl:webUrl(a.originalUrl),acquired:a.at||null,text:a.text.trim()});s.source=id;s.anchor=null;s.draft=null;log(s,'文本已加入本次研究。图和判断由你继续整理。');break;
      }
      case 'undo':{
        const previous=s.undo.pop();if(!previous)return fail('还没有可撤销的研究修改。');const remaining=s.undo,sources=s.sources;
        Object.assign(s,previous);s.undo=remaining;s.sources=sources;s.preview=null;s.draft=null;s.linkFrom=null;s.message='已撤销上一次研究修改；已加入的材料仍保留。';break;
      }
    }
    return s;
  }
  function impact(s,e){if(!s.preview)return null;if(e.premises.includes(s.preview))return e.combination==='未说明'?'前提组合未说明，影响未定':'假设中失去这项支持';if(e.premises.some(id=>reachable(graph(s),s.preview,id)))return '下游可能受影响';return '这一步不引用该前提';}
  return {seed,reduce,graph,item,ref,parts,impact,clone,signature,dropCheck,originKind,originLabel,isEdited,editLabel,resolveRef,webUrl,adoptionPlan,upgradeStudy,researchUse,sharedPremises,canCorrect,connectionCheck,materialRefValid,verificationContext,nodeCandidate,verificationLabel};
})();
