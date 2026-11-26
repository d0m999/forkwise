import { companyFactsReader, secUrl, type CompanyFact } from '@forkwise/public-data-core';
import { canonical } from '../domain/canonical.js';
import type { VerificationOrigin, VerificationQuery, VerificationResult } from './verification-contracts.js';

type Accessed = Extract<VerificationResult['evidence'], { status: 'accessed' }>;
type EvidenceReference = {
  path: string;
  origin: VerificationOrigin;
  result?: { query: VerificationQuery; verification: VerificationResult & { evidence: Accessed } };
};
export type VerificationReference = EvidenceReference | { path: string; reason: string };

export const VERIFICATION_RECORD_LIMIT = 20;
export function verificationRecords(facts: CompanyFact[]): VerificationResult['records'] {
  return facts.slice(0, VERIFICATION_RECORD_LIMIT).map(fact => ({
    rawValue: fact.numericLexeme, accession: fact.disclosureVersion, filedOn: fact.publishedOn,
    pointer: fact.numericLexeme === null ? fact.anchor.pointer.slice(0, -4) : fact.anchor.pointer, form: fact.form,
  }));
}

export function verificationFactQuery(query: VerificationQuery) {
  return {
    taxonomy: query.taxonomy, tag: query.tag, unit: query.unit, knownByDate: query.knownByDate,
    exactPeriod: { start: query.periodStart, end: query.periodEnd },
  };
}

type VerificationOutput = { candidate: unknown; verification?: VerificationResult | undefined } | null;
export function verificationReferences(task: {
  verification?: VerificationQuery | undefined;
  verificationFixture?: true | undefined;
  output: VerificationOutput;
  attempts: readonly { output: VerificationOutput }[];
}, path: string) {
  const query = task.verification;
  if (task.verificationFixture && !query) return [{ path, reason: '模拟查证任务缺少查证输入' }];
  return [
    { output: task.output, path: `${path}.output` },
    ...task.attempts.map(({ output }, index) => ({ output, path: `${path}.attempts[${index}].output` })),
  ].flatMap(({ output, path }): VerificationReference[] => {
    const result = output?.verification;
    const evidence = result?.evidence;
    if (output && Boolean(result) !== Boolean(query))
      return [{ path, reason: '查证查询与该次结果的来源记录不一致' }];
    if (!result || !query || !output) return [];
    if (evidence?.status !== 'accessed') {
      if (result.records.length || result.matchedRecords || output.candidate)
        return [{ path, reason: '未取得原文的查证含披露记录或候选' }];
      if (result.coverage !== (evidence?.status === 'not_retained' ? 'insufficient' : 'unknown'))
        return [{ path, reason: '查证来源访问状态与覆盖判断不一致' }];
    } else if (result.coverage === 'matched' || result.coverage === 'conflicting') {
      if (!output.candidate || !result.records.length || result.records.length !== result.matchedRecords ||
        result.records.some(record => record.rawValue === null) || result.coverage !== disclosureAgreement(result.records))
        return [{ path, reason: '查证候选与匹配记录或披露冲突状态不一致' }];
    } else if (output.candidate || result.coverage === 'unknown') {
      return [{ path, reason: '查证来源访问状态与覆盖判断不一致' }];
    }
    if (evidence?.status === 'accessed' && evidence.receipt.fixture !== task.verificationFixture)
      return [{ path, reason: '查证任务与原文回执的模拟标记不一致' }];
    return evidence?.status === 'accessed' ? [{
      path, origin: evidence.receipt,
      result: { query, verification: { ...result, evidence } },
    }] : [];
  });
}

export function disclosureAgreement(records: VerificationResult['records']): 'matched' | 'conflicting' {
  const values = new Set(records.map(record => record.rawValue === null ? null : exactNumber(record.rawValue)));
  return values.size === 1 ? 'matched' : 'conflicting';
}

// Equivalent encodings (1, 1.0 and 10e-1) have the same value without crossing
// the binary Number precision boundary.
function exactNumber(value: string) {
  const [mantissa, exponent = '0'] = value.toLowerCase().split('e');
  const [whole, fraction = ''] = mantissa!.replace(/^-/, '').split('.');
  const digits = (whole + fraction).replace(/^0+/, '');
  if (!digits) return '0';
  const significant = digits.replace(/0+$/, '');
  if (exponent.length > 128) return value;
  const scale = BigInt(exponent) + BigInt(digits.length - significant.length - fraction.length);
  return `${value.startsWith('-') ? '-' : ''}${significant}e${scale}`;
}

type EvidenceAsset = { kind: unknown; mime: unknown; hash: unknown; raw: () => string | undefined };

export function* invalidVerificationReferences(references: VerificationReference[], load: (id: string) => EvidenceAsset | undefined) {
  const byAsset = new Map<string, EvidenceReference[]>();
  for (const ref of references) {
    if ('reason' in ref) {
      yield ref;
      continue;
    }
    const entries = byAsset.get(ref.origin.assetId) ?? [];
    entries.push(ref);
    byAsset.set(ref.origin.assetId, entries);
  }
  for (const [id, entries] of byAsset) {
    const asset = load(id);
    let readFacts: ReturnType<typeof companyFactsReader> | null | undefined;
    for (const { path, origin, result } of entries) {
      if (asset?.kind !== 'file' || asset.mime !== 'application/json' || asset.hash !== origin.hash ||
        id !== `sec-companyfacts:${origin.hash}`) {
        yield { path, reason: '查证原文缺失或 SHA-256 与回执不一致' };
        continue;
      }
      if (!result) continue;
      const { query, verification } = result;
      const receipt = verification.evidence.receipt;
      if (receipt.url !== secUrl(query.cik, 'companyfacts')) {
        yield { path, reason: '查证来源地址与查询主体不一致' };
        continue;
      }
      if (readFacts === undefined) {
        try {
          const original = asset.raw();
          readFacts = original === undefined ? null : companyFactsReader(original, true);
        } catch {
          readFacts = null;
        }
      }
      let extracted;
      try {
        extracted = readFacts?.({ ...receipt, cik: query.cik, dataset: 'companyfacts' }, verificationFactQuery(query));
      } catch {
        // An acquired but malformed document is a valid insufficient-evidence result.
      }
      if (!extracted) {
        if (verification.coverage !== 'insufficient' || verification.matchedRecords ||
            verification.records.length || verification.subject !== null)
          yield { path, reason: '已保存的查证原文无法支持这次覆盖判断或披露记录' };
        continue;
      }
      if (extracted.unitCovered === (verification.coverage === 'no_coverage') ||
          extracted.entityName !== verification.subject || extracted.facts.length !== verification.matchedRecords ||
          canonical(verificationRecords(extracted.facts)) !== canonical(verification.records))
        yield { path, reason: '查证匹配数、覆盖、锚点或原始数值与保存的 SEC 原文不一致' };
      else if (extracted.gaps.length && ['matched', 'conflicting'].includes(verification.coverage))
        yield { path, reason: '原文提取有缺口，不能作为可添加的查证候选' };
    }
  }
}
