import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SecClient, secUrl, companyFacts, compareFacts } from '../src/index.js';
import { sha } from '../src/sec.js';

// Entirely synthetic facts; no user financial data or vendor content in fixtures.
const row=(val,filed='2025-04-01',accn='0000000001-25-000001')=>({start:'2025-01-01',end:'2025-03-31',val,accn,filed,form:'10-Q',fp:'Q1',fy:2025});
const raw=JSON.stringify({cik:1,entityName:'Synthetic Issuer',facts:{'us-gaap':{SyntheticMetric:{label:'Synthetic metric',units:{USD:[row(12),row(15,'2025-06-01','0000000001-25-000002')]}}}}});
const snapshot={sourceId:'sec-edgar',dataset:'companyfacts',cik:'0000000001',raw,hash:sha(raw),retrievedAt:'2026-01-01T00:00:00Z',url:secUrl('1'),adapterVersion:'sec-json@0.1.0'};
const query={taxonomy:'us-gaap',tag:'SyntheticMetric',unit:'USD'};

test('历史截止日期排除后来披露，不以新重述覆盖旧 accession，不猜单季口径',()=>{
  const older=companyFacts(snapshot,{...query,knownByDate:'2025-05-01'});
  assert.equal(older.facts.length,1);assert.equal(older.facts[0].value,12);
  const all=companyFacts(snapshot,query);assert.equal(all.facts.length,2);
  assert.equal(all.facts[0].periodKind,'duration_unclassified');assert.equal(all.facts[0].publishedAt,null);
  assert.equal(compareFacts(all.facts[0],all.facts[1]).status,'not_comparable');
  assert.equal(companyFacts(snapshot,{...query,unit:'EUR'}).status,'missing');
});
test('原始数字词元保持精度；过大整数不进入数值计算，引用指向对应快照位置',()=>{
  const changed=raw.replace('"val":12','"val":9007199254740993');
  const facts=companyFacts({...snapshot,raw:changed,hash:sha(changed)},query).facts;
  assert.equal(facts[0].value,null);assert.equal(facts[0].rawValue,'9007199254740993');
  assert.equal(facts[0].anchor.pointer,'/facts/us-gaap/SyntheticMetric/units/USD/0/val');
  assert.throws(()=>companyFacts({...snapshot,hash:'bad'},query),/指纹/);
});
test('明确缺失、无效期间、历史未知和冲突披露，不补造零或发布时间',()=>{
  const value=JSON.parse(raw);value.facts['us-gaap'].SyntheticMetric.units.USD=[row(null),{...row(3),end:'2025-99-99'}];
  const text=JSON.stringify(value);const result=companyFacts({...snapshot,raw:text,hash:sha(text)},query);
  assert.equal(result.facts[0].value,null);assert.equal(result.facts.length,1);assert.equal(result.gaps.length,1);
  const base={...companyFacts(snapshot,query).facts[0],periodKind:'single'};
  assert.equal(compareFacts(base,{...base,value:13,disclosureVersion:'new'}).status,'conflicting_disclosures');
});
test('固定来源、真实联系配置、不可变本地快照及显式缓存复用',async()=>{
  assert.throws(()=>secUrl('../private'),/CIK/);assert.throws(()=>new SecClient({userAgent:'',cacheDirectory:'/unused'}),/联系/);
  const dir=await mkdtemp(join(tmpdir(),'public-data-'));let calls=0;
  try {
    const client=new SecClient({userAgent:'Synthetic Tests test@example.invalid',cacheDirectory:dir,request:async(url,options)=>{
      calls++;assert.equal(url,secUrl('1'));assert.equal(options.redirect,'error');return new Response(raw,{headers:{'Content-Type':'application/json'}});
    }});
    const first=await client.fetch('1');const cached=await client.fetch('1','companyfacts',{cachedHash:first.hash});
    assert.equal(calls,1);assert.equal(cached.raw,raw);assert.equal(cached.retrievedAt,first.retrievedAt);
    assert.equal(JSON.parse(await readFile(first.path,'utf8')).raw,raw);
    const again=await client.fetch('1');assert.equal(again.path,first.path);assert.equal(calls,2);
  } finally {await rm(dir,{recursive:true,force:true});}
});
test('403 不重试，不保存失败正文；重定向或跨主体结果停止',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'public-data-'));let calls=0;
  try {
    const client=new SecClient({userAgent:'Synthetic Tests test@example.invalid',cacheDirectory:dir,request:async()=>{calls++;return new Response('denied',{status:403});}});
    await assert.rejects(client.fetch('1'),e=>e.code==='ACCESS_DENIED');assert.equal(calls,1);
    const other=new SecClient({userAgent:'Synthetic Tests test@example.invalid',cacheDirectory:dir,request:async()=>new Response(raw)});
    await assert.rejects(other.fetch('2'),e=>e.code==='SUBJECT_MISMATCH');
  } finally {await rm(dir,{recursive:true,force:true});}
});
