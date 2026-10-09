import { SourceError, secUrl, sha } from "./sec.js";
import { inspect, day, fail } from "./submission-index.js";

export function historyUrl(cik, name) {
  secUrl(cik, "submissions");
  const match = /^CIK(\d{10})-submissions-(\d{3,6})\.json$/.exec(name);
  if (!match || Number(match[1]) !== Number(cik))
    throw new SourceError(
      "INVALID_HISTORY_FILE",
      "历史文件名必须属于同一主体且为目录内的 submissions JSON 文件",
    );
  return `https://data.sec.gov/submissions/${name}`;
}

export function resolveSubmissionHistory(raw, expectedCik, name) {
  const index = inspect(raw, expectedCik),
    matches = [...(index.files?.members.values() ?? [])].filter(
      (node) => node.members.get("name")?.value === name,
    );
  if (matches.length !== 1)
    throw new SourceError(
      "INVALID_HISTORY_FILE",
      "父索引必须恰好列出一个同名历史文件",
    );
  return record(index, matches[0]);
}
function record(index, node) {
  const get = (key) => node.members.get(key)?.value,
    count = get("filingCount"),
    name = get("name");
  return {
    name,
    url: historyUrl(index.cik, name),
    recordPointer: node.path,
    filingFrom: day(get("filingFrom")) ? get("filingFrom") : null,
    filingTo: day(get("filingTo")) ? get("filingTo") : null,
    filingCount: Number.isSafeInteger(count) && count >= 0 ? count : null,
  };
}

export function selectSubmissionHistory(
  raw,
  { expectedCik, filedFrom, filedThrough, maxFiles = 10 },
) {
  if (
    !day(filedFrom) ||
    !day(filedThrough) ||
    filedFrom > filedThrough ||
    !Number.isInteger(maxFiles) ||
    maxFiles < 1 ||
    maxFiles > 10
  )
    throw new SourceError(
      "INVALID_FILING_FILTER",
      "需要有效的披露日期范围和 1–10 个历史文件预算",
    );
  const index = inspect(raw, expectedCik),
    files = [],
    gaps = [];
  const names = new Map();
  for (const node of index.files?.members.values() ?? []) {
    const name = node.members.get("name")?.value;
    names.set(name, (names.get(name) ?? 0) + 1);
  }
  let excludedFiles = 0;
  for (const node of index.files?.members.values() ?? []) {
    try {
      if (names.get(node.members.get("name")?.value) !== 1)
        throw new SourceError(
          "INVALID_HISTORY_FILE",
          "父索引含重复历史文件，不能选择其一",
        );
      const entry = record(index, node);
      if (
        !entry.filingFrom ||
        !entry.filingTo ||
        entry.filingFrom > entry.filingTo
      ) {
        gaps.push(
          `${node.path}：目录日期缺失或无效，无法判断是否覆盖请求范围；未自动读取。`,
        );
        continue;
      }
      if (entry.filingTo < filedFrom || entry.filingFrom > filedThrough)
        excludedFiles++;
      else files.push(entry);
    } catch (error) {
      if (!(error instanceof SourceError)) throw error;
      gaps.push(`${node.path}：${error.code}: ${error.message}`);
    }
  }
  if (files.length > maxFiles)
    throw new SourceError(
      "TOO_MANY_HISTORY_FILES",
      `范围覆盖 ${files.length} 个历史索引，超过 ${maxFiles} 个预算；未截取前几个文件`,
    );
  return {
    files,
    listedFiles: index.files?.members.size ?? 0,
    excludedFiles,
    gaps,
  };
}

export function validateHistory(raw, cik, entry) {
  const index = inspect(raw, cik, { history: true });
  if (entry.filingCount !== null && index.count !== entry.filingCount)
    throw new SourceError(
      "HISTORY_INDEX_CHANGED",
      "历史分片记录数与固定父目录不一致，请重新取得目录后发起新任务",
    );
  for (let row = 0; row < index.count; row++) {
    const date = index.recent.members
      .get("filingDate")
      ?.members.get(String(row))?.value;
    if (
      day(date) &&
      ((entry.filingFrom && date < entry.filingFrom) ||
        (entry.filingTo && date > entry.filingTo))
    )
      throw new SourceError(
        "HISTORY_INDEX_CHANGED",
        "历史分片披露日期超出固定父目录范围",
      );
  }
}

export function assertIndexSnapshot(index, historyRoot) {
  if (
    !index ||
    index.sourceId !== "sec-edgar" ||
    typeof index.raw !== "string" ||
    sha(index.raw) !== index.hash
  )
    throw new SourceError(
      "INVALID_INDEX_SNAPSHOT",
      "必须使用来源、主体和指纹一致的原始申报索引",
    );
  if (index.dataset === "submissions") {
    if (index.url !== secUrl(index.cik, "submissions"))
      fail("父索引地址与主体不一致");
    inspect(index.raw, index.cik);
    return;
  }
  if (
    index.dataset !== "submissions-history" ||
    !historyRoot ||
    historyRoot.dataset !== "submissions"
  )
    throw new SourceError(
      "INVALID_INDEX_SNAPSHOT",
      "历史分片须同时提供原始父索引以核对主体与目录来历",
    );
  assertIndexSnapshot(historyRoot);
  const entry = resolveSubmissionHistory(
    historyRoot.raw,
    historyRoot.cik,
    index.history?.name,
  );
  if (
    index.cik !== historyRoot.cik ||
    index.url !== entry.url ||
    Object.entries({
      indexUrl: historyRoot.url,
      indexHash: historyRoot.hash,
      ...entry,
    }).some(([key, value]) => index.history?.[key] !== value)
  )
    throw new SourceError(
      "INVALID_INDEX_SNAPSHOT",
      "历史分片与固定父索引来历不一致",
    );
  validateHistory(index.raw, index.cik, entry);
}
