import { it, expect } from 'vitest';
import { createApplication } from '../src/app.ts';
import { RequestJournal } from '../web/request-journal.js';
import { fileImportPlan, textResearchPlan } from '../web/research-entry-plans.js';

function memoryStore() {
  const rows = new Map();
  return {
    get: async (key) => structuredClone(rows.get(key) ?? null),
    change: async (key, fn) => {
      const value = fn(structuredClone(rows.get(key) ?? null));
      if (value === null) rows.delete(key);
      else rows.set(key, structuredClone(value));
      return structuredClone(value);
    },
  };
}
function fixture() {
  const origin = 'http://127.0.0.1:8787';
  const app = createApplication({ database: ':memory:', origin });
  const token = app.access.issue('human', ['*']);
  let lose = '';
  const posts = [];
  const api = async (path, method = 'GET', body, key) => {
    const response = await app.app.request(origin + '/api/v1' + path, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...(key ? { 'Idempotency-Key': key } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const result = await response.json();
    if (!response.ok) throw Object.assign(new Error(result.message), { code: result.code });
    if (method === 'POST') {
      posts.push({ path, key });
      if (path.endsWith(lose) && lose) {
        lose = '';
        throw new TypeError('响应丢失');
      }
    }
    return result.data;
  };
  return {
    app,
    api,
    posts,
    lose: (path) => {
      lose = path;
    },
  };
}
const textPlan = {
  label: '保存观点并研究',
  steps: [
    {
      endpoint: '/operations',
      body: {
        expected: {},
        commands: [
          {
            op: 'source.create',
            id: 'entry-source',
            data: { title: '合成观点', publisher: '', rights: 'authorized' },
          },
          {
            op: 'source.import',
            id: 'entry-version',
            sourceId: 'entry-source',
            text: '这是一条待研究观点。',
            coverage: 'excerpt',
            retrievedAt: '2026-01-01T00:00:00.000Z',
            publishedAt: null,
          },
        ],
      },
    },
    { endpoint: '/initial-research', body: { sourceVersionIds: ['entry-version'] } },
  ],
};
it('材料与首次研究响应丢失后，刷新恢复原请求且不重复创建', async () => {
  const f = fixture(),
    store = memoryStore();
  try {
    const project = await f.api('/projects', 'POST', { name: '入口恢复' }, 'entry-project');
    let journal = new RequestJournal(f.api, store);
    await journal.start(project.id, textPlan);
    f.lose('/operations');
    await expect(journal.resume(project.id)).rejects.toThrow('响应丢失');
    expect((await f.api(`/projects/${project.id}/state`)).objects).toHaveLength(2);
    await expect(journal.start(project.id, textPlan)).rejects.toThrow('恢复');
    await expect(journal.discard(project.id)).rejects.toThrow('未确认');
    journal = new RequestJournal(f.api, store);
    f.lose('/initial-research');
    await expect(journal.resume(project.id)).rejects.toThrow('响应丢失');
    journal = new RequestJournal(f.api, store);
    const result = await journal.resume(project.id);
    expect(result.state).toBe('completed');
    expect(
      (await f.api(`/projects/${project.id}/jobs`)).filter((j) => j.kind === 'workflow.initial'),
    ).toHaveLength(1);
    expect(f.posts.filter((p) => p.path.endsWith('/operations'))).toHaveLength(1);
    expect(f.posts.filter((p) => p.path.endsWith('/initial-research'))).toHaveLength(1);
    await journal.resume(project.id);
    expect((await f.api(`/projects/${project.id}/state`)).objects).toHaveLength(2);
  } finally {
    f.app.db.close();
  }
});
const draft = {
  title: '',
  publisher: '',
  url: '',
  rights: 'authorized',
  coverage: 'excerpt',
  text: '',
  publishedAt: '',
  queries: '',
  asOf: '',
};
it('文件入口把来源、原文件与解析排队作为一个事务，无效文件不留下空来源', async () => {
  const f = fixture();
  try {
    const p = await f.api('/projects', 'POST', { name: '原子文件导入' }, 'atomic-file-project');
    const source = { title: '原子材料', publisher: '', rights: 'authorized' };
    const file = {
      name: 'bad.pdf',
      mime: 'application/pdf',
      base64: btoa('not a PDF'),
      publishedAt: null,
    };
    await expect(
      f.api(`/projects/${p.id}/files/import`, 'POST', { source, file }, 'invalid-file-import'),
    ).rejects.toMatchObject({ code: 'MIME_MISMATCH' });
    expect((await f.api(`/projects/${p.id}/state`)).objects).toHaveLength(0);
    expect(await f.api(`/projects/${p.id}/jobs`)).toHaveLength(0);
    file.name = 'valid.html';
    file.mime = 'text/html';
    file.base64 = btoa('<html><body>Source text</body></html>');
    const result = await f.api(
      `/projects/${p.id}/files/import`,
      'POST',
      { source, file },
      'valid-file-import',
    );
    expect(result.changes.upserted).toHaveLength(1);
    expect(
      await f.api(`/projects/${p.id}/files/import`, 'POST', { source, file }, 'valid-file-import'),
    ).toEqual(result);
    expect((await f.api(`/projects/${p.id}/state`)).objects).toHaveLength(1);
    expect(await f.api(`/projects/${p.id}/jobs`)).toHaveLength(1);
  } finally {
    f.app.db.close();
  }
});
it('两个入口并发恢复同一请求不重复入库，过时入口不能继续另一个新请求', async () => {
  const f = fixture(),
    store = memoryStore();
  try {
    const p = await f.api('/projects', 'POST', { name: '并发恢复' }, 'concurrent-project');
    const a = new RequestJournal(f.api, store),
      b = new RequestJournal(f.api, store);
    const first = await a.start(p.id, textPlan);
    const results = await Promise.all([a.resume(p.id, first.id), b.resume(p.id, first.id)]);
    expect(results.every((r) => r.state === 'completed')).toBe(true);
    expect((await f.api(`/projects/${p.id}/state`)).objects).toHaveLength(2);
    expect(
      (await f.api(`/projects/${p.id}/jobs`)).filter((j) => j.kind === 'workflow.initial'),
    ).toHaveLength(1);
    const second = await b.start(p.id, textResearchPlan(draft, ['entry-version']));
    await expect(a.resume(p.id, first.id)).rejects.toThrow('已改变');
    expect((await b.get(p.id)).id).toBe(second.id);
    expect((await b.get(p.id)).cursor).toBe(0);
  } finally {
    f.app.db.close();
  }
});
it('文件成功响应丢失仍保存一次，解析文本可继续研究且保留原文件', async () => {
  const f = fixture(),
    store = memoryStore();
  try {
    const p = await f.api('/projects', 'POST', { name: '文件研究' }, 'file-project');
    const journal = new RequestJournal(f.api, store);
    const file = new File(
      ['<!doctype html><html><body><p>公司需求仍待观察。</p></body></html>'],
      '材料.html',
      { type: 'text/html' },
    );
    await journal.start(p.id, await fileImportPlan(draft, file));
    f.lose('/files/import');
    await expect(journal.resume(p.id)).rejects.toThrow('响应丢失');
    const result = await new RequestJournal(f.api, store).resume(p.id);
    await f.app.files.run(p.id, result.results.at(-1).job.id);
    const state = await f.api(`/projects/${p.id}/state`);
    const version = state.objects.find((e) => e.kind === 'source_version');
    expect(state.objects.filter((e) => e.kind === 'source')).toHaveLength(1);
    expect((await f.api(`/projects/${p.id}/materials/${version.id}`)).text).toContain(
      '公司需求仍待观察',
    );
    expect(f.posts.filter((e) => e.path.endsWith('/files/import'))).toHaveLength(1);
    await journal.start(p.id, textResearchPlan(draft, [version.id]));
    await journal.resume(p.id);
    expect(
      (await f.api(`/projects/${p.id}/jobs`)).filter((j) => j.kind === 'workflow.initial'),
    ).toHaveLength(1);
  } finally {
    f.app.db.close();
  }
});
it('明确拒绝可回到输入，已完成材料保留；另一个项目请求独立', async () => {
  const f = fixture(),
    store = memoryStore();
  try {
    const p = await f.api('/projects', 'POST', { name: '拒绝恢复' }, 'rejected-project');
    const other = await f.api('/projects', 'POST', { name: '独立项目' }, 'other-project');
    const journal = new RequestJournal(f.api, store),
      invalid = structuredClone(textPlan);
    invalid.steps[1].body = { sourceVersionIds: ['missing'] };
    await journal.start(p.id, invalid);
    await expect(journal.resume(p.id)).rejects.toThrow();
    expect((await journal.get(p.id)).state).toBe('rejected');
    expect((await journal.get(p.id)).cursor).toBe(1);
    await journal.start(other.id, textPlan);
    await journal.resume(other.id);
    await journal.discard(p.id);
    expect((await f.api(`/projects/${p.id}/state`)).objects).toHaveLength(2);
    expect(await journal.get(p.id)).toBeNull();
    expect((await journal.get(other.id)).state).toBe('completed');
  } finally {
    f.app.db.close();
  }
});
it('恢复存储失败不发送新请求；成功回执尚未写入本地时仍按未知结果保护', async () => {
  const f = fixture(),
    store = memoryStore();
  try {
    const p = await f.api('/projects', 'POST', { name: '存储失败' }, 'quota-project');
    const original = store.change;
    store.change = async () => {
      throw Object.assign(new Error('quota'), { code: 22 });
    };
    const journal = new RequestJournal(f.api, store);
    await expect(journal.start(p.id, textPlan)).rejects.toThrow('quota');
    expect((await f.api(`/projects/${p.id}/state`)).objects).toHaveLength(0);
    store.change = original;
    await journal.start(p.id, textPlan);
    let once = true;
    store.change = async (key, fn) =>
      original(key, (before) => {
        const next = fn(before);
        if (once && next.cursor > before.cursor) {
          once = false;
          throw Object.assign(new Error('quota'), { code: 22 });
        }
        return next;
      });
    await expect(journal.resume(p.id)).rejects.toThrow('quota');
    expect((await journal.get(p.id)).state).toBe('pending');
    await expect(journal.discard(p.id)).rejects.toThrow('未确认');
    await journal.resume(p.id);
    expect(f.posts.filter((e) => e.path.endsWith('/operations'))).toHaveLength(1);
  } finally {
    f.app.db.close();
  }
});
