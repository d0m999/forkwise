import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectCompanyFactPassages, validateCompanyFactPassages } from '../src/index.js';

const row = (val, extra = {}) => ({
  start: '2025-01-01',
  end: '2025-03-31',
  val,
  filed: '2025-04-01',
  accn: '0000000001-25-000001',
  fy: 2025,
  fp: 'Q1',
  ...extra,
});
const fixture = (
  rows = [row(12), row(14, { accn: '0000000001-25-000002', filed: '2025-05-01' })],
) => ({
  cik: 1,
  entityName: '合成公司😀',
  facts: {
    'us-gaap': {
      'Synthetic/Metric~1': {
        label: 'Synthetic metric',
        description: '这是合成口径描述',
        units: { USD: rows, EUR: [row(9)] },
      },
      Unrelated: { label: 'unrelated', units: { shares: [row(100)] } },
    },
  },
});
const options = {
  queries: ['Synthetic metric'],
  maxCharacters: 20_000,
  expectedCik: '0000000001',
};

test('整条记录与主体/分类/科目/单位一并提取；同期间不同披露和单位均保留', () => {
  for (const pretty of [undefined, 2]) {
    const raw = JSON.stringify(fixture(), null, pretty),
      selected = selectCompanyFactPassages(raw, options);
    assert.equal(selected.records.length, 3);
    assert.equal(selected.matchedRecords, 3);
    assert.equal(selected.passages.filter((p) => p.structure.role === 'unit').length, 2);
    assert.ok(selected.records[0].pointer.includes('Synthetic~1Metric~01'));
    for (const p of selected.passages) assert.equal(raw.slice(p.start, p.end), p.text);
    assert.ok(selected.records.every((r) => r.gaps.some((g) => g.includes('单季或累计'))));
    assert.ok(!selected.passages.some((p) => p.text.includes('Unrelated')));
    validateCompanyFactPassages(raw, selected.passages, '1');
  }
});

test('原始数字词元、转义键和 UTF-16 位置保留；高精度数字不被重序列化', () => {
  const raw = JSON.stringify(fixture([row(12)]))
    .replace('"val":12', '"val":9007199254740993')
    .replace('Synthetic/Metric~1', 'Synthetic\\u002fMetric~1');
  const selected = selectCompanyFactPassages(raw, options);
  const fact = selected.passages.find((p) => p.structure.role === 'fact');
  assert.ok(fact.text.includes('9007199254740993'));
  assert.ok(selected.records[0].gaps.some((g) => g.includes('精度')));
  validateCompanyFactPassages(raw, selected.passages, '1');
  const changed = structuredClone(selected.passages);
  changed.find((p) => p.structure.role === 'unit').structure.pointer =
    '/facts/us-gaap/Unrelated/units/shares';
  assert.throws(() => validateCompanyFactPassages(raw, changed, '1'), /上下文|路径|绝对位置/);
});

test('字符预算不足不拆财务记录，也不单独留下脱离数值的上下文', () => {
  const raw = JSON.stringify(fixture());
  const none = selectCompanyFactPassages(raw, {
    ...options,
    maxCharacters: 10,
  });
  assert.equal(none.passages.length, 0);
  assert.equal(none.records.length, 0);
  assert.equal(none.budgetLimited, true);
  const one = selectCompanyFactPassages(raw, { ...options, maxRecords: 1 });
  assert.equal(one.records.length, 1);
  assert.equal(one.matchedRecords, 3);
  assert.equal(one.candidateLimitReached, true);
  validateCompanyFactPassages(raw, one.passages, '1');
  assert.throws(
    () =>
      validateCompanyFactPassages(
        raw,
        one.passages.filter((p) => p.structure.role !== 'unit'),
        '1',
      ),
    /上下文|路径/,
  );
});

test('缺失、错误期间与披露保留缺口；没有匹配不制造零值记录', () => {
  const raw = JSON.stringify(
    fixture([row(null, { filed: '2025-02-30', accn: '', end: '2024-01-01' })]),
  );
  const result = selectCompanyFactPassages(raw, options);
  assert.equal(result.records[0].gaps.length, 4);
  const missing = selectCompanyFactPassages(raw, {
    ...options,
    queries: ['NoSuchMetric'],
  });
  assert.equal(missing.passages.length, 0);
  assert.equal(missing.matchedRecords, 0);
  assert.throws(
    () => selectCompanyFactPassages(raw, { ...options, expectedCik: '2' }),
    (e) => e.code === 'SUBJECT_MISMATCH',
  );
});

test('重复键、结构错误与过深结构显式拒绝，不退回无上下文片段', () => {
  const raw = JSON.stringify(fixture());
  for (const bad of [
    raw.replace('"cik":1', '"cik":1,"cik":1'),
    '{',
    '{"cik":1,"facts":[]}',
    JSON.stringify({
      cik: 1,
      facts: { bad: { tag: { units: { USD: [4] } } } },
    }),
    '{"cik":1,"facts":{},"extra":' + '['.repeat(65) + '0' + ']'.repeat(65) + '}',
  ]) {
    assert.throws(
      () => selectCompanyFactPassages(bad, options),
      (e) => e.code === 'INVALID_COMPANYFACTS',
    );
  }
});

test('百万字符其他内容不会挤掉命中的科目父级与数值记录', () => {
  const data = fixture();
  const raw = JSON.stringify({ padding: 'x'.repeat(1_100_000), ...data });
  const result = selectCompanyFactPassages(raw, options);
  assert.equal(result.records.length, 3);
  assert.ok(result.passages.every((p) => p.start > 1_000_000));
  assert.ok(result.selectedCharacters < 20_000);
  assert.ok(!JSON.stringify(result).includes('x'.repeat(100)));
  validateCompanyFactPassages(raw, result.passages, '1');
});
