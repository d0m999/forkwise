import { companyFacts, secUrl, SourceError, sourceCatalog, type SecClient } from '@forkwise/public-data-core';
import type { MediaAsset } from './contracts.js';
import type { OrganizeOutput } from './organize-contracts.js';
import type { VerificationQuery, VerificationResult } from './verification-contracts.js';
import { disclosureAgreement, verificationFactQuery, verificationRecords, VERIFICATION_RECORD_LIMIT } from './verification-evidence.js';

export type VerificationSource = { client?: Pick<SecClient, 'fetch'>; blockedReason?: string; fixture?: true };
export const SEC_UNCONFIGURED = '尚未配置含真实联系邮箱的 SEC_USER_AGENT，无法访问 SEC。';
export const VERIFICATION_MAX_BYTES = 10 * 1024 * 1024;

export async function verifyPublicFacts(query: VerificationQuery, source: VerificationSource | undefined, signal: AbortSignal):
  Promise<{ output: OrganizeOutput; asset?: MediaAsset }> {
  const result: VerificationResult = {
    catalogVersion: sourceCatalog.version,
    evidence: { status: 'not_accessed', reason: source?.blockedReason ?? SEC_UNCONFIGURED },
    coverage: 'unknown', subject: null, matchedRecords: 0, records: [], inference: 'not_enabled',
  };
  const output: OrganizeOutput = { candidate: null, gaps: [], verification: result };
  if (!source?.client) return { output };

  const url = secUrl(query.cik, 'companyfacts');
  let snapshot;
  try {
    snapshot = await source.client.fetch(query.cik, 'companyfacts', { signal });
    signal.throwIfAborted();
  } catch (cause) {
    signal.throwIfAborted();
    const failure = cause instanceof SourceError ? cause : null;
    const details = failure?.details as { status?: unknown } | undefined;
    result.evidence = {
      status: 'access_failed', reason: failure?.message ?? '来源访问未完成，请重试。',
      code: failure?.code ?? 'SEC_ACCESS_FAILED', httpStatus: typeof details?.status === 'number' ? details.status : null,
    };
    return { output };
  }
  const bytes = Buffer.from(snapshot.raw, 'utf8');
  if (bytes.length > VERIFICATION_MAX_BYTES) {
    result.coverage = 'insufficient';
    result.evidence = { status: 'not_retained', url, hash: snapshot.hash, retrievedAt: snapshot.retrievedAt,
      reason: 'SEC 已返回原文，文件超过 10 MiB 的项目资源上限，当前无法提供可回查的结果。' };
    return { output };
  }
  const asset: MediaAsset = {
    id: `sec-companyfacts:${snapshot.hash}`, name: `SEC-companyfacts-CIK${query.cik}.json`, kind: 'file',
    mime: 'application/json', base64: bytes.toString('base64'), hash: snapshot.hash,
  };
  result.evidence = { status: 'accessed', receipt: {
    assetId: asset.id, hash: snapshot.hash, ...(source.fixture ? { fixture: true } : {}), sourceId: 'sec-edgar', url, retrievedAt: snapshot.retrievedAt,
    adapterVersion: snapshot.adapterVersion, httpLastModified: snapshot.httpLastModified,
  } };
  let extracted;
  try {
    extracted = companyFacts(snapshot, verificationFactQuery(query));
  } catch (cause) {
    result.coverage = 'insufficient';
    output.gaps.push(cause instanceof SourceError ? cause.message : '无法按唯一位置读取已保存的 SEC 原文。');
    return { output, asset };
  }
  const { facts, gaps, entityName, unitCovered } = extracted;
  result.subject = entityName;
  result.matchedRecords = facts.length;
  result.records = verificationRecords(facts);
  output.gaps.push(...gaps.slice(0, 10));
  if (!unitCovered) result.coverage = 'no_coverage';
  else if (!facts.length) {
    result.coverage = 'insufficient';
    output.gaps.push(query.periodEnd > query.knownByDate
      ? '在本次已知截点，目标业务期间尚未结束，等相关披露后可再次核对。'
      : '没有查到符合业务期间和已知截止日的披露。');
  } else if (facts.length > VERIFICATION_RECORD_LIMIT) {
    result.coverage = 'insufficient';
    output.gaps.push(`匹配 ${facts.length} 条记录，本次最多审阅 ${VERIFICATION_RECORD_LIMIT} 条，可从保存的原文核对其余记录。`);
  } else if (gaps.length || result.records.some(record => !record.rawValue)) {
    result.coverage = 'insufficient';
    output.gaps.push('本次范围内有记录缺少有效披露信息或数字。');
  } else {
    result.coverage = disclosureAgreement(result.records);
    if (result.coverage === 'conflicting') output.gaps.push('匹配的披露记录有不同数值，全部保留。');
    if (query.periodStart) output.gaps.push('只核对原始起止日，单季或累计口径尚未确认。');
    const period = query.periodStart ? `${query.periodStart} 至 ${query.periodEnd}` : `${query.periodEnd}（时点）`;
    const lines = result.records.map(record =>
      `${record.filedOn} 披露 · ${record.form ?? '表格类型未知'} · ${record.accession} · ${record.rawValue} ${query.unit}\n${record.pointer}`);
    const text = [
      `${source.fixture ? '测试夹具（模拟查证） · ' : ''}SEC EDGAR companyfacts · CIK ${query.cik}${entityName ? ` · ${entityName}` : ''}`,
      `${query.taxonomy}:${query.tag} · 业务期间 ${period} · 已知截止 ${query.knownByDate}`,
      result.coverage === 'conflicting' ? '匹配的披露记录有不同数值，保留全部版本。' : null,
      query.periodStart ? '只核对原始起止日，单季或累计口径尚未确认。' : null,
      ...lines,
      `取得时间 ${snapshot.retrievedAt}\n${url}\nSHA-256 ${snapshot.hash}`,
    ].filter(Boolean).join('\n\n');
    if (text.length <= 16_000) output.candidate = { title: `SEC 披露 · ${query.tag}`.slice(0, 240), text };
    else {
      result.coverage = 'insufficient';
      output.gaps.push('匹配记录超出单张候选卡的文字上限，可在本次结果中回查。');
    }
  }
  return { output, asset };
}
