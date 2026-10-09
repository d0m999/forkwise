import { it, expect } from 'vitest';
import { createApplication } from '../src/app.js';
import { human, statement } from './helpers.js';
import { AssetService } from '../src/services/assets.js';

it('画布文字转卡与原图删除原子提交；布局冲突时不遗留新主张，重试不复制对象', () => {
  const app = createApplication({ database: ':memory:', origin: 'http://127.0.0.1:8787' });
  try {
    const p = app.write.createProject(human, 'canvas-create-project', { name: '画布事务' }),
      assets = new AssetService(app.repo, app.write);
    const canvas = {
      scenes: {},
      annotations: {
        elements: [{ id: 'drawing', type: 'text', x: 5, y: 5, text: '待研究' }],
        files: {},
      },
    };
    assets.saveLayout(p.id, human, 'canvas-drawing', {
      expectedVersion: 0,
      data: { positions: {}, drawings: [], canvas },
    });
    const input = {
      expected: {},
      commands: [statement('node', '待研究')],
      layout: {
        expectedVersion: 0,
        data: {
          positions: { node: { x: 5, y: 5 } },
          drawings: [],
          canvas: { ...canvas, annotations: { elements: [], files: {} } },
        },
      },
    };
    expect(() => app.write.execute(p.id, human, 'canvas-stale', input)).toThrow('布局已变化');
    expect(app.repo.snapshot(p.id).objects).toHaveLength(0);
    input.layout.expectedVersion = 1;
    const result = app.write.execute(p.id, human, 'canvas-convert', input);
    expect(result.layout?.version).toBe(2);
    expect(result.layout?.data.canvas?.annotations.elements).toHaveLength(0);
    expect(app.write.execute(p.id, human, 'canvas-convert', input)).toEqual(result);
    expect(app.repo.snapshot(p.id).objects).toHaveLength(1);
    const removed = app.write.execute(p.id, human, 'canvas-delete', {
      expected: { node: 1 },
      commands: [{ op: 'object.delete', id: 'node' }],
    });
    expect(removed.layout?.data.positions).toEqual({});
  } finally {
    app.db.close();
  }
});

it('Agent 改写参考对象不记录为本人采用，独立复制有固定版本来历', () => {
  const app = createApplication({ database: ':memory:', origin: 'http://127.0.0.1:8787' });
  try {
    const p = app.write.createProject(human, 'agent-reference-project', { name: '归属边界' }),
      candidate = statement('a', 'AI 候选');
    if (candidate.op !== 'statement.create') throw new Error('fixture');
    candidate.data.origin = 'ai';
    candidate.data.participation = 'candidate';
    app.write.execute(p.id, human, 'agent-reference-create', {
      expected: {},
      commands: [candidate],
    });
    const agent = { id: 'test-agent', type: 'agent' as const };
    const edit = app.write.execute(p.id, agent, 'agent-reference-edit', {
      expected: { a: 1 },
      commands: [{ op: 'statement.edit', id: 'a', text: '改写候选', scope: 'all' }],
    });
    expect(edit.upserted[0]?.data).toMatchObject({
      participation: 'candidate',
      stance: { value: 'pending' },
    });
    const copied = app.write.execute(p.id, human, 'human-copy-reference', {
      expected: { a: 2 },
      commands: [{ op: 'statement.copy', id: 'a', newId: 'b' }],
    });
    expect(copied.upserted[0]?.data).toMatchObject({
      origin: 'ai',
      participation: 'personal',
      lineage: { id: 'a', versionId: edit.upserted[0]?.versionId },
      stance: { value: 'pending' },
    });
  } finally {
    app.db.close();
  }
});
it('布局不能覆盖研究投影或伪造其内容，Agent 不能替换本人编辑草稿', () => {
  const app = createApplication({ database: ':memory:', origin: 'http://127.0.0.1:8787' });
  try {
    const p = app.write.createProject(human, 'canvas-security-project', { name: '显示边界' });
    app.write.execute(p.id, human, 'canvas-security-statement', {
      expected: {},
      commands: [statement('a', '当前主张')],
    });
    const canvas = {
      scenes: { mine: { styles: {} } },
      annotations: { elements: [], files: {} },
      drafts: { mine: { id: 'a', text: '尚未采用的想法' } },
    };
    const assets = new AssetService(app.repo, app.write);
    assets.saveLayout(p.id, human, 'human-editor-draft', {
      expectedVersion: 0,
      data: { positions: {}, drawings: [], canvas },
    });
    const injected = structuredClone(canvas);
    injected.drafts.mine.text = 'Agent 冒充用户草稿';
    expect(() =>
      assets.saveLayout(p.id, { id: 'agent', type: 'agent' }, 'agent-draft-injection', {
        expectedVersion: 1,
        data: { positions: {}, drawings: [], canvas: injected },
      }),
    ).toThrow('编辑草稿');
    expect(() =>
      assets.saveLayout(p.id, human, 'domain-style-injection', {
        expectedVersion: 1,
        data: {
          positions: {},
          drawings: [],
          canvas: { ...canvas, scenes: { mine: { styles: { a: { text: '虚假显示' } } } } },
        },
      }),
    ).toThrow();
    expect(assets.layout(p.id).version).toBe(1);
    expect(app.repo.snapshot(p.id).objects[0]?.data).toMatchObject({ text: '当前主张' });
  } finally {
    app.db.close();
  }
});
