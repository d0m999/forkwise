import { indexJson } from "./json-positions.js";
import { SourceError } from "./sec.js";

const fail = (message) => {
  throw new SourceError("INVALID_COMPANYFACTS", message);
};

function inspect(raw, expectedCik) {
  const index = indexJson(raw, fail),
    { root } = index;
  const cik = root.members.get("cik");
  if (
    root.kind !== "object" ||
    !cik ||
    !/^\d{1,10}$/.test(String(cik.value)) ||
    Number(cik.value) === 0
  )
    fail("companyfacts 缺少有效 CIK");
  if (
    expectedCik !== undefined &&
    (!/^\d{1,10}$/.test(String(expectedCik)) ||
      Number(cik.value) !== Number(expectedCik))
  )
    throw new SourceError("SUBJECT_MISMATCH", "材料 CIK 与固定来源不一致");
  const facts = root.members.get("facts");
  if (facts?.kind !== "object") fail("companyfacts 缺少 facts 对象");
  return { ...index, facts };
}

function passage(raw, node, role, key = false) {
  const span = key ? node.key : node;
  return {
    start: span.start,
    end: span.end,
    text: raw.slice(span.start, span.end),
    structure: { format: "sec_companyfacts_v1", pointer: node.path, role },
  };
}
const day = (value) =>
  typeof value === "string" &&
  /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString().slice(0, 10) === value;

function record(raw, root, taxonomy, concept, unit, row) {
  const passages = [];
  for (const name of ["cik", "entityName"]) {
    const node = root.members.get(name);
    if (node) passages.push(passage(raw, node, "subject"));
  }
  passages.push(
    passage(raw, taxonomy, "taxonomy", true),
    passage(raw, concept, "concept", true),
  );
  for (const name of ["label", "description"]) {
    const node = concept.members.get(name);
    if (node) passages.push(passage(raw, node, name));
  }
  passages.push(passage(raw, unit, "unit", true), passage(raw, row, "fact"));
  const get = (name) => row.members.get(name)?.value,
    gaps = [];
  if (
    !day(get("end")) ||
    (row.members.has("start") &&
      (!day(get("start")) || get("start") > get("end")))
  )
    gaps.push("业务期间缺失或无效，不能比较");
  if (!day(get("filed")) || !/^\d{10}-\d{2}-\d{6}$/.test(get("accn") ?? ""))
    gaps.push("披露日期或 accession 缺失或无效，不能确定披露版本");
  if (
    typeof get("val") !== "number" ||
    !Number.isFinite(get("val")) ||
    Math.abs(get("val")) > Number.MAX_SAFE_INTEGER
  )
    gaps.push("数值缺失、无效或超出安全数值精度，保留原始词元但不能用于计算");
  if (row.members.has("start"))
    gaps.push("持续期间尚未确认是单季或累计，不能据 fp/frame 自动分类");
  if (!unit.key.value) gaps.push("单位缺失，不能比较");
  return { passages, record: { pointer: row.path, gaps } };
}

function* records(index) {
  for (const taxonomy of index.facts.members.values()) {
    if (taxonomy.kind !== "object") fail("taxonomy 不是对象");
    for (const concept of taxonomy.members.values()) {
      const units = concept.members.get("units");
      if (concept.kind !== "object" || units?.kind !== "object")
        fail("财务科目缺少 units 对象");
      for (const unit of units.members.values()) {
        if (unit.kind !== "array") fail("单位下的事实不是数组");
        for (const row of unit.members.values()) {
          if (row.kind !== "object") fail("财务记录不是对象");
          yield { taxonomy, concept, unit, row };
        }
      }
    }
  }
}
const identity = (p) => `${p.structure.pointer}:${p.structure.role}`;

/** Literal queries match concept names/labels/descriptions, unit or row text.
 * Select whole records plus their ancestors; never infer an accounting meaning.
 */
export function selectCompanyFactPassages(
  raw,
  { queries, maxCharacters, expectedCik, maxRecords = 200 },
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
  const index = inspect(raw, expectedCik),
    terms = queries.map((q) => q.trim().toLowerCase());
  const selected = new Map(),
    selectedRecords = [];
  let matchedRecords = 0,
    selectedCharacters = 0,
    budgetLimited = false;
  for (const { taxonomy, concept, unit, row } of records(index)) {
    const searchable = [
      taxonomy.key.value,
      concept.key.value,
      concept.members.get("label")?.value,
      concept.members.get("description")?.value,
      unit.key.value,
      raw.slice(row.start, row.end),
    ]
      .filter((v) => typeof v === "string")
      .join("\n")
      .toLowerCase();
    if (!terms.some((term) => searchable.includes(term))) continue;
    matchedRecords++;
    if (selectedRecords.length >= maxRecords) continue;
    const bundle = record(raw, index.root, taxonomy, concept, unit, row);
    const extra = bundle.passages.filter((p) => !selected.has(identity(p)));
    const size = extra.reduce((sum, p) => sum + p.end - p.start, 0);
    if (size + selectedCharacters > maxCharacters) {
      budgetLimited = true;
      continue;
    }
    for (const p of extra) selected.set(identity(p), p);
    selectedCharacters += size;
    selectedRecords.push(bundle.record);
  }
  return {
    method: "sec_companyfacts_v1",
    passages: [...selected.values()].sort((a, b) => a.start - b.start),
    records: selectedRecords,
    matchedRecords,
    selectedCharacters,
    budgetLimited,
    candidateLimitReached:
      selectedRecords.length === maxRecords && matchedRecords > maxRecords,
    gaps: [
      "仅选择匹配记录；未选择的科目或披露未核查。不同披露版本分别保留，尚未确认与主张的主体、期间和财务口径一致。",
    ],
  };
}

/** Revalidate fixed inputs against their source, without rerunning a query. */
export function validateCompanyFactPassages(raw, passages, expectedCik) {
  const index = inspect(raw, expectedCik),
    wanted = new Map(),
    actual = new Map();
  for (const p of passages) {
    if (!p?.structure || p.structure.format !== "sec_companyfacts_v1")
      fail("片段结构标识缺失");
    if (actual.has(identity(p))) fail("片段身份重复");
    actual.set(identity(p), p);
  }
  for (const { taxonomy, concept, unit, row } of records(index)) {
    if (!actual.has(`${row.path}:fact`)) continue;
    for (const p of record(raw, index.root, taxonomy, concept, unit, row)
      .passages)
      wanted.set(identity(p), p);
  }
  if (wanted.size !== actual.size)
    fail("财务片段缺少完整记录上下文或具有无效路径");
  for (const [key, p] of wanted) {
    const supplied = actual.get(key);
    if (
      !supplied ||
      supplied.start !== p.start ||
      supplied.end !== p.end ||
      supplied.text !== p.text
    )
      fail("财务片段路径、角色或绝对位置与原文不符");
  }
}
