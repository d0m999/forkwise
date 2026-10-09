import { describe, it, expect } from 'vitest';
import { createApplication } from '../src/app.js';
import { AssetService } from '../src/services/assets.js';
import { GraphWriteService } from '../src/services/graph-write.js';
import { statement, human } from './helpers.js';

describe('项目检索与历史资产', () => {
  it('中文短词、全文及向量检索均隔离项目，删除内容不再进入当前结果', () => {
    const t = createApplication({ database: ':memory:', origin: 'http://127.0.0.1:8787' });
    try {
      const a = t.write.createProject(human, 'project-a', { name: 'A' });
      const b = t.write.createProject(human, 'project-b', { name: 'B' });
      t.write.execute(a.id, human, 'write-a1', {
        expected: {},
        commands: [statement('a', '营收增长具有持续性')],
      });
      t.write.execute(b.id, human, 'write-b1', {
        expected: {},
        commands: [statement('b', '营收增长：另一个项目的私密结论')],
      });
      const results = t.search.search(a.id, '营收').results;
      expect(results).toHaveLength(1);
      expect(results[0]?.entityId).toBe('a');
      expect(t.search.search(a.id, '营收增长').results).toHaveLength(1);
      t.search.embed(a.id, results[0]!.chunkId, 'test-model-v1', [1, 0]);
      expect(
        t.search.search(a.id, '没有字面匹配', undefined, { model: 'test-model-v1', values: [1, 0] })
          .mode,
      ).toBe('hybrid');
      expect(() => t.search.embed(b.id, results[0]!.chunkId, 'test-model-v1', [1, 0])).toThrow(
        '不属于',
      );
      t.write.execute(a.id, human, 'delete-a1', {
        expected: { a: 1 },
        commands: [{ op: 'object.delete', id: 'a' }],
      });
      expect(t.search.search(a.id, '营收').results).toEqual([]);
    } finally {
      t.db.close();
    }
  });
  it('历史查询不倒灌新内容；记录判断后修改不会改变回放', () => {
    const t = createApplication({ database: ':memory:', origin: 'http://127.0.0.1:8787' });
    try {
      const p = t.write.createProject(human, 'project-key', { name: '历史研究' });
      let now = '2026-01-01T00:00:00.000Z';
      const writer = new GraphWriteService(
        t.repo,
        () => now,
        (c, changed) => t.search.index(changed, c.texts),
      );
      writer.execute(p.id, human, 'write-old', {
        expected: {},
        commands: [statement('a', '旧观点营收增长')],
      });
      const assets = new AssetService(t.repo, writer);
      const judgment = assets.recordJudgment(p.id, human, 'record-key', '当时判断');
      now = '2026-02-01T00:00:00.000Z';
      writer.execute(p.id, human, 'write-new', {
        expected: { a: 1 },
        commands: [{ op: 'statement.edit', id: 'a', scope: 'all', text: '新观点营收下降' }],
      });
      expect(t.search.search(p.id, '营收', '2026-01-15T00:00:00.000Z').results[0]?.text).toContain(
        '旧观点',
      );
      expect(t.search.search(p.id, '营收').results[0]?.text).toContain('新观点');
      expect(assets.judgment(p.id, judgment.id).objects[0]?.data).toMatchObject({
        text: '旧观点营收增长',
      });
      const before = t.repo.history(p.id, 'a');
      assets.judgment(p.id, judgment.id);
      expect(t.repo.history(p.id, 'a')).toEqual(before);
    } finally {
      t.db.close();
    }
  });
  it('布局独立保存，不生成内容版本，过期布局拒绝覆盖', () => {
    const t = createApplication({ database: ':memory:', origin: 'http://127.0.0.1:8787' });
    try {
      const p = t.write.createProject(human, 'project-key', { name: '布局研究' });
      t.write.execute(p.id, human, 'write-key', { expected: {}, commands: [statement('a')] });
      const assets = new AssetService(t.repo, t.write);
      const before = t.repo.snapshot(p.id);
      assets.saveLayout(p.id, human, 'layout-key', {
        expectedVersion: 0,
        data: { positions: { a: { x: 1, y: 2 } }, drawings: [] },
      });
      expect(t.repo.snapshot(p.id)).toEqual(before);
      expect(() =>
        assets.saveLayout(p.id, human, 'layout-stale', {
          expectedVersion: 0,
          data: { positions: {}, drawings: [] },
        }),
      ).toThrow('布局已变化');
    } finally {
      t.db.close();
    }
  });
  it('受限原文不通过材料、证据或旧版本导出泄漏', () => {
    const t = createApplication({ database: ':memory:', origin: 'http://127.0.0.1:8787' });
    try {
      const p = t.write.createProject(human, 'project-key', { name: '权利测试' });
      const text = '独有受限原文';
      t.write.execute(p.id, human, 'source-key', {
        expected: {},
        commands: [
          {
            op: 'source.create',
            id: 's',
            data: { title: '索引保留', publisher: '', rights: 'restricted' },
          },
          {
            op: 'source.import',
            id: 'sv',
            sourceId: 's',
            text,
            retrievedAt: '2025-01-01T00:00:00Z',
            publishedAt: null,
          },
          {
            op: 'evidence.create',
            id: 'e',
            data: { citation: { sourceVersionId: 'sv', start: 0, end: text.length, quote: text } },
          },
        ],
      });
      const exported = new AssetService(t.repo, t.write).export(p.id);
      expect(JSON.stringify(exported)).not.toContain(text);
      expect(JSON.stringify(exported)).toContain('rights');
      expect(t.repo.material(p.id, 'sv')).toBe(text);
    } finally {
      t.db.close();
    }
  });
});
