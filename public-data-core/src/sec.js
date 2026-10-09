import { createHash } from "node:crypto";
import {
  assertIndexSnapshot,
  resolveSubmissionHistory,
  validateHistory,
} from "./submission-history.js";
import { resolveSubmissionDocument } from "./submission-passages.js";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

export class SourceError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.code = code;
    this.details = details;
  }
}
export function secUrl(cik, dataset = "companyfacts") {
  if (!/^\d{1,10}$/.test(String(cik)) || Number(cik) === 0)
    throw new SourceError("INVALID_CIK", "CIK 必须为 1–10 位非零数字");
  const value = String(cik).padStart(10, "0");
  if (dataset === "companyfacts")
    return `https://data.sec.gov/api/xbrl/companyfacts/CIK${value}.json`;
  if (dataset === "submissions")
    return `https://data.sec.gov/submissions/CIK${value}.json`;
  throw new SourceError(
    "UNSUPPORTED_DATASET",
    "此目录当前只维护 companyfacts 与 submissions",
  );
}
// A single process-wide queue also covers multiple clients. Other processes/machines
// still share the SEC per-user allowance and must coordinate at deployment level.
let queue = Promise.resolve(),
  nextRequestAt = 0;
async function slot(signal) {
  const turn = queue.then(async () => {
    await sleep(Math.max(0, nextRequestAt - Date.now()), undefined, { signal });
    nextRequestAt = Date.now() + 250;
  });
  queue = turn.catch(() => {});
  return turn;
}
export class SecClient {
  constructor({ userAgent, cacheDirectory, request = fetch }) {
    if (
      !userAgent ||
      !/[^\s@]+@[^\s@]+\.[^\s@]+/.test(userAgent) ||
      /[\r\n]/.test(userAgent)
    )
      throw new SourceError(
        "CONTACT_REQUIRED",
        "请配置包含真实联系邮箱的 SEC_USER_AGENT，不能编造联系人",
      );
    if (!cacheDirectory)
      throw new SourceError("CACHE_REQUIRED", "需要使用者自己的本机缓存目录");
    this.userAgent = userAgent;
    this.cacheDirectory = cacheDirectory;
    this.request = request;
  }
  async fetch(cik, dataset = "companyfacts", options = {}) {
    const url = secUrl(cik, dataset);
    return this.#acquire(
      {
        url,
        dataset,
        cik: String(cik).padStart(10, "0"),
        adapterVersion: "sec-json@0.1.0",
      },
      options,
    );
  }
  async fetchHistory(index, name, options = {}) {
    assertIndexSnapshot(index);
    if (index.dataset !== "submissions")
      throw new SourceError("INVALID_INDEX_SNAPSHOT", "历史目录仅从根索引取得");
    const record = resolveSubmissionHistory(index.raw, index.cik, name);
    return this.#acquire(
      {
        url: record.url,
        dataset: "submissions-history",
        cik: index.cik,
        adapterVersion: "sec-history-json@1",
        history: { indexUrl: index.url, indexHash: index.hash, ...record },
      },
      options,
    );
  }
  async fetchFiling(index, accessionNumber, options = {}) {
    assertIndexSnapshot(index, options.historyRoot);
    const record = resolveSubmissionDocument(
      index.raw,
      index.cik,
      accessionNumber,
      { history: index.dataset === "submissions-history" },
    );
    return this.#acquire(
      {
        url: record.url,
        dataset: "filing",
        cik: index.cik,
        adapterVersion: "sec-filing-html@1",
        lineage: { indexUrl: index.url, indexHash: index.hash, ...record },
      },
      options,
    );
  }
  async #acquire(
    spec,
    { signal = new AbortController().signal, cachedHash } = {},
  ) {
    const { url, dataset, cik } = spec;
    signal.throwIfAborted();
    // Include source identity: equal bytes from distinct URLs remain distinct snapshots.
    const snapshotPath = (hash) =>
      join(this.cacheDirectory, sha(url) + "-" + hash + ".snapshot.json");
    if (cachedHash) {
      if (!/^[a-f0-9]{64}$/.test(cachedHash))
        throw new SourceError("INVALID_SNAPSHOT", "快照指纹无效");
      let path = snapshotPath(cachedHash),
        saved;
      try {
        saved = JSON.parse(await readFile(path, "utf8"));
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        path = join(this.cacheDirectory, cachedHash + ".snapshot.json");
        saved = JSON.parse(await readFile(path, "utf8"));
      }
      if (
        saved.url !== url ||
        saved.dataset !== dataset ||
        saved.cik !== cik ||
        sha(saved.raw) !== cachedHash
      )
        throw new SourceError("CORRUPT_SNAPSHOT", "缓存来源或内容指纹不匹配");
      if (dataset === "submissions-history")
        validateHistory(saved.raw, cik, spec.history);
      return { ...saved, ...spec, cached: true, path };
    }
    for (let attempt = 0; attempt < 3; attempt++) {
      signal.throwIfAborted();
      await slot(signal);
      let response;
      try {
        response = await this.request(url, {
          redirect: "error",
          headers: {
            "User-Agent": this.userAgent,
            Accept: dataset === "filing" ? "text/html" : "application/json",
          },
          signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
        });
      } catch (error) {
        signal.throwIfAborted();
        if (attempt < 2) {
          await sleep(500 * 2 ** attempt, undefined, { signal });
          continue;
        }
        throw new SourceError(
          "NETWORK_ERROR",
          "SEC 请求失败，未取得可复核材料",
          { attempts: attempt + 1 },
        );
      }
      if ([429, 500, 502, 503, 504].includes(response.status) && attempt < 2) {
        await response.body?.cancel();
        const retry = response.headers.get("retry-after");
        const seconds = retry && /^\d+$/.test(retry) ? Number(retry) : null;
        const retryAt = retry && seconds === null ? Date.parse(retry) : NaN;
        const wait =
          seconds !== null
            ? seconds * 1000
            : Number.isFinite(retryAt)
              ? Math.max(0, retryAt - Date.now())
              : 500 * 2 ** attempt;
        if (wait > 10_000)
          throw new SourceError("RATE_LIMITED", "SEC 要求稍后重试，本次停止", {
            retryAfter: retry,
          });
        await sleep(wait, undefined, { signal });
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new SourceError(
          response.status === 403
            ? "ACCESS_DENIED"
            : response.status === 404
              ? "NOT_FOUND"
              : response.status === 429
                ? "RATE_LIMITED"
                : "UPSTREAM_ERROR",
          `SEC 返回 HTTP ${response.status}`,
          { status: response.status },
        );
      }
      const contentType = response.headers.get("content-type") ?? "";
      if (dataset === "filing" && !/^text\/html(?:;|$)/i.test(contentType)) {
        await response.body?.cancel();
        throw new SourceError(
          "UNSUPPORTED_FILING_FORMAT",
          "SEC 主文件未返回 HTML 正文",
        );
      }
      if (dataset === "filing") {
        const charset = /charset\s*=\s*["']?([^;"'\s]+)/i.exec(
          contentType,
        )?.[1];
        if (charset && !/^(utf-8|utf8|us-ascii|ascii)$/i.test(charset)) {
          await response.body?.cancel();
          throw new SourceError(
            "UNSUPPORTED_ENCODING",
            "此入口尚不支持该 HTML 编码，未错误转写正文",
          );
        }
      }
      const raw = await boundedText(response, 25_000_000, signal);
      if (dataset !== "filing") {
        let parsed;
        try {
          parsed = JSON.parse(raw);
        } catch {
          throw new SourceError(
            "INVALID_RESPONSE",
            "SEC 返回的内容不是有效 JSON",
          );
        }
        if (dataset === "submissions-history")
          validateHistory(raw, cik, spec.history);
        else if (Number(parsed.cik) !== Number(cik))
          throw new SourceError(
            "SUBJECT_MISMATCH",
            "返回材料的 CIK 与查询主体不符",
          );
      }
      const snapshot = {
        schemaVersion: 1,
        sourceId: "sec-edgar",
        ...spec,
        raw,
        hash: sha(raw),
        retrievedAt: new Date().toISOString(),
        httpLastModified: response.headers.get("last-modified"),
        publishedAt: null,
      };
      await mkdir(this.cacheDirectory, { recursive: true, mode: 0o700 });
      const path = snapshotPath(snapshot.hash);
      try {
        await writeFile(path, JSON.stringify(snapshot), {
          flag: "wx",
          mode: 0o600,
        });
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
        const previous = JSON.parse(await readFile(path, "utf8"));
        if (sha(previous.raw) !== snapshot.hash || previous.url !== url)
          throw new SourceError("CORRUPT_SNAPSHOT", "已有快照不能安全复用");
      }
      // Each acquisition is recorded even when the immutable bytes are already cached.
      const acquisition = {
        url,
        hash: snapshot.hash,
        retrievedAt: snapshot.retrievedAt,
        adapterVersion: snapshot.adapterVersion,
        ...(spec.lineage ? { lineage: spec.lineage } : {}),
        ...(spec.history ? { history: spec.history } : {}),
      };
      const key = createHash("sha256")
        .update(JSON.stringify(acquisition))
        .digest("hex");
      await writeFile(
        join(this.cacheDirectory, key + ".receipt.json"),
        JSON.stringify(acquisition),
        { mode: 0o600 },
      );
      return { ...snapshot, cached: false, path };
    }
  }
}
export function sha(text) {
  return createHash("sha256").update(text).digest("hex");
}
async function boundedText(response, maxBytes, signal) {
  if (!response.body)
    throw new SourceError("EMPTY_RESPONSE", "来源响应没有正文");
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > maxBytes)
        throw new SourceError(
          "RESPONSE_TOO_LARGE",
          "来源超过本次单文件处理边界，请使用有边界的分批导入",
        );
      chunks.push(value);
    }
    try {
      return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
        Buffer.concat(chunks),
      );
    } catch {
      throw new SourceError(
        "UNSUPPORTED_ENCODING",
        "来源不是有效 UTF-8，未以替换字符保存",
      );
    }
  } finally {
    await reader.cancel();
  }
}
