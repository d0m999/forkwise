import { afterEach, expect, it, vi } from 'vitest';
import { openMapping } from '../src/mapping/storage.js';
import { readFile } from 'node:fs/promises';
import { compactFixture, closeCompactFixtures } from './compact-fixture.js';

afterEach(() => {
  vi.useRealTimers();
  closeCompactFixtures();
});

it('当前项目搜索要求所有完整词组在同一卡片命中，标题和正文可分别满足', async () => {
  const f = compactFixture();
  f.create('both', '多头开始平仓');
  f.create('partial', '多头仓位');
  f.create('split', '等待平仓');
  const card = f.mapping.read({ type: 'project', projectId: 'p' }, f.human).cards[2]!;
  f.mapping.execute(
    {
      type: 'thought.title',
      projectId: 'p',
      commandId: 'rename',
      expected: card.versionId,
      payload: { id: card.id, title: '多头观察' },
    },
    f.human,
  );
  const result = await f.mapping.read(
    { type: 'search', projectId: 'p', text: '多头 平仓' },
    f.human,
  );
  expect(result).toMatchObject({
    state: 'ready',
    query: { units: [{ text: '多头' }, { text: '平仓' }] },
  });
  expect(result.results.map((r) => r.cardId)).toEqual(['split', 'both']);
  expect(result.results[0]).toMatchObject({
    titleHits: [{ start: 0, end: 2 }],
    bodyHits: [{ start: 2, end: 4 }],
  });
});

it('真实中文分词和专业词典保留否定词，双引号与显式空白保持完整片段，字形匹配映回原文', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime('2026-01-01T00:00:00Z');
  const f = compactFixture();
  f.create('continuous', '😀多頭平倉 ＥＴＦ');
  f.create('separated', '多头开始平仓 ETF');
  f.create('negative', '尚未平仓，比特币资金费率');
  const search = (text: string) =>
    f.mapping.read({ type: 'search', projectId: 'p', text }, f.human);
  expect((await search('多头平仓')).results.map((r) => r.cardId)).toEqual([
    'continuous',
    'separated',
  ]);
  expect((await search('“多头平仓” etf')).results.map((r) => r.cardId)).toEqual(['continuous']);
  const exact = await search('"多头平仓"');
  expect(exact.results[0]!.bodyHits).toMatchObject([{ start: 2, end: 6 }]);
  expect(exact.results[0]!.segments[0]!.text.slice(2, 6)).toBe('多頭平倉');
  expect((await search('"多头平仓')).query.unclosedQuote).toBe(true);
  expect((await search('未平仓')).query.units.map((u) => u.text)).toEqual(['未', '平仓']);
  expect((await search('未平仓')).results.map((r) => r.cardId)).toEqual(['negative']);
  expect((await search('比特币资金费率')).query.units.map((u) => u.text)).toEqual([
    '比特币',
    '资金费率',
  ]);
  expect((await search('多头平仓 etf')).results.map((r) => r.cardId)).toEqual(['continuous']);
  expect((await search('“DeFi 收益”多头平仓')).query.units.map((u) => u.text)).toEqual([
    'DeFi 收益',
    '多头',
    '平仓',
  ]);
});

it('完整正文按块与单元格保留原文锚点，跨行内格式连续，重叠合并而紧邻命中各计一处', async () => {
  const f = compactFixture();
  f.create('rich', '');
  const card = f.mapping.read({ type: 'project', projectId: 'p' }, f.human).cards[0]!;
  f.mapping.execute(
    {
      type: 'asset.save',
      projectId: 'p',
      commandId: 'png',
      expected: null,
      payload: {
        id: 'png',
        name: '不索引文件名.png',
        mime: 'image/png',
        base64:
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==',
      },
    },
    f.human,
  );
  f.mapping.execute(
    {
      type: 'body.edit',
      projectId: 'p',
      commandId: 'rich-blocks',
      expected: card.body.versionId,
      payload: {
        id: card.id,
        blocks: [
          {
            id: 'paragraph',
            type: 'text',
            text: '多头平仓 多头平仓',
            marks: [
              { type: 'bold', start: 0, end: 1 },
              { type: 'link', start: 1, end: 4, value: 'https://example.com/隐藏地址' },
            ],
          },
          {
            id: 'table',
            type: 'table',
            header: false,
            rows: [
              [{ text: '表格命中' }, { text: '甲' }],
              [{ text: '乙' }, { text: '数据' }],
            ],
          },
          { id: 'code', type: 'code', language: 'text', wrap: false, text: '代码命中' },
          {
            id: 'image',
            type: 'image',
            assetId: 'png',
            name: '不索引文件名.png',
            mime: 'image/png',
            naturalWidth: 1,
            naturalHeight: 1,
            width: 200,
            caption: '图注命中',
            alt: '不索引替代文字',
          },
          { id: 'part1', type: 'text', text: '拼接' },
          { id: 'part2', type: 'text', text: '边界' },
        ],
      },
    },
    f.human,
  );
  const search = (text: string) =>
    f.mapping.read({ type: 'search', projectId: 'p', text }, f.human);
  expect((await search('表格命中 代码命中 图注命中')).results.map((r) => r.cardId)).toEqual([
    'rich',
  ]);
  const merged = (await search('平仓 "多头平仓" 平仓')).results[0]!;
  expect(merged.bodyHits).toEqual([
    { segment: 0, blockId: 'paragraph', start: 0, end: 4 },
    { segment: 0, blockId: 'paragraph', start: 5, end: 9 },
  ]);
  expect((await search('多头 平仓')).results[0]!.bodyHits).toHaveLength(4);
  expect(
    (await search('表格命中')).results[0]!.segments.find((s) => s.text === '表格命中'),
  ).toMatchObject({ blockId: 'table', row: 0, column: 0 });
  for (const text of ['"拼接\n边界"', '"甲\n乙"', '隐藏地址', '不索引文件名', '不索引替代文字'])
    expect((await search(text)).results).toEqual([]);
});

it('三档内按真实内容编辑时间排序，移动和阅读不刷新时间，标签取交集且删除条件阻止结果', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  const f = compactFixture();
  vi.setSystemTime('2026-01-01T00:00:00Z');
  f.create('a', '多头 平仓');
  vi.setSystemTime('2026-01-02T00:00:00Z');
  f.create('b', '多头 平仓');
  const state = () => f.mapping.read({ type: 'project', projectId: 'p' }, f.human);
  const run = (command: object) =>
    f.mapping.execute({ projectId: 'p', commandId: crypto.randomUUID(), ...command }, f.human);
  const search = (text = '', tagIds: string[] = []) =>
    f.mapping.read({ type: 'search', projectId: 'p', text, tagIds }, f.human);
  expect((await search()).results.map((r) => r.cardId)).toEqual(['b', 'a']);
  vi.setSystemTime('2026-01-03T00:00:00Z');
  run({
    type: 'pose.move',
    expected: state().cards[0]!.item.versionId,
    payload: { id: 'a', x: 100, y: 20 },
  });
  expect((await search()).results.map((r) => r.cardId)).toEqual(['b', 'a']);
  run({ type: 'tag.create', expected: null, payload: { id: 'tag', name: '标签' } });
  run({ type: 'card.tags', expected: null, payload: { id: 'a', tagIds: ['tag'] } });
  expect((await search('多头 平仓', ['tag'])).results.map((r) => r.cardId)).toEqual(['a']);
  expect(await search('多头 平仓', ['missing'])).toMatchObject({
    state: 'invalid_tags',
    invalidTagIds: ['missing'],
    results: [],
  });
  const beforeRead = state();
  await search();
  await search('平仓');
  expect(state()).toEqual(beforeRead);
  run({
    type: 'thought.title',
    expected: state().cards[0]!.versionId,
    payload: { id: 'a', title: '多头平仓' },
  });
  expect((await search('多头 平仓')).results[0]).toMatchObject({
    cardId: 'a',
    titleRank: 0,
    contentEditedAt: '2026-01-03T00:00:00.000Z',
  });
  const other = openMapping(f.directory);
  try {
    expect(
      await other.read({ type: 'search', projectId: 'p', text: '多头 平仓' }, f.human),
    ).toEqual(await search('多头 平仓'));
  } finally {
    other.close();
  }
  const current = state();
  run({
    type: 'tag.delete',
    expected: {
      tag: current.tags![0]!.versionId,
      cardTags: { a: current.cards[0]!.cardTags!.versionId },
    },
    payload: { id: 'tag' },
  });
  expect(await search('', ['tag'])).toMatchObject({
    state: 'invalid_tags',
    invalidTagIds: ['tag'],
    results: [],
  });
  run({ type: 'history.undo', expected: state().project.revision, payload: {} });
  expect((await search('', ['tag'])).results.map((r) => r.cardId)).toEqual(['a']);
});

it('真实库读取失败保留条件，显式降级不拆词放宽，重试实际重新读取并恢复完整分词', async () => {
  let missing = true;
  const f = compactFixture({
    searchAssetReader: async (url: URL) =>
      readFile(
        missing && url.pathname.endsWith('.wasm')
          ? new URL('missing-issue19.wasm', import.meta.url)
          : url,
      ),
  });
  f.create('continuous', '多头平仓');
  f.create('separated', '多头开始平仓');
  const query = { type: 'search' as const, projectId: 'p', text: '多头平仓', tagIds: [] };
  const failed = await f.mapping.read(query, f.human);
  expect(failed).toMatchObject({
    state: 'failed',
    query: { input: '多头平仓' },
    results: [],
    capabilities: { normalization: 'ready', segmentation: 'failed' },
  });
  const limited = await f.mapping.read({ ...query, literal: true }, f.human);
  expect(limited).toMatchObject({ state: 'degraded', query: { units: [{ text: '多头平仓' }] } });
  expect(limited.results.map((r) => r.cardId)).toEqual(['continuous']);
  missing = false;
  expect((await f.mapping.read(query, f.human)).state).toBe('failed');
  const recovered = await f.mapping.read({ ...query, retry: true }, f.human);
  expect(recovered.state).toBe('ready');
  expect(recovered.results.map((r) => r.cardId).sort()).toEqual(['continuous', 'separated']);
});

it('未闭合引号内的尾随空白仍须连续匹配，普通输入外部空白不阻止中文分词', async () => {
  const f = compactFixture();
  f.create('without', '多头');
  f.create('with', '多头 ');
  f.create('separated', '多头开始平仓');
  expect(
    (await f.mapping.read({ type: 'search', projectId: 'p', text: '"多头 ' }, f.human)).results.map(
      (card) => card.cardId,
    ),
  ).toEqual(['with']);
  expect(
    (
      await f.mapping.read({ type: 'search', projectId: 'p', text: '  多头平仓  ' }, f.human)
    ).results.map((card) => card.cardId),
  ).toEqual(['separated']);
});
