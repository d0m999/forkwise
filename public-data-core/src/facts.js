import { SourceError, sha } from './sec.js';
const day = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0,10) === value;
const pointer = value => String(value).replaceAll('~','~0').replaceAll('/','~1');
export function companyFacts(snapshot, { taxonomy, tag, unit, knownByDate } = {}) {
  if (snapshot.dataset !== 'companyfacts' || sha(snapshot.raw) !== snapshot.hash) throw new SourceError('INVALID_SNAPSHOT','需要经过指纹校验的 companyfacts 快照');
  if (!taxonomy || !tag || !unit) throw new SourceError('QUERY_REQUIRED','必须明确 taxonomy、tag 和单位，不猜测同义指标');
  if (knownByDate && !day(knownByDate)) throw new SourceError('INVALID_DATE','历史已知日期无效');
  const lexemes = new WeakMap();
  const data = JSON.parse(snapshot.raw,function (key,value,context) {
    if (typeof value === 'number' && key === 'val') { const map=lexemes.get(this) ?? new Map(); map.set(key,context?.source ?? String(value)); lexemes.set(this,map); }
    return value;
  });
  if (Number(data.cik) !== Number(snapshot.cik)) throw new SourceError('SUBJECT_MISMATCH','快照中的主体与元数据不一致');
  const concept = data.facts?.[taxonomy]?.[tag]; const rows=concept?.units?.[unit];
  if (!Array.isArray(rows)) return { status:'missing',facts:[],gaps:[`未取得 ${taxonomy}:${tag} / ${unit}；不以零代替`] };
  const facts=[],gaps=[];
  rows.forEach((row,index) => {
    if (!day(row.end) || (row.start !== undefined && (!day(row.start) || row.start > row.end)) || !day(row.filed) || !/^\d{10}-\d{2}-\d{6}$/.test(row.accn ?? '')) {
      gaps.push(`第 ${index} 条事实缺少有效期间、披露日期或 accession，未进入可比较结果`); return;
    }
    if (knownByDate && row.filed > knownByDate) return;
    const rawValue=lexemes.get(row)?.get('val') ?? (row.val === null || row.val === undefined ? null : String(row.val));
    const numeric = typeof row.val === 'number' && Number.isFinite(row.val) && Math.abs(row.val) <= Number.MAX_SAFE_INTEGER;
    const fact = { sourceId:'sec-edgar', subject:{ scheme:'CIK',id:snapshot.cik,name:data.entityName ?? null },
      taxonomy,metric:tag,label:concept.label ?? tag,rawValue,value:numeric?row.val:null,unit,currency:/^[A-Z]{3}$/.test(unit)?unit:null,
      scope:'entity-wide',period:{ start:row.start ?? row.end,end:row.end },periodKind:row.start?'duration_unclassified':'instant',
      fiscalYear:row.fy ?? null,fiscalPeriod:row.fp ?? null,form:row.form ?? null,frame:row.frame ?? null,
      disclosureVersion:row.accn,publishedOn:row.filed,publishedAt:null,retrievedAt:snapshot.retrievedAt,
      anchor:{ kind:'json-pointer',snapshotHash:snapshot.hash,pointer:`/facts/${pointer(taxonomy)}/${pointer(tag)}/units/${pointer(unit)}/${index}/val` },
      sourceUrl:snapshot.url,filingUrl:`https://www.sec.gov/Archives/edgar/data/${Number(snapshot.cik)}/${row.accn.replaceAll('-','')}/${row.accn}-index.html`,
      adapterVersion:snapshot.adapterVersion,normalizerVersion:'sec-facts@0.1.0',derivation:null,
      gaps:[...(numeric?[]:['数值缺失、无效或超出安全数值精度；原始数字及 JSON 锚点保留']),...(row.start?['持续期间尚未被确认是单季或累计']:[])] };
    facts.push(fact);
  });
  return { status:facts.length?'available':'missing',facts,gaps };
}
export function compareFacts(left,right) {
  const fields=['sourceId','taxonomy','metric','unit','currency','scope','periodKind'];
  const differences=fields.filter(k=>left[k]!==right[k]);
  if (left.subject.id!==right.subject.id) differences.push('subject');
  if (left.periodKind==='duration_unclassified' || right.periodKind==='duration_unclassified') differences.push('periodKindUnconfirmed');
  if (left.value===null || right.value===null) return { status:'missing',differences,reason:'缺少可计算值，不能填零' };
  if (differences.length) return { status:'not_comparable',differences,reason:'主体、指标或财务口径尚不一致' };
  if (left.period.start===right.period.start && left.period.end===right.period.end && left.value!==right.value)
    return { status:'conflicting_disclosures',differences:['value'],reason:'同期间披露值不同，保留两个版本等待选择' };
  return { status:'compatible_metadata',differences:[],reason:'基础口径检查通过；跨期计算仍须确认期间与所选披露版本' };
}
