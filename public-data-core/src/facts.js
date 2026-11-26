import { SourceError, sha } from './sec.js';
import { indexJson } from './json-positions.js';
const day = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0,10) === value;
const pointer = value => String(value).replaceAll('~','~0').replaceAll('/','~1');
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export function companyFacts(snapshot, query = {}) {
  return companyFactsReader(snapshot.raw, Boolean(query.exactPeriod))(snapshot, query);
}

// Replay multiple queries against one frozen original without reparsing it.
export function companyFactsReader(raw, requireUniqueAnchors = false) {
  const hash = sha(raw);
  if (requireUniqueAnchors) indexJson(raw, message => { throw new SourceError('INVALID_COMPANYFACTS', message); });
  const lexemes = new WeakMap();
  const data = JSON.parse(raw,function (key,value,context) {
    if (typeof value === 'number' && key === 'val') { const map=lexemes.get(this) ?? new Map(); map.set(key,context?.source ?? String(value)); lexemes.set(this,map); }
    return value;
  });
  return (snapshot, query) => {
    if (snapshot.dataset !== 'companyfacts' || hash !== snapshot.hash)
      throw new SourceError('INVALID_SNAPSHOT','需要经过指纹校验的 companyfacts 快照');
    return extractCompanyFacts(data, lexemes, snapshot, query);
  };
}

function extractCompanyFacts(data, lexemes, snapshot, { taxonomy, tag, unit, knownByDate, exactPeriod } = {}) {
  if (!taxonomy || !tag || !unit) throw new SourceError('QUERY_REQUIRED','必须明确 taxonomy、tag 和单位，不猜测同义指标');
  if (knownByDate && !day(knownByDate)) throw new SourceError('INVALID_DATE','历史已知日期无效');
  if (!['string', 'number'].includes(typeof data?.cik) ||
      !/^\d{1,10}$/.test(String(data.cik)) || Number(data.cik) !== Number(snapshot.cik))
    throw new SourceError('SUBJECT_MISMATCH','快照中的主体与元数据不一致');
  if (!record(data.facts))
    throw new SourceError('INVALID_COMPANYFACTS', 'companyfacts 缺少财务数据对象');
  const entityName = typeof data.entityName === 'string' ? data.entityName : null;
  const taxonomyFacts = own(data.facts, taxonomy);
  const concept = own(taxonomyFacts, tag);
  if ((taxonomyFacts !== undefined && !record(taxonomyFacts)) ||
      (concept !== undefined && (!record(concept) || !record(concept.units))))
    throw new SourceError('INVALID_COMPANYFACTS', '指标所在的 taxonomy、科目或单位结构无效');
  const rows = own(concept?.units, unit);
  if (rows === undefined) return { status:'missing',facts:[],gaps:[`该主体的 SEC companyfacts 未收录 ${taxonomy}:${tag} / ${unit}`],unitCovered:false,entityName };
  if (!Array.isArray(rows)) throw new SourceError('INVALID_COMPANYFACTS', '指标单位下的财务记录无效');
  const facts=[],gaps=[];
  rows.forEach((row,index) => {
    if (knownByDate && day(row?.filed) && row.filed > knownByDate) return;
    if (row && exactPeriod && ((day(row.end) && row.end !== exactPeriod.end) ||
      (row.start === undefined && exactPeriod.start !== null) ||
      (day(row.start) && row.start !== exactPeriod.start))) return;
    if (!row || !day(row.end) || (row.start !== undefined && (!day(row.start) || row.start > row.end)) || !day(row.filed) ||
      typeof row.accn !== 'string' || !/^\d{10}-\d{2}-\d{6}$/.test(row.accn)) {
      gaps.push(`第 ${index} 条事实缺少有效期间、披露日期或 accession，未进入可比较结果`); return;
    }
    const numericLexeme = lexemes.get(row)?.get('val') ?? null;
    const rawValue=numericLexeme ?? (row.val === null || row.val === undefined ? null : String(row.val));
    const numeric = typeof row.val === 'number' && Number.isFinite(row.val) && Math.abs(row.val) <= Number.MAX_SAFE_INTEGER;
    const fact = { sourceId:'sec-edgar', subject:{ scheme:'CIK',id:snapshot.cik,name:entityName },
      taxonomy,metric:tag,label:concept.label ?? tag,rawValue,numericLexeme,value:numeric?row.val:null,unit,currency:/^[A-Z]{3}$/.test(unit)?unit:null,
      scope:'entity-wide',period:{ start:row.start ?? row.end,end:row.end },periodKind:row.start?'duration_unclassified':'instant',
      fiscalYear:row.fy ?? null,fiscalPeriod:row.fp ?? null,form:typeof row.form === 'string' ? row.form : null,frame:row.frame ?? null,
      disclosureVersion:row.accn,publishedOn:row.filed,publishedAt:null,retrievedAt:snapshot.retrievedAt,
      anchor:{ kind:'json-pointer',snapshotHash:snapshot.hash,pointer:`/facts/${pointer(taxonomy)}/${pointer(tag)}/units/${pointer(unit)}/${index}/val` },
      sourceUrl:snapshot.url,filingUrl:`https://www.sec.gov/Archives/edgar/data/${Number(snapshot.cik)}/${row.accn.replaceAll('-','')}/${row.accn}-index.html`,
      adapterVersion:snapshot.adapterVersion,normalizerVersion:'sec-facts@0.1.0',derivation:null,
      gaps:[...(numeric?[]:['数值缺失、无效或超出安全数值精度；原始数字及 JSON 锚点保留']),...(row.start?['持续期间尚未被确认是单季或累计']:[])] };
    facts.push(fact);
  });
  return { status:facts.length?'available':'missing',facts,gaps,unitCovered:true,entityName };
}
function own(object, key) {
  return object != null && Object.hasOwn(object, key) ? object[key] : undefined;
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
