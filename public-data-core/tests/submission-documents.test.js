import { test } from "node:test";
import assert from "node:assert/strict";
import * as core from "../src/index.js";

const rawIndex = (rows, files = []) =>
  JSON.stringify({
    cik: 1,
    name: "Synthetic",
    filings: {
      recent: Object.fromEntries(
        [
          "accessionNumber",
          "primaryDocument",
          "form",
          "filingDate",
          "reportDate",
        ].map((key, i) => [key, rows.map((row) => row[i])]),
      ),
      files,
    },
  });
const row = (n, form, date, name = "report.htm") => [
  `0000000099-25-${String(n).padStart(6, "0")}`,
  name,
  form,
  date,
  "2025-03-31",
];
const filter = {
  expectedCik: "1",
  forms: ["10-Q"],
  filedFrom: "2025-04-01",
  filedThrough: "2025-04-30",
};

test("按明确类型和披露日期选报，区分修订版、业务期间与未读历史目录", () => {
  const selected = core.selectSubmissionDocuments(
    rawIndex(
      [
        row(1, "10-Q", "2025-04-01"),
        row(2, "10-Q/A", "2025-04-15"),
        row(3, "10-Q", "2025-05-01"),
        row(4, "8-K", "2025-04-30"),
        row(5, "10-Q", "2025-04-30"),
      ],
      [{ name: "CIK0000000001-submissions-001.json" }],
    ),
    filter,
  );
  assert.deepEqual(
    selected.documents.map((d) => d.accessionNumber),
    ["0000000099-25-000001", "0000000099-25-000005"],
  );
  assert.equal(
    selected.documents[1].recordPointer,
    "/filings/recent/accessionNumber/4",
  );
  assert.equal(selected.historyFileCount, 1);
  assert.ok(selected.gaps.some((g) => g.includes("历史")));
  assert.equal(selected.matchedRecords, 2);
  assert.deepEqual(selected.unavailable, []);
});

test("缺失日期、重复申报、非 HTML 及危险地址保留具体缺口，超预算不截取前几条", () => {
  const selected = core.selectSubmissionDocuments(
    rawIndex([
      row(1, "10-Q", "2025-04-01"),
      row(1, "10-Q", "2025-04-02"),
      row(2, "10-Q", ""),
      row(3, "10-Q", "2025-04-01", "../secret.htm"),
      row(4, "10-Q", "2025-04-01", "report.xml"),
      row(5, "10-Q", "2025-04-01"),
    ]),
    filter,
  );
  assert.equal(selected.matchedRecords, 5);
  assert.equal(selected.unavailable.length, 4);
  assert.equal(selected.documents.length, 1);
  assert.ok(selected.gaps.some((gap) => gap.includes("reportDate")));
  assert.throws(
    () =>
      core.selectSubmissionDocuments(
        rawIndex([row(1, "10-Q", "2025-04-01"), row(2, "10-Q", "2025-04-01")]),
        { ...filter, maxDocuments: 1 },
      ),
    (error) => error.code === "TOO_MANY_FILINGS",
  );
  for (const options of [
    { filedFrom: "2025-02-30" },
    { filedFrom: "2025-05-01" },
    { forms: [] },
    { forms: ["10-Q", "10-Q"] },
    { maxDocuments: 11 },
    { expectedCik: "2" },
  ])
    assert.throws(() =>
      core.selectSubmissionDocuments(rawIndex([row(1, "10-Q", "2025-04-01")]), {
        ...filter,
        ...options,
      }),
    );
  const mismatch = JSON.parse(rawIndex([row(1, "10-Q", "2025-04-01")]));
  mismatch.filings.recent.form.push("10-Q");
  assert.throws(
    () => core.selectSubmissionDocuments(JSON.stringify(mismatch), filter),
    /长度/,
  );
});
