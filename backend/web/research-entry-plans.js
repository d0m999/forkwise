const uid = () => crypto.randomUUID();
function source(draft, title) {
  if (draft.url) {
    const url = new URL(draft.url);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password)
      throw new Error('原始地址只支持无凭据的 HTTP(S) 地址');
  }
  return {
    title: draft.title.trim() || title,
    publisher: draft.publisher.trim(),
    rights: draft.rights,
    ...(draft.url ? { url: draft.url } : {}),
  };
}
export function researchOptions(draft) {
  const queries = draft.queries
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  if (queries.length > 8 || queries.some((q) => q.length > 200))
    throw new Error('最多 8 个关键词，每个不超过 200 字符');
  return {
    ...(queries.length ? { retrieval: { queries, maxCharacters: 80_000 } } : {}),
    ...(draft.asOf ? { asOf: new Date(draft.asOf).toISOString() } : {}),
  };
}
export function textResearchPlan(draft, selected) {
  if (!draft.text.trim() && !selected.length) throw new Error('请填写观点原文，或明确选择已有材料');
  if (draft.text.length > 5_000_000) throw new Error('文字材料不能超过 500 万字符');
  const versionId = uid(),
    sourceId = uid(),
    steps = [];
  if (draft.text.trim())
    steps.push({
      endpoint: '/operations',
      body: {
        expected: {},
        commands: [
          { op: 'source.create', id: sourceId, data: source(draft, '观点摘录') },
          {
            op: 'source.import',
            id: versionId,
            sourceId,
            text: draft.text,
            coverage: draft.coverage,
            retrievedAt: new Date().toISOString(),
            publishedAt: draft.publishedAt ? new Date(draft.publishedAt).toISOString() : null,
          },
        ],
      },
    });
  const sourceVersionIds = [...selected, ...(steps.length ? [versionId] : [])];
  if (sourceVersionIds.length > 20) throw new Error('每次研究最多选择 20 个材料版本');
  steps.push({
    endpoint: '/initial-research',
    body: { sourceVersionIds, ...researchOptions(draft) },
  });
  return { label: '保存观点并开始研究', meta: { kind: 'research', draft }, steps };
}
export async function fileImportPlan(draft, file) {
  if (!file || file.size > 25_000_000 || !file.size)
    throw new Error('请选择非空且不超过 25 MB 的 PDF、HTML、PNG 或 JPEG');
  const mime =
    file.type ||
    {
      pdf: 'application/pdf',
      html: 'text/html',
      htm: 'text/html',
      png: 'image/png',
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
    }[file.name.split('.').at(-1).toLowerCase()];
  if (!['application/pdf', 'text/html', 'image/png', 'image/jpeg'].includes(mime))
    throw new Error('此入口支持 PDF、HTML、PNG 和 JPEG');
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 32768)
    binary += String.fromCharCode(...bytes.subarray(i, i + 32768));
  return {
    label: `导入 ${file.name}`,
    meta: { kind: 'file', draft },
    steps: [
      {
        endpoint: '/files/import',
        body: {
          source: source(draft, file.name),
          file: {
            name: file.name,
            mime,
            base64: btoa(binary),
            publishedAt: draft.publishedAt ? new Date(draft.publishedAt).toISOString() : null,
          },
        },
      },
    ],
  };
}
