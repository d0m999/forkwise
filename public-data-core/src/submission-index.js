import { SourceError } from "./sec.js";
import { indexJson } from "./json-positions.js";
export const fail = (message) => {
  throw new SourceError("INVALID_SUBMISSIONS", message);
};
export const day = (value) =>
  typeof value === "string" &&
  /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString().slice(0, 10) === value;

export function inspect(raw, expectedCik, { history = false } = {}) {
  const { root } = indexJson(raw, fail);
  if (root.kind !== "object") fail("申报索引必须为 JSON 对象");
  const cik = history ? { value: expectedCik } : root.members.get("cik");
  if (
    root.kind !== "object" ||
    !cik ||
    !/^\d{1,10}$/.test(String(cik.value)) ||
    Number(cik.value) === 0
  )
    fail("submissions 缺少有效 CIK");
  if (
    expectedCik !== undefined &&
    (!/^\d{1,10}$/.test(String(expectedCik)) ||
      Number(cik.value) !== Number(expectedCik))
  )
    throw new SourceError("SUBJECT_MISMATCH", "材料 CIK 与固定来源不一致");
  const filings = history ? root : root.members.get("filings"),
    recent = history ? root : filings?.members.get("recent"),
    files = history ? undefined : filings?.members.get("files");
  if (filings?.kind !== "object" || recent?.kind !== "object")
    fail("submissions 缺少 filings.recent 列式索引");
  const accessions = recent.members.get("accessionNumber");
  if (accessions && accessions.kind !== "array") fail("申报标识列不是数组");
  if (history && !accessions) fail("历史分片缺少 accessionNumber 列");
  const count = accessions?.members.size ?? 0;
  for (const column of recent.members.values()) {
    if (column.kind !== "array" || column.members.size !== count)
      fail("申报列长度或类型不一致，不能安全绑定同一行");
    if (!accessions && column.members.size)
      fail("申报索引缺少 accessionNumber 列");
  }
  if (
    files &&
    (files.kind !== "array" ||
      [...files.members.values()].some((file) => file.kind !== "object"))
  )
    fail("历史索引文件目录结构无效");
  return { root, recent, files, count, history, cik: String(cik.value) };
}
