import { afterEach, expect, it } from 'vitest';
import { openMapping } from '../src/mapping/storage.js';
import { compactFixture, closeCompactFixtures } from './compact-fixture.js';

afterEach(closeCompactFixtures);

it('当前查询按项目持久保存，实际服务重开后恢复且不增加搜索历史或研究历史', () => {
  const f = compactFixture();
  const before = f.mapping.read({ type: 'project', projectId: 'p' }, f.human);
  const history = f.mapping.read({ type: 'history', projectId: 'p' }, f.human);
  f.mapping.execute(
    {
      type: 'search.save',
      projectId: 'p',
      commandId: 'save-query',
      expected: null,
      payload: { query: { text: 'ETF 多頭', tagIds: [] } },
    },
    f.human,
  );
  f.mapping.close();
  const reopened = openMapping(f.directory);
  try {
    const state = reopened.read({ type: 'search.state', projectId: 'p' }, f.human);
    expect(state).toMatchObject({
      projectId: 'p',
      versionId: expect.any(String),
      current: { text: 'ETF 多頭', tagIds: [] },
      history: [],
    });
    expect(reopened.read({ type: 'project', projectId: 'p' }, f.human).project).toEqual(
      before.project,
    );
    expect(reopened.read({ type: 'history', projectId: 'p' }, f.human)).toEqual(history);
    reopened.execute(
      {
        type: 'project.create',
        projectId: 'q',
        commandId: 'other-project',
        expected: null,
        payload: { name: '独立地图' },
      },
      f.human,
    );
    expect(reopened.read({ type: 'search.state', projectId: 'q' }, f.human)).toMatchObject({
      current: { text: '', tagIds: [] },
      history: [],
    });
  } finally {
    reopened.close();
  }
});

it('历史按规范化完整条件去重保最新原写法，使用顺序超过20组只保留最近20组', () => {
  const f = compactFixture();
  let version: string | null = null;
  const record = (text: string, tagIds: string[] = []) => {
    const receipt = f.mapping.execute(
      {
        type: 'search.record',
        projectId: 'p',
        commandId: crypto.randomUUID(),
        expected: version,
        payload: { query: { text, tagIds }, intent: 'exit' },
      },
      f.human,
    );
    version = receipt.searchState!.versionId;
  };
  record('ETF 多头');
  record('  etf   多頭  ');
  let state = f.mapping.read({ type: 'search.state', projectId: 'p' }, f.human);
  expect(state.history.map((h) => h.query.text)).toEqual(['  etf   多頭  ']);
  record('“ETF 多頭”');
  record('"etf 多头"');
  state = f.mapping.read({ type: 'search.state', projectId: 'p' }, f.human);
  expect(state.history.map((h) => h.query.text)).toEqual(['"etf 多头"', '  etf   多頭  ']);
  for (let i = 0; i < 20; i++) record('query ' + i);
  expect(
    f.mapping
      .read({ type: 'search.state', projectId: 'p' }, f.human)
      .history.map((h) => h.query.text),
  ).toEqual(Array.from({ length: 20 }, (_, i) => 'query ' + (19 - i)));
});

it('清空历史保持条件且跨服务重开保护等价查询不在退出补回，明确打开或撤销恢复才重新出现', () => {
  const f = compactFixture();
  const query = { text: 'ETF 多头', tagIds: [] };
  let state = f.mapping.execute(
    {
      type: 'search.record',
      projectId: 'p',
      commandId: 'record',
      expected: null,
      payload: { query, intent: 'exit' },
    },
    f.human,
  ).searchState!;
  state = f.mapping.execute(
    {
      type: 'search.clear',
      projectId: 'p',
      commandId: 'clear',
      expected: state.versionId,
      payload: { query },
    },
    f.human,
  ).searchState!;
  expect(state).toMatchObject({ current: query, history: [], removed: { entries: [{ query }] } });
  const undoId = state.removed!.id;
  f.mapping.close();
  const reopened = openMapping(f.directory);
  try {
    state = reopened.read({ type: 'search.state', projectId: 'p' }, f.human);
    state = reopened.execute(
      {
        type: 'search.record',
        projectId: 'p',
        commandId: 'exit-equivalent',
        expected: state.versionId,
        payload: { query: { text: ' etf   多頭 ', tagIds: [] }, intent: 'exit' },
      },
      f.human,
    ).searchState!;
    expect(state.history).toEqual([]);
    state = reopened.execute(
      {
        type: 'search.restore',
        projectId: 'p',
        commandId: 'restore',
        expected: state.versionId,
        payload: { undoId },
      },
      f.human,
    ).searchState!;
    expect(state.history.map((h) => h.query.text)).toEqual(['ETF 多头']);
    state = reopened.execute(
      {
        type: 'search.clear',
        projectId: 'p',
        commandId: 'clear-again',
        expected: state.versionId,
        payload: { query },
      },
      f.human,
    ).searchState!;
    state = reopened.execute(
      {
        type: 'search.record',
        projectId: 'p',
        commandId: 'open',
        expected: state.versionId,
        payload: { query, intent: 'open' },
      },
      f.human,
    ).searchState!;
    expect(state.history.map((h) => h.query.text)).toEqual(['ETF 多头']);
  } finally {
    reopened.close();
  }
});

it('删除其它历史不抑制当前查询，删除当前历史只阻止等价条件退出补回且独立撤销不改变研究', () => {
  const f = compactFixture();
  const before = f.mapping.read({ type: 'history', projectId: 'p' }, f.human);
  let state = f.mapping.read({ type: 'search.state', projectId: 'p' }, f.human);
  const write = (type: string, payload: object) =>
    (state = f.mapping.execute(
      {
        type,
        projectId: 'p',
        commandId: crypto.randomUUID(),
        expected: state.versionId,
        payload,
      },
      f.human,
    ).searchState!);
  const query = { text: '当前', tagIds: [] };
  write('search.record', { query: { text: '其他', tagIds: [] }, intent: 'exit' });
  const other = state.history[0]!.id;
  write('search.record', { query, intent: 'exit' });
  write('search.delete', { query, id: other });
  write('search.record', { query, intent: 'exit' });
  expect(state.history.map((h) => h.query.text)).toEqual(['当前']);
  write('search.delete', { query, id: state.history[0]!.id });
  const undoId = state.removed!.id;
  write('search.record', { query, intent: 'exit' });
  expect(state.history).toEqual([]);
  write('search.restore', { undoId });
  expect(state.history.map((h) => h.query.text)).toEqual(['当前']);
  expect(f.mapping.read({ type: 'history', projectId: 'p' }, f.human)).toEqual(before);
});

it('搜索条件只引用本项目稳定标签，已删除标签保留可恢复引用且名称始终从同修订标签读取', async () => {
  const f = compactFixture();
  f.mapping.execute(
    {
      type: 'project.create',
      projectId: 'q',
      commandId: 'q',
      expected: null,
      payload: { name: '别的项目' },
    },
    f.human,
  );
  f.mapping.execute(
    {
      type: 'tag.create',
      projectId: 'q',
      commandId: 'foreign',
      expected: null,
      payload: { id: 'foreign', name: '不能引用' },
    },
    f.human,
  );
  expect(() =>
    f.mapping.execute(
      {
        type: 'search.save',
        projectId: 'p',
        commandId: 'bad-query',
        expected: null,
        payload: { query: { text: '', tagIds: ['foreign'] } },
      },
      f.human,
    ),
  ).toThrow('当前项目');
  expect(f.mapping.read({ type: 'search.state', projectId: 'p' }, f.human).versionId).toBeNull();
  f.mapping.execute(
    {
      type: 'tag.create',
      projectId: 'p',
      commandId: 'own',
      expected: null,
      payload: { id: 'own', name: '原名称' },
    },
    f.human,
  );
  f.mapping.execute(
    {
      type: 'search.record',
      projectId: 'p',
      commandId: 'query',
      expected: null,
      payload: { query: { text: '独立关键词', tagIds: ['own'] }, intent: 'exit' },
    },
    f.human,
  );
  const tag = f.mapping.read({ type: 'project', projectId: 'p' }, f.human).tags![0]!;
  f.mapping.execute(
    {
      type: 'tag.update',
      projectId: 'p',
      commandId: 'rename',
      expected: tag.versionId,
      payload: { id: tag.id, name: '新名称' },
    },
    f.human,
  );
  let state = f.mapping.read({ type: 'search.state', projectId: 'p' }, f.human);
  expect(state).toMatchObject({
    tags: [{ id: 'own', name: '新名称' }],
    history: [{ query: { text: '独立关键词', tagIds: ['own'] } }],
  });
  f.mapping.execute(
    {
      type: 'tag.delete',
      projectId: 'p',
      commandId: 'delete',
      expected: { tag: state.tags[0]!.versionId, cardTags: {} },
      payload: { id: tag.id },
    },
    f.human,
  );
  state = f.mapping.read({ type: 'search.state', projectId: 'p' }, f.human);
  expect(state.current.tagIds).toEqual(['own']);
  expect(state.tags[0]).toMatchObject({ name: '新名称', deleted: true });
  expect(
    await f.mapping.read({ type: 'search', projectId: 'p', ...state.current }, f.human),
  ).toMatchObject({ state: 'invalid_tags', invalidTagIds: ['own'], results: [] });
});

it('正常退出原样重放在途搜索请求后记录最后条件，幂等先于版本冲突且同事务拒绝跨项目与另页覆盖', () => {
  const f = compactFixture();
  const save = {
    type: 'search.save',
    projectId: 'p',
    commandId: 'inflight',
    expected: null,
    payload: { query: { text: '在途条件', tagIds: [] } },
  };
  f.mapping.execute(save, f.human);
  const exit = {
    type: 'search.record',
    projectId: 'p',
    commandId: 'leave',
    expected: null,
    payload: { query: { text: '最后条件', tagIds: [] }, intent: 'exit', pending: [save] },
  };
  const receipt = f.mapping.execute(exit, f.human);
  expect(receipt.searchState!.history.map((h) => h.query.text)).toEqual(['最后条件']);
  expect(f.mapping.execute(exit, f.human)).toEqual(receipt);
  expect(() =>
    f.mapping.execute(
      {
        ...exit,
        commandId: 'mismatch',
        payload: {
          ...exit.payload,
          pending: [{ ...save, payload: { query: { text: '变造请求', tagIds: [] } } }],
        },
      },
      f.human,
    ),
  ).toThrow('不同请求');
  const version = receipt.searchState!.versionId;
  const unsent = { ...save, commandId: 'unsent', expected: version };
  expect(() =>
    f.mapping.execute(
      {
        ...exit,
        commandId: 'foreign-exit',
        expected: version,
        payload: {
          ...exit.payload,
          pending: [unsent, { ...save, projectId: 'q', commandId: 'foreign' }],
        },
      },
      f.human,
    ),
  ).toThrow('当前项目');
  expect(f.mapping.read({ type: 'search.state', projectId: 'p' }, f.human)).toEqual(
    receipt.searchState,
  );
  const peer = f.mapping.execute(
    {
      ...save,
      commandId: 'peer',
      expected: version,
      payload: { query: { text: '另页条件', tagIds: [] } },
    },
    f.human,
  );
  expect(() => f.mapping.execute({ ...exit, commandId: 'stale-exit' }, f.human)).toThrow(
    '搜索记录已更新',
  );
  expect(f.mapping.read({ type: 'search.state', projectId: 'p' }, f.human)).toEqual(
    peer.searchState,
  );
});
