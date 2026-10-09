import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SecClient } from "../src/index.js";

const accession = "0000000099-25-000001"; // A filing agent's prefix need not equal the subject CIK.
const directory = {
  cik: 1,
  name: "Synthetic",
  filings: {
    recent: {
      accessionNumber: [accession],
      primaryDocument: ["report.htm"],
      form: ["10-Q"],
      filingDate: ["2025-04-01"],
      reportDate: ["2025-03-31"],
    },
    files: [],
  },
};
const html =
  "<!doctype html><html><body><p>Synthetic revenue: 12.</p></body></html>";
const url =
  "https://www.sec.gov/Archives/edgar/data/1/000000009925000001/report.htm";

test("从固定索引同一行取得 HTML 主文件，保留字节、索引来历及获取回执，显式缓存不重联网", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sec-filing-"));
  const calls = [];
  try {
    const client = new SecClient({
      userAgent: "Synthetic test@example.invalid",
      cacheDirectory: dir,
      request: async (target, options) => {
        calls.push(target);
        assert.equal(options.redirect, "error");
        return String(target).includes("/submissions/")
          ? Response.json(directory)
          : new Response(html, {
              headers: { "content-type": "text/html; charset=utf-8" },
            });
      },
    });
    const index = await client.fetch("1", "submissions");
    const body = await client.fetchFiling(index, accession);
    assert.deepEqual(calls, [index.url, url]);
    assert.equal(body.raw, html);
    assert.equal(body.dataset, "filing");
    assert.equal(body.publishedAt, null);
    assert.equal(body.lineage.indexHash, index.hash);
    assert.equal(body.lineage.accessionNumber, accession);
    assert.equal(
      body.lineage.recordPointer,
      "/filings/recent/accessionNumber/0",
    );
    assert.equal(JSON.parse(await readFile(body.path, "utf8")).raw, html);
    const cached = await client.fetchFiling(index, accession, {
      cachedHash: body.hash,
    });
    assert.equal(cached.retrievedAt, body.retrievedAt);
    assert.equal(calls.length, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("缺失、重复申报及危险或非 HTML 文件名在联网前拒绝；索引指纹不能被替换", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sec-filing-invalid-"));
  let calls = 0;
  try {
    const client = new SecClient({
      userAgent: "Synthetic test@example.invalid",
      cacheDirectory: dir,
      request: async () => {
        calls++;
        return Response.json(directory);
      },
    });
    const index = await client.fetch("1", "submissions");
    await assert.rejects(
      client.fetchFiling(index, "0000000099-25-000002"),
      (e) => e.code === "INVALID_SUBMISSIONS",
    );
    await assert.rejects(
      client.fetchFiling({ ...index, raw: "{}" }, accession),
      (e) => e.code === "INVALID_INDEX_SNAPSHOT",
    );
    const { createHash } = await import("node:crypto");
    for (const name of [
      "../secret.htm",
      "https://outside.invalid/a.htm",
      "%2e%2e/a.htm",
      "report.xml",
    ]) {
      const changed = structuredClone(directory);
      changed.filings.recent.primaryDocument = [name];
      const raw = JSON.stringify(changed);
      await assert.rejects(
        client.fetchFiling(
          {
            ...index,
            raw,
            hash: createHash("sha256").update(raw).digest("hex"),
          },
          accession,
        ),
      );
    }
    const duplicate = structuredClone(directory);
    for (const column of Object.values(duplicate.filings.recent))
      column.push(column[0]);
    const raw = JSON.stringify(duplicate);
    await assert.rejects(
      client.fetchFiling(
        { ...index, raw, hash: createHash("sha256").update(raw).digest("hex") },
        accession,
      ),
      /恰好/,
    );
    assert.equal(calls, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("正文 403、不支持编码与错误格式不落为成功；相同字节的不同原始地址分别保留", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sec-filing-response-"));
  let response = () => new Response("denied", { status: 403 });
  let calls = 0;
  try {
    const client = new SecClient({
      userAgent: "Synthetic test@example.invalid",
      cacheDirectory: dir,
      request: async (url) => {
        if (String(url).includes("/submissions/"))
          return Response.json(directory);
        calls++;
        return response();
      },
    });
    const index = await client.fetch("1", "submissions");
    await assert.rejects(
      client.fetchFiling(index, accession),
      (e) => e.code === "ACCESS_DENIED",
    );
    assert.equal(calls, 1);
    response = () =>
      new Response(html, {
        headers: { "content-type": "text/html; charset=shift_jis" },
      });
    await assert.rejects(
      client.fetchFiling(index, accession),
      (e) => e.code === "UNSUPPORTED_ENCODING",
    );
    response = () => Response.json({ error: "wrong body" });
    await assert.rejects(
      client.fetchFiling(index, accession),
      (e) => e.code === "UNSUPPORTED_FILING_FORMAT",
    );
    response = () =>
      new Response(html, { headers: { "content-type": "text/html" } });
    const first = await client.fetchFiling(index, accession);
    const changed = structuredClone(directory);
    changed.filings.recent.primaryDocument = ["other.htm"];
    const raw = JSON.stringify(changed);
    const { createHash } = await import("node:crypto");
    const second = await client.fetchFiling(
      { ...index, raw, hash: createHash("sha256").update(raw).digest("hex") },
      accession,
    );
    assert.equal(first.hash, second.hash);
    assert.notEqual(first.path, second.path);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
