import { expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openMapping } from '../src/mapping/storage.js';

it('项目标签以中性色创建，忽略大小写复用并保留设置写法；重启和幂等不重复写历史', () => {
  const directory = mkdtempSync(join(tmpdir(), 'forkwise-tags-'));
  let mapping = openMapping(directory);
  const token = mapping.access.issue('human', ['*']);
  let actor = mapping.access.authenticate(token);
  const execute = (type: string, payload: object, expected: unknown = null, projectId = 'p', commandId: string = crypto.randomUUID()) =>
    mapping.execute({ commandId, projectId, type, expected, payload }, actor);
  try {
    execute('project.create', { name: '研究' });
    execute('project.create', { name: '另一个项目' }, null, 'q');
    const receipt = execute('tag.create', { id: 'ai', name: 'AI' }, null, 'p', 'new-ai');
    const state = mapping.read({ type: 'project', projectId: 'p' }, actor);
    expect(state).toMatchObject({ tags: [{ id: 'ai', name: 'AI', color: '#f1f0ec', deleted: false }] });
    expect(execute('tag.create', { id: 'unused', name: 'ai' }).changedIds).toEqual([]);
    expect(mapping.read({ type: 'project', projectId: 'p' }, actor)).toEqual(state);
    expect(mapping.read({ type: 'history', projectId: 'p' }, actor).undo.map(a => a.label)).toEqual(['tag.create']);
    execute('tag.create', { id: 'q-ai', name: 'ai' }, null, 'q');
    mapping.close(); mapping = openMapping(directory); actor = mapping.access.authenticate(token);
    expect(mapping.read({ type: 'project', projectId: 'p' }, actor)).toEqual(state);
    expect(execute('tag.create', { id: 'ai', name: 'AI' }, null, 'p', 'new-ai')).toEqual(receipt);
    expect(() => execute('tag.create', { id: 'different', name: 'AI' }, null, 'p', 'new-ai')).toThrow(/不同请求/);
    expect(mapping.observe({ projectId: 'p', afterRevision: 1 }, actor).changes).toHaveLength(1);
  } finally { mapping.close(); }
});
