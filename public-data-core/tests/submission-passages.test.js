import { test } from "node:test";
import assert from "node:assert/strict";
import {
  selectSubmissionPassages,
  validateSubmissionPassages,
} from "../src/index.js";
const fixture = () => ({
  cik: "0000000001",
  name: "合成主体😀",
  tickers: ["SYN"],
  exchanges: ["Synthetic"],
  filings: {
    recent: {
      accessionNumber: [
        "0000000999-25-000001",
        "0000000999-25-000002",
        "0000000999-25-000003",
      ],
      filingDate: ["2025-04-01", "2025-05-01", "2025-06-01"],
      reportDate: ["2025-03-31", "2025-03-31", ""],
      acceptanceDateTime: [
        "2025-04-01T12:00:00.000Z",
        "2025-05-01T12:00:00.000Z",
        "2025-06-01T12:00:00.000Z",
      ],
      form: ["10-Q", "10-Q/A", "8-K"],
      primaryDocument: ["synthetic.htm", "amendment.htm", "event.htm"],
      primaryDocDescription: [
        "Synthetic quarterly",
        "Synthetic amended quarterly",
        "Synthetic event",
      ],
      size: [1200, 1400, 400],
      isXBRL: [1, 1, 0],
    },
    files: [
      {
        name: "CIK0000000001-submissions-001.json",
        filingCount: 30,
        filingFrom: "2020-01-01",
        filingTo: "2022-12-31",
      },
    ],
  },
});
const options = { queries: ["10-Q"], maxCharacters: 20_000, expectedCik: "1" };
test("列式申报按同一行完整选取，保留修订版、主体与原始定位，不把索引当正文", () => {
  for (const pretty of [undefined, 2]) {
    const raw = JSON.stringify(fixture(), null, pretty),
      result = selectSubmissionPassages(raw, options);
    assert.equal(result.method, "sec_submissions_v1");
    assert.equal(result.matchedRecords, 2);
    assert.equal(result.records.length, 2);
    assert.equal(result.historyFileCount, 1);
    assert.equal(
      result.selectedCharacters,
      result.passages.reduce((n, p) => n + p.text.length, 0),
    );
    assert.match(result.gaps.join(""), /历史.*未.*读取/);
    assert.match(result.gaps.join(""), /正文.*未/);
    for (const p of result.passages)
      assert.equal(raw.slice(p.start, p.end), p.text);
    for (const r of result.records) {
      const fields = result.passages.filter(
        (p) => p.structure.recordPointer === r.pointer,
      );
      assert.equal(fields.length, 9);
      assert.ok(fields.every((p) => p.structure.pointer.endsWith("/" + r.row)));
      assert.ok(
        fields.some(
          (p) =>
            p.structure.role === "filing" &&
            JSON.parse(p.text) === r.accessionNumber,
        ),
      );
      assert.match(
        r.documentUrl,
        /^https:\/\/www\.sec\.gov\/Archives\/edgar\/data\/1\/00000009992500000[12]\//,
      );
      assert.match(r.gaps.join(""), /期间/);
    }
    assert.ok(
      result.passages.some(
        (p) => p.structure.role === "subject" && p.text.includes("合成主体"),
      ),
    );
    validateSubmissionPassages(raw, result.passages, "0000000001");
  }
});
test("匹配只发生在申报同一行，不能把不同列不同行拼成一条申报", () => {
  const raw = JSON.stringify(fixture());
  const selected = selectSubmissionPassages(raw, {
    ...options,
    queries: ["2025-05-01"],
  });
  assert.equal(selected.records.length, 1);
  assert.equal(selected.records[0].row, 1);
  assert.ok(
    selected.passages.some(
      (p) =>
        p.structure.pointer === "/filings/recent/form/1" &&
        p.text === '"10-Q/A"',
    ),
  );
  const no = selectSubmissionPassages(raw, {
    ...options,
    queries: ["不存在的指标"],
  });
  assert.equal(no.matchedRecords, 0);
  assert.equal(no.passages.length, 0);
  assert.equal(no.historyFileCount, 1);
});
test("完整行与上下文作为预算单位，不截断某个字段；候选数和字符预算分别报告", () => {
  const raw = JSON.stringify(fixture());
  const one = selectSubmissionPassages(raw, { ...options, maxRecords: 1 });
  assert.equal(one.records.length, 1);
  assert.equal(one.matchedRecords, 2);
  assert.equal(one.candidateLimitReached, true);
  const tiny = selectSubmissionPassages(raw, { ...options, maxCharacters: 4 });
  assert.equal(tiny.passages.length, 0);
  assert.equal(tiny.budgetLimited, true);
  validateSubmissionPassages(raw, one.passages, "1");
});
test("恢复前逐一验证角色、行归属和完整列上下文；不接受未给模型的字段引用", () => {
  const raw = JSON.stringify(fixture()),
    result = selectSubmissionPassages(raw, options);
  for (const mutate of [
    (p) => p.pop(),
    (p) => {
      p.find(
        (v) => v.structure.role === "filing_field",
      ).structure.recordPointer = "/filings/recent/accessionNumber/2";
    },
    (p) => {
      p.find((v) => v.structure.role === "filing_field").structure.pointer =
        "/filings/recent/form/2";
    },
    (p) => {
      p[0].start++;
    },
    (p) => {
      p.push(p[0]);
    },
    (p) => {
      p[0].structure.format = "sec_companyfacts_v1";
    },
  ]) {
    const damaged = structuredClone(result.passages);
    mutate(damaged);
    assert.throws(
      () => validateSubmissionPassages(raw, damaged, "1"),
      (e) => e.code === "INVALID_SUBMISSIONS",
    );
  }
});
test("列缺失、列长错位、重复键、异常主体和层级结构拒绝，不退回普通窗口", () => {
  const good = fixture();
  for (const corrupt of [
    (v) => {
      v.filings.recent.form.pop();
    },
    (v) => {
      v.filings.recent.form = "10-Q";
    },
    (v) => {
      delete v.filings.recent.accessionNumber;
    },
    (v) => {
      v.filings.recent = null;
    },
    (v) => {
      v.filings.files = "invalid";
    },
  ]) {
    const damaged = structuredClone(good);
    corrupt(damaged);
    assert.throws(
      () => selectSubmissionPassages(JSON.stringify(damaged), options),
      (e) => e.code === "INVALID_SUBMISSIONS",
    );
  }
  assert.throws(
    () =>
      selectSubmissionPassages(
        JSON.stringify(good).replace(
          '"cik":"0000000001"',
          '"cik":"0000000002"',
        ),
        options,
      ),
    (e) => e.code === "SUBJECT_MISMATCH",
  );
  assert.throws(
    () =>
      selectSubmissionPassages(
        '{"cik":1,"cik":1,"filings":{"recent":{}}}',
        options,
      ),
    /重复键/,
  );
});
test("缺失日期、期间或无效文件名保留原词元和缺口，不生成危险跳转或伪造日期", () => {
  const v = fixture();
  v.filings.recent.filingDate[0] = "2025-02-30";
  v.filings.recent.reportDate[0] = "";
  v.filings.recent.primaryDocument[0] = "../../outside.htm";
  const r = selectSubmissionPassages(JSON.stringify(v), {
    ...options,
    queries: ["0000000999-25-000001"],
  });
  assert.equal(r.records[0].documentUrl, null);
  assert.match(r.records[0].gaps.join(""), /披露日期/);
  assert.match(r.records[0].gaps.join(""), /期间/);
  assert.match(r.records[0].gaps.join(""), /文件名/);
  assert.ok(r.passages.some((p) => p.text === '"2025-02-30"'));
  for (const bad of [
    "https://outside.invalid/a",
    "%2e%2e/file.htm",
    "../a",
    "a?x=1",
    "a#part",
  ]) {
    v.filings.recent.primaryDocument[0] = bad;
    assert.equal(
      selectSubmissionPassages(JSON.stringify(v), options).records[0]
        .documentUrl,
      null,
    );
  }
});
test("空 recent 明确零匹配；百万字符前文不改变绝对位置，索引安全边界与旧财务解析一致", () => {
  const raw = JSON.stringify({
    cik: 1,
    name: "空样例",
    filings: { recent: {}, files: [] },
  });
  assert.equal(selectSubmissionPassages(raw, options).passages.length, 0);
  const v = { padding: "x".repeat(1_100_000), ...fixture() };
  const r = selectSubmissionPassages(JSON.stringify(v), options);
  assert.ok(r.passages.every((p) => p.start > 1_100_000));
  assert.throws(
    () => selectSubmissionPassages(" ".repeat(5_000_001), options),
    /边界/,
  );
  assert.throws(
    () => selectSubmissionPassages(raw, { ...options, queries: [] }),
    /有界/,
  );
});
