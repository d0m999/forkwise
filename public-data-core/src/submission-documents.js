import { SourceError } from "./sec.js";
import { inspect, day, fail } from "./submission-index.js";

const value = (index, row, name) =>
  index.recent.members.get(name)?.members.get(String(row))?.value;
const accessionPattern = /^\d{10}-\d{2}-\d{6}$/;

function counts(index) {
  const result = new Map();
  for (let row = 0; row < index.count; row++) {
    const accession = value(index, row, "accessionNumber");
    result.set(accession, (result.get(accession) ?? 0) + 1);
  }
  return result;
}
function document(index, row, occurrences) {
  const accessionNumber = value(index, row, "accessionNumber"),
    primaryDocument = value(index, row, "primaryDocument");
  if (
    typeof accessionNumber !== "string" ||
    !accessionPattern.test(accessionNumber)
  )
    fail("申报编号无效");
  if (occurrences.get(accessionNumber) !== 1)
    fail("固定索引中必须恰好有一条匹配申报，不能猜测或选择重复记录");
  if (
    typeof primaryDocument !== "string" ||
    primaryDocument.length > 512 ||
    !primaryDocument
      .split("/")
      .every((part) => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(part))
  )
    fail("申报主文件路径缺失或不安全");
  if (primaryDocument.split("/").at(-1).length > 255)
    fail("申报主文件名超出保存边界");
  if (!/\.html?$/i.test(primaryDocument))
    throw new SourceError(
      "UNSUPPORTED_FILING_FORMAT",
      "此入口支持 HTML 主文件；其他格式及附件须单独取得",
    );
  return {
    url: `https://www.sec.gov/Archives/edgar/data/${Number(index.cik)}/${accessionNumber.replaceAll("-", "")}/${primaryDocument}`,
    accessionNumber,
    primaryDocument,
    recordPointer: index.recent.members
      .get("accessionNumber")
      .members.get(String(row)).path,
    form:
      typeof value(index, row, "form") === "string"
        ? value(index, row, "form")
        : null,
    filingDate: day(value(index, row, "filingDate"))
      ? value(index, row, "filingDate")
      : null,
    reportDate: day(value(index, row, "reportDate"))
      ? value(index, row, "reportDate")
      : null,
  };
}

/** Resolve only an unambiguous primary document actually named by the fixed index. */
export function resolveSubmissionDocument(
  raw,
  expectedCik,
  accessionNumber,
  options = {},
) {
  if (!accessionPattern.test(accessionNumber)) fail("申报编号无效");
  const index = inspect(raw, expectedCik, options),
    occurrences = counts(index);
  if (occurrences.get(accessionNumber) !== 1)
    fail("固定索引中必须恰好有一条匹配申报，不能猜测或选择重复记录");
  for (let row = 0; row < index.count; row++)
    if (value(index, row, "accessionNumber") === accessionNumber)
      return document(index, row, occurrences);
}

/** Complete deterministic selection within the current index; never silently take the first N. */
export function selectSubmissionDocuments(
  raw,
  {
    expectedCik,
    forms,
    filedFrom,
    filedThrough,
    maxDocuments = 10,
    history = false,
  },
) {
  if (
    !Array.isArray(forms) ||
    forms.length < 1 ||
    forms.length > 10 ||
    forms.some(
      (form) =>
        typeof form !== "string" ||
        !form.trim() ||
        form !== form.trim() ||
        form.length > 30,
    ) ||
    new Set(forms).size !== forms.length ||
    !day(filedFrom) ||
    !day(filedThrough) ||
    filedFrom > filedThrough ||
    !Number.isInteger(maxDocuments) ||
    maxDocuments < 1 ||
    maxDocuments > 10
  )
    throw new SourceError(
      "INVALID_FILING_FILTER",
      "需要明确的申报类型、有效披露日期范围和 1–10 个文件预算",
    );
  const index = inspect(raw, expectedCik, { history }),
    occurrences = counts(index),
    rows = [],
    gaps = [];
  let uncertain = 0;
  for (let row = 0; row < index.count; row++) {
    const form = value(index, row, "form"),
      date = value(index, row, "filingDate");
    if (typeof form !== "string" || !form.trim()) {
      uncertain++;
      continue;
    }
    if (!forms.includes(form)) continue;
    if (!day(date)) {
      uncertain++;
      continue;
    }
    if (date >= filedFrom && date <= filedThrough) rows.push(row);
  }
  if (rows.length > maxDocuments)
    throw new SourceError(
      "TOO_MANY_FILINGS",
      `范围匹配 ${rows.length} 条申报，超过 ${maxDocuments} 条预算；请缩小范围，未静默删减`,
    );
  const documents = [],
    unavailable = [];
  for (const row of rows) {
    try {
      documents.push(document(index, row, occurrences));
    } catch (error) {
      if (!(error instanceof SourceError)) throw error;
      unavailable.push({
        recordPointer: index.recent.members
          .get("accessionNumber")
          .members.get(String(row)).path,
        accessionNumber: value(index, row, "accessionNumber"),
        error: `${error.code}: ${error.message}`,
      });
    }
  }
  const historyFileCount = index.files?.members.size ?? 0;
  if (uncertain)
    gaps.push(
      `${uncertain} 条记录缺少有效申报类型或披露日期，无法确认是否属于请求范围；未以 reportDate 代替披露日期。`,
    );
  if (historyFileCount)
    gaps.push(
      `当前索引另列 ${historyFileCount} 个历史文件；当前文件不含其内容，是否已取得须查看各分片获取记录；本次选择不代表全部申报。`,
    );
  if (!rows.length)
    gaps.push("当前索引内未找到匹配申报，不能据此断言不存在报告或主张不成立。");
  if (forms.some((form) => form.endsWith("/A")))
    gaps.push("修订申报单独保留，未推断其替代范围或覆盖原版。");
  return {
    documents,
    unavailable,
    matchedRecords: rows.length,
    historyFileCount,
    gaps,
  };
}
