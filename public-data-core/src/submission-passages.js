import { SourceError } from "./sec.js";
import { inspect, fail, day } from "./submission-index.js";
export { resolveSubmissionDocument } from "./submission-documents.js";
const format = "sec_submissions_v1";
function passage(raw, node, role, recordPointer) {
  return {
    start: node.start,
    end: node.end,
    text: raw.slice(node.start, node.end),
    structure: {
      format,
      pointer: node.path,
      role,
      ...(recordPointer ? { recordPointer } : {}),
    },
  };
}
const identity = (p) => `${p.structure.pointer}:${p.structure.role}`;
function bundle(raw, index, row) {
  const { root, recent, files } = index;
  const nodes = [...recent.members].map(([name, column]) => [
    name,
    column.members.get(String(row)),
  ]);
  const byName = new Map(nodes),
    value = (name) => byName.get(name)?.value;
  const pointer = byName.get("accessionNumber").path,
    passages = [],
    gaps = [];
  for (const name of ["cik", "name", "tickers", "exchanges"]) {
    const node = root.members.get(name);
    if (node) passages.push(passage(raw, node, "subject"));
  }
  // The directory is evidence of available older files, never evidence that their contents were read.
  if (files) passages.push(passage(raw, files, "history_index"));
  for (const [name, node] of nodes)
    passages.push(
      passage(
        raw,
        node,
        name === "accessionNumber" ? "filing" : "filing_field",
        pointer,
      ),
    );
  const accn = value("accessionNumber"),
    primary = value("primaryDocument"),
    form = value("form");
  const validAccn =
    typeof accn === "string" && /^\d{10}-\d{2}-\d{6}$/.test(accn);
  // SEC may include a stylesheet directory before the filename. Keep only safe
  // relative segments; never interpret absolute URLs, traversal, queries or escapes.
  const validPrimary =
    typeof primary === "string" &&
    primary.length <= 512 &&
    primary
      .split("/")
      .every((part) => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(part));
  if (!validAccn) gaps.push("申报标识缺失或无效，不能确定原申报身份");
  if (!validPrimary) gaps.push("主文件名缺失或不安全，未生成文件入口");
  if (!day(value("filingDate")))
    gaps.push("披露日期缺失或无效，不能确定申报日期");
  if (!day(value("reportDate")))
    gaps.push("报告期间日期缺失或无效，不能推断财务期间");
  else
    gaps.push(
      "reportDate 只有报告期间日期，不能据此确定起始日、单季、累计或财务口径",
    );
  if (typeof form !== "string" || !form.trim())
    gaps.push("申报类型缺失，不能推断申报性质");
  if (
    typeof root.members.get("name")?.value !== "string" ||
    !root.members.get("name").value.trim()
  )
    gaps.push(
      index.history
        ? "历史分片不含主体名称；主体绑定须回查固定父索引，不能由 accession 前缀推断"
        : "主体名称缺失，须另行核对 CIK 对应主体",
    );
  if (typeof form === "string" && form.endsWith("/A"))
    gaps.push("修订申报单独保留，未推断其替代范围或覆盖原版");
  return {
    passages,
    record: {
      pointer,
      row,
      accessionNumber: typeof accn === "string" ? accn : null,
      documentUrl:
        validAccn && validPrimary
          ? `https://www.sec.gov/Archives/edgar/data/${Number(index.cik)}/${accn.replaceAll("-", "")}/${primary}`
          : null,
      gaps,
    },
  };
}

/** Select complete column-aligned filing metadata without fetching filing documents. */
export function selectSubmissionPassages(
  raw,
  { queries, maxCharacters, expectedCik, maxRecords = 200, history = false },
) {
  if (
    !Array.isArray(queries) ||
    queries.length < 1 ||
    queries.length > 8 ||
    queries.some((q) => typeof q !== "string" || !q.trim() || q.length > 200) ||
    !Number.isInteger(maxCharacters) ||
    maxCharacters < 1 ||
    maxCharacters > 200_000 ||
    !Number.isInteger(maxRecords) ||
    maxRecords < 1 ||
    maxRecords > 200
  )
    throw new SourceError(
      "INVALID_QUERY",
      "需要有界检索词、字符预算和记录上限",
    );
  const index = inspect(raw, expectedCik, { history }),
    terms = queries.map((q) => q.trim().toLowerCase()),
    selected = new Map(),
    records = [];
  let matchedRecords = 0,
    selectedCharacters = 0,
    budgetLimited = false;
  for (let row = 0; row < index.count; row++) {
    const searchable = [...index.recent.members.values()]
      .map((column) => {
        const node = column.members.get(String(row));
        // Decode strings for literal matching; output remains exact original text.
        return node.kind === "string"
          ? node.value
          : raw.slice(node.start, node.end);
      })
      .join("\n")
      .toLowerCase();
    if (!terms.some((term) => searchable.includes(term))) continue;
    matchedRecords++;
    if (records.length >= maxRecords) continue;
    const result = bundle(raw, index, row),
      extra = result.passages.filter((p) => !selected.has(identity(p))),
      size = extra.reduce((sum, p) => sum + p.text.length, 0);
    if (size + selectedCharacters > maxCharacters) {
      budgetLimited = true;
      continue;
    }
    for (const p of extra) selected.set(identity(p), p);
    selectedCharacters += size;
    records.push(result.record);
  }
  const historyFileCount = index.files?.members.size ?? 0;
  return {
    method: format,
    passages: [...selected.values()].sort((a, b) => a.start - b.start),
    records,
    matchedRecords,
    selectedCharacters,
    budgetLimited,
    candidateLimitReached:
      records.length === maxRecords && matchedRecords > maxRecords,
    historyFileCount,
    gaps: [
      "仅核对申报索引元数据；申报正文及附件未读取，文件入口不表示取得正文，也不能由索引确认营收、利润或预测结果。",
      "仅选择匹配的申报行，未选中的申报未核查；披露日期、接收时间原值与获取时间分别保留，不据索引推定完整财务期间。",
      ...(historyFileCount
        ? [
            `当前目录另列 ${historyFileCount} 个历史索引文件；当前文件未包含其内容，是否另行读取须查看各材料的取材记录；当前索引不代表全部申报。`,
          ]
        : []),
    ],
  };
}

/** Validate saved row membership and every supplied span against the immutable source. */
export function validateSubmissionPassages(
  raw,
  passages,
  expectedCik,
  options = {},
) {
  const index = inspect(raw, expectedCik, options),
    actual = new Map(),
    wanted = new Map(),
    records = [];
  for (const p of passages) {
    if (!p?.structure || p.structure.format !== format)
      fail("申报片段结构标识缺失或错误");
    if (actual.has(identity(p))) fail("申报片段身份重复");
    actual.set(identity(p), p);
  }
  for (let row = 0; row < index.count; row++) {
    const anchor = index.recent.members
      .get("accessionNumber")
      .members.get(String(row));
    if (!actual.has(`${anchor.path}:filing`)) continue;
    const complete = bundle(raw, index, row);
    records.push(complete.record);
    for (const p of complete.passages) wanted.set(identity(p), p);
  }
  if (wanted.size !== actual.size)
    fail("申报片段缺少完整行上下文或具有无效路径");
  for (const [key, p] of wanted) {
    const supplied = actual.get(key);
    if (
      !supplied ||
      supplied.start !== p.start ||
      supplied.end !== p.end ||
      supplied.text !== p.text ||
      supplied.structure.recordPointer !== p.structure.recordPointer
    )
      fail("申报片段行归属、路径、角色或绝对位置与原文不符");
  }
  return { records, historyFileCount: index.files?.members.size ?? 0 };
}
