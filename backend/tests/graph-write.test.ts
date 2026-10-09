import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agent, human, inference, setup, statement } from './helpers.js';
import { openDatabase } from '../src/repositories/database.js';
import { ResearchRepository } from '../src/repositories/research.js';
import { GraphWriteService } from '../src/services/graph-write.js';

describe('图谱业务写入与真实 SQLite', () => {
  it('同文本保持独立身份，同端点不同理由允许存在；一项推导一个结论', () => {
    const t = setup();
    try {
      const change = t.write([
        statement('a', '相同'),
        statement('b', '相同'),
        inference('i', ['a'], 'b'),
        inference('j', ['a'], 'b', '另一个理由'),
      ]);
      expect(change.upserted).toHaveLength(4);
      expect(change.revisionAfter).toBe(1);
      expect(t.repo.snapshot(t.project.id).objects).toHaveLength(4);
    } finally {
      t.db.close();
    }
  });
  it('循环、悬空或后一条失败使整批回滚，包括版本和项目修订号', () => {
    const t = setup();
    try {
      t.write([statement('a'), statement('b'), inference('i', ['a'], 'b')]);
      const before = t.repo.snapshot(t.project.id);
      expect(() => t.write([statement('c'), inference('j', ['b'], 'a')])).toThrow('循环');
      expect(t.repo.snapshot(t.project.id)).toEqual(before);
      expect(() => t.write([inference('x', ['missing'], 'a')])).toThrow('不存在');
    } finally {
      t.db.close();
    }
  });
  it('无关联对象并行保存，旧目标或缺失关联版本拒绝且不部分修改', () => {
    const t = setup();
    try {
      t.write([statement('a'), statement('b')]);
      t.write([{ op: 'statement.edit', id: 'a', text: '新 A', scope: 'all' }], { a: 1 });
      t.write([{ op: 'statement.edit', id: 'b', text: '新 B', scope: 'all' }], { b: 1 });
      expect(() =>
        t.write([{ op: 'statement.edit', id: 'a', text: '旧写入', scope: 'all' }], { a: 1 }),
      ).toThrow('已经改变');
      t.write([inference('i', ['a'], 'b')]);
      expect(() =>
        t.write([{ op: 'statement.edit', id: 'a', text: '新 A2', scope: 'all' }], { a: 2 }),
      ).toThrow('相关对象');
    } finally {
      t.db.close();
    }
  });
  it('局部派生只改接选定下游，不复制上游和旧证据，保留原版本来历', () => {
    const t = setup();
    try {
      t.write([
        statement('a'),
        statement('b'),
        statement('c'),
        statement('d'),
        inference('upstream', ['d'], 'a'),
        inference('i', ['a'], 'b'),
        inference('j', ['a'], 'c'),
      ]);
      const original = t.get('a');
      const result = t.write(
        [
          {
            op: 'statement.derive',
            id: 'a',
            newId: 'new_a',
            text: '另一假设',
            inferenceIds: ['i'],
          },
        ],
        { a: 1, i: 1 },
      );
      expect(result.upserted.map((e) => e.id).sort()).toEqual(['i', 'new_a']);
      expect(t.get('new_a').data).toMatchObject({
        lineage: { id: 'a', versionId: original.versionId },
        citations: [],
      });
      expect(t.get('a')).toEqual(original);
      expect(t.get('j').data).toMatchObject({ premiseIds: ['a'] });
      expect(t.get('upstream').data).toMatchObject({ conclusionId: 'a' });
    } finally {
      t.db.close();
    }
  });
  it('同键重试返回同结果，不同请求拒绝；无变化不产生版本', () => {
    const t = setup();
    try {
      const commands = [statement('a')];
      const first = t.write(commands, {}, human, 'operation-key');
      expect(t.write(commands, {}, human, 'operation-key')).toEqual(first);
      expect(() => t.write([statement('b')], {}, human, 'operation-key')).toThrow('不同请求');
      const noOp = t.write([{ op: 'statement.edit', id: 'a', text: 'a', scope: 'all' }]);
      expect(noOp.upserted).toEqual([]);
      expect(noOp.revisionAfter).toBe(first.revisionAfter);
      expect(t.repo.history(t.project.id, 'a')).toHaveLength(1);
    } finally {
      t.db.close();
    }
  });
  it('立场需要本人；内容修改重置当前立场，保留其旧历史', () => {
    const t = setup();
    try {
      t.write([statement('a')]);
      const content = t.get('a').contentVersionId;
      expect(() =>
        t.write(
          [{ op: 'stance.set', id: 'a', stance: { value: 'accepted', reason: '' } }],
          t.versions(),
          agent,
        ),
      ).toThrow('本人');
      t.write([{ op: 'stance.set', id: 'a', stance: { value: 'accepted', reason: '' } }]);
      expect(t.get('a').contentVersionId).toBe(content);
      t.write([{ op: 'statement.edit', id: 'a', text: '修订', scope: 'all' }]);
      expect(t.get('a').data).toMatchObject({ stance: { value: 'pending' } });
      expect(t.repo.history(t.project.id, 'a')[1]?.data).toMatchObject({
        stance: { value: 'accepted' },
      });
    } finally {
      t.db.close();
    }
  });
  it('删除返回全部连带删除，旧版本仍可追溯', () => {
    const t = setup();
    try {
      t.write([statement('a'), statement('b'), inference('i', ['a'], 'b')]);
      expect(() => t.write([{ op: 'object.delete', id: 'a' }], { a: 1 })).toThrow('相关对象');
      const result = t.write([{ op: 'object.delete', id: 'a' }]);
      expect(result.deletedIds.sort()).toEqual(['a', 'i']);
      expect(t.get('b')).toBeDefined();
      expect(t.repo.history(t.project.id, 'a')).toHaveLength(2);
    } finally {
      t.db.close();
    }
  });
  it('独立数据库连接复核并发版本；重启保留数据与幂等结果', () => {
    const dir = mkdtempSync(join(tmpdir(), 'forkwise-test-'));
    const path = join(dir, 'research.sqlite');
    const t = setup(path);
    let db2;
    try {
      t.write([statement('a')]);
      db2 = openDatabase(path);
      const second = new GraphWriteService(new ResearchRepository(db2));
      t.write(
        [{ op: 'statement.edit', id: 'a', text: '已保存', scope: 'all' }],
        { a: 1 },
        human,
        'persistent-key',
      );
      expect(() =>
        second.execute(t.project.id, human, 'competing-key', {
          expected: { a: 1 },
          commands: [{ op: 'statement.edit', id: 'a', text: '过期', scope: 'all' }],
        }),
      ).toThrow('已经改变');
      expect(second.operation(t.project.id, human, 'persistent-key')).toMatchObject({
        revisionAfter: 2,
      });
    } finally {
      db2?.close();
      t.db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
