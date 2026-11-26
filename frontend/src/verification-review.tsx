import { attachmentContentUrl } from './card-attachments';
import type { VerificationQuery, VerificationResult } from '../../backend/src/mapping/verification-contracts';

const queryFields = [
  { name: 'cik', label: '公司 CIK', placeholder: '例如 0000050863', inputMode: 'numeric' },
  { name: 'taxonomy', label: '分类体系（taxonomy）', placeholder: '例如 us-gaap' },
  { name: 'tag', label: '指标标签（tag）', placeholder: '例如 Assets' },
  { name: 'unit', label: '单位', placeholder: '例如 USD' },
  { name: 'periodStart', label: '业务期间起日（时点指标留空）', type: 'date' },
  { name: 'periodEnd', label: '业务期间末日或时点', type: 'date' },
  { name: 'knownByDate', label: '已知截止日（含当天）', type: 'date' },
] as const;
export type VerificationDraft = Record<keyof VerificationQuery, string>;
export const emptyVerificationDraft: VerificationDraft = {
  cik: '', taxonomy: '', tag: '', unit: '', periodStart: '', periodEnd: '', knownByDate: '',
};

export function VerificationForm({ draft, onChange, disabled, blockedReason, invalid, fixture }: {
  draft: VerificationDraft;
  onChange: (draft: VerificationDraft) => void;
  disabled: boolean;
  blockedReason: string | null | undefined;
  invalid: string | null;
  fixture: boolean;
}) {
  return <>
    {fixture ? <p className="organize-muted"><strong>模拟查证</strong>使用本机测试夹具，未连接 SEC。</p>
      : <p>从 SEC EDGAR 的 companyfacts 核对申报实体整体的财务事实。查询向 SEC 发送 CIK 和已配置的联系标识，卡片内容留在本机。</p>}
    {blockedReason && <p className="organize-error" role="status">{blockedReason}</p>}
    <fieldset className="verification-fields" disabled={disabled}>
      <legend>确认查证范围</legend>
      {queryFields.map(({ name, label, ...input }) => <label key={name}>
        <span>{label}</span>
        <input {...input} autoComplete="off" value={draft[name]} onChange={event => onChange({ ...draft, [name]: event.currentTarget.value })} />
      </label>)}
    </fieldset>
    {invalid && <p className="organize-error" role="alert">{invalid}</p>}
  </>;
}

const coverageLabels: Record<VerificationResult['coverage'], string> = {
  unknown: '尚未判定',
  no_coverage: '该主体的 SEC companyfacts 未收录此指标或单位',
  insufficient: '证据不足',
  matched: '找到符合已确认范围的披露',
  conflicting: '同期间披露存在冲突',
};

export function VerificationScope({ query, subject }: { query: VerificationQuery; subject?: string | null | undefined }) {
  return <dl className="verification-scope" aria-label="查证输入">
    <div><dt>主体和口径</dt>
      <dd>CIK {query.cik}{subject && ` · ${subject}`}<br />
        {query.taxonomy}:{query.tag} · {query.unit} · 申报实体整体</dd></div>
    <div><dt>业务期间</dt>
      <dd>{query.periodStart ? `${query.periodStart} 至 ${query.periodEnd}` : `${query.periodEnd}（时点）`}</dd>
      <dt>已知截止日</dt><dd>{query.knownByDate}（含当天）</dd></div>
  </dl>;
}

export function VerificationReview({ projectId, query, result, fixture }: {
  projectId: string; query: VerificationQuery; result: VerificationResult; fixture: boolean;
}) {
  const { evidence } = result;
  return <section className="verification-review" aria-label="公开查证结果">
    <h3>查证结果与来源</h3>
    <dl>
      <dt>来源范围</dt>
      <dd>{fixture ? '测试夹具，模拟 SEC EDGAR companyfacts' : 'SEC EDGAR · companyfacts'} · 目录版本 {result.catalogVersion}</dd>
      <dt>{fixture ? '模拟访问' : '实际访问'}</dt>
      <dd>{evidence.status === 'accessed' ? <>
        已取得 · {evidence.receipt.retrievedAt}{' '}
        <a download href={attachmentContentUrl(location.origin, projectId, evidence.receipt.assetId, 'attachment')}>下载查证原文</a>
        <details><summary>访问回执</summary>
          <div>{evidence.receipt.url}</div>
          <div>SHA-256 {evidence.receipt.hash}</div>
          <div>适配版本 {evidence.receipt.adapterVersion}</div>
          {evidence.receipt.httpLastModified && <div>HTTP Last-Modified {evidence.receipt.httpLastModified}</div>}
        </details>
      </> : evidence.status === 'not_retained' ? <>
        {evidence.reason}<br />取得时间 {evidence.retrievedAt}
        <details><summary>访问回执</summary><div>{evidence.url}</div><div>SHA-256 {evidence.hash}</div></details>
      </> : <>
        {evidence.status === 'access_failed' ? '访问失败' : '未访问'} · {evidence.reason}
      </>}</dd>
      <dt>匹配记录</dt><dd>{evidence.status === 'accessed' ? `${result.matchedRecords} 条` : '尚未取得可核对记录'}</dd>
      <dt>覆盖判断</dt><dd>{coverageLabels[result.coverage]}</dd>
    </dl>
    {result.records.length > 0 && <ul aria-label="SEC 披露记录">
      {result.records.map(record => <li key={record.pointer}>
        <strong>{record.rawValue === null ? '数值缺失或无效' : `${record.rawValue} ${query.unit}`}</strong>
        <div>{record.filedOn} 披露{record.form && ` · ${record.form}`}</div>
        <details><summary>披露版本与位置</summary><div>Accession {record.accession}</div><code>{record.pointer}</code></details>
      </li>)}
    </ul>}
    <p className="organize-muted">本次查证未调用模型。</p>
  </section>;
}
