import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as core from "../src/index.js";

const name = "CIK0000000001-submissions-001.json";
const root = {
  cik: 1,
  name: "Synthetic",
  filings: {
    recent: {},
    files: [
      {
        name,
        filingCount: 1,
        filingFrom: "2020-01-01",
        filingTo: "2020-12-31",
      },
      {
        name: "CIK0000000001-submissions-002.json",
        filingCount: 4,
        filingFrom: "2019-01-01",
        filingTo: "2019-12-31",
      },
    ],
  },
};
const history = {
  accessionNumber: ["0000000099-20-000001"],
  primaryDocument: ["old.htm"],
  form: ["10-K"],
  filingDate: ["2020-04-01"],
  reportDate: ["2019-12-31"],
};

test("仅选择日期范围重叠的已列历史文件，保存原始平铺 JSON 并按原位置取材、取得旧申报", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sec-history-")),
    calls = [];
  try {
    const client = new core.SecClient({
      userAgent: "Synthetic test@example.invalid",
      cacheDirectory: directory,
      request: async (url) => {
        calls.push(url);
        if (String(url).endsWith("CIK0000000001.json"))
          return Response.json(root);
        if (String(url).endsWith(name)) return Response.json(history);
        return new Response("<p>Old filing</p>", {
          headers: { "content-type": "text/html" },
        });
      },
    });
    const index = await client.fetch("1", "submissions");
    const selected = core.selectSubmissionHistory(index.raw, {
      expectedCik: "1",
      filedFrom: "2020-04-01",
      filedThrough: "2020-04-30",
    });
    assert.deepEqual(
      selected.files.map((file) => file.name),
      [name],
    );
    assert.equal(selected.excludedFiles, 1);
    const archived = await client.fetchHistory(index, name);
    assert.equal(archived.raw, JSON.stringify(history));
    assert.equal(archived.history.indexHash, index.hash);
    const passages = core.selectSubmissionPassages(archived.raw, {
      expectedCik: "1",
      history: true,
      queries: ["10-K"],
      maxCharacters: 80000,
    });
    assert.equal(passages.records[0].pointer, "/accessionNumber/0");
    for (const p of passages.passages)
      assert.equal(archived.raw.slice(p.start, p.end), p.text);
    core.validateSubmissionPassages(archived.raw, passages.passages, "1", {
      history: true,
    });
    const filing = await client.fetchFiling(
      archived,
      history.accessionNumber[0],
      { historyRoot: index },
    );
    assert.equal(filing.lineage.indexUrl, archived.url);
    assert.equal(filing.lineage.recordPointer, "/accessionNumber/0");
    assert.equal(calls.length, 3);
    await client.fetchHistory(index, name, { cachedHash: archived.hash });
    assert.equal(calls.length, 3);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("历史目录越界、重复、日期未知和预算分别处理，错误主体及目录变化不取得正文", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sec-history-invalid-"));
  let calls = 0;
  try {
    let reply = root;
    const client = new core.SecClient({
      userAgent: "Synthetic test@example.invalid",
      cacheDirectory: directory,
      request: async () => {
        calls++;
        return Response.json(reply);
      },
    });
    const index = await client.fetch("1", "submissions");
    for (const file of [
      "../secret.json",
      "CIK0000000002-submissions-001.json",
      "CIK0000000001-submissions-099.json",
    ])
      await assert.rejects(client.fetchHistory(index, file));
    assert.equal(calls, 1);
    reply = { ...history, filingDate: ["2021-01-01"] };
    await assert.rejects(
      client.fetchHistory(index, name),
      (error) => error.code === "HISTORY_INDEX_CHANGED",
    );
    reply = { ...history, form: [] };
    await assert.rejects(client.fetchHistory(index, name), /列长度/);
    reply = history;
    const saved = await client.fetchHistory(index, name);
    await assert.rejects(
      client.fetchFiling(saved, history.accessionNumber[0]),
      /父索引/,
    );
    const damaged = {
      ...saved,
      history: { ...saved.history, indexHash: "0".repeat(64) },
    };
    await assert.rejects(
      client.fetchFiling(damaged, history.accessionNumber[0], {
        historyRoot: index,
      }),
      /来历/,
    );
    const duplicate = structuredClone(root);
    duplicate.filings.files.push(duplicate.filings.files[0]);
    assert.throws(
      () => core.resolveSubmissionHistory(JSON.stringify(duplicate), "1", name),
      /恰好/,
    );
    const unknown = structuredClone(root);
    unknown.filings.files[0].filingFrom = "";
    const selected = core.selectSubmissionHistory(JSON.stringify(unknown), {
      expectedCik: "1",
      filedFrom: "2020-01-01",
      filedThrough: "2020-12-31",
    });
    assert.equal(selected.files.length, 0);
    assert.ok(selected.gaps.some((gap) => gap.includes("日期缺失")));
    assert.throws(
      () =>
        core.selectSubmissionHistory(index.raw, {
          expectedCik: "1",
          filedFrom: "2019-01-01",
          filedThrough: "2020-12-31",
          maxFiles: 1,
        }),
      (error) => error.code === "TOO_MANY_HISTORY_FILES",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
