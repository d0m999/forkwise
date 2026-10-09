import { it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createApplication } from '../src/app.js';
import { AssetService } from '../src/services/assets.js';
import { ArchiveService } from '../src/services/archive.js';
import { ArchiveSchema } from '../src/contracts/assets.js';
import { human, agent, statement, inference } from './helpers.js';

function scenario(rights: 'public' | 'restricted' = 'public') {
  const a = createApplication({ database: ':memory:', origin: 'http://127.0.0.1:8787' });
  const p = a.write.createProject(human, randomUUID(), { name: '可迁移研究' });
  const write = (commands: unknown[], expected = {}) =>
    a.write.execute(p.id, human, randomUUID(), { commands, expected });
  write([
    statement('a', '原始观点'),
    statement('b'),
    inference('i', ['a'], 'b'),
    { op: 'source.create', id: 's', data: { title: '测试公开材料', publisher: '测试', rights } },
    {
      op: 'source.import',
      id: 'sv',
      sourceId: 's',
      text: '现金流增加',
      retrievedAt: '2026-01-01T00:00:00Z',
      publishedAt: null,
    },
    {
      op: 'evidence.create',
      id: 'e',
      data: { citation: { sourceVersionId: 'sv', start: 0, end: 5, quote: '现金流增加' } },
    },
  ]);
  const assets = new AssetService(a.repo, a.write);
  const judgment = assets.recordJudgment(p.id, human, randomUUID(), '第一轮判断');
  write([{ op: 'statement.edit', id: 'a', text: '改写后的观点', scope: 'all' }], { a: 1, i: 1 });
  return { a, p, assets, judgment, archive: ArchiveSchema.parse(assets.export(p.id)) };
}
it('导出后在隔离数据库导入，保留身份、全部历史与判断回放，并重新建立检索索引', () => {
  const s = scenario();
  const b = createApplication({ database: ':memory:', origin: 'http://127.0.0.1:8787' });
  try {
    const importer = new ArchiveService(b.write, b.search);
    const key = randomUUID();
    const result = importer.import(human, key, s.archive);
    expect(importer.import(human, key, s.archive)).toEqual(result);
    expect(b.repo.snapshot(s.p.id)).toEqual(s.a.repo.snapshot(s.p.id));
    expect(b.repo.history(s.p.id, 'a')).toEqual(s.a.repo.history(s.p.id, 'a'));
    expect(new AssetService(b.repo, b.write).judgment(s.p.id, s.judgment.id)).toEqual(s.judgment);
    expect(b.search.search(s.p.id, '改写后的观点').results).toHaveLength(1);
    expect(() => importer.import(human, randomUUID(), s.archive)).toThrow('身份已存在');
  } finally {
    s.a.db.close();
    b.db.close();
  }
});
it('原文篡改、伪造引用、断裂历史与跨项目对象均整批拒绝，不留下半个项目', () => {
  const s = scenario();
  const b = createApplication({ database: ':memory:', origin: 'http://127.0.0.1:8787' });
  try {
    const importer = new ArchiveService(b.write, b.search);
    for (const mutate of [
      (x: typeof s.archive) => {
        x.materials[0]!.text = '篡改原文';
      },
      (x: typeof s.archive) => {
        x.versions.shift();
      },
      (x: typeof s.archive) => {
        x.objects[0]!.projectId = 'another';
      },
      (x: typeof s.archive) => {
        x.judgments[0]!.refs = JSON.stringify([{ id: 'a', versionId: 'missing' }]);
      },
    ]) {
      const bad = structuredClone(s.archive);
      mutate(bad);
      expect(() => importer.import(human, randomUUID(), bad)).toThrow();
      expect(b.repo.listProjects()).toHaveLength(0);
    }
    expect(() => importer.import(agent, randomUUID(), s.archive)).toThrow('本人');
  } finally {
    s.a.db.close();
    b.db.close();
  }
});
it('受限材料导入保留索引与不可复核说明，不伪造原文或丢失历史', () => {
  const s = scenario('restricted');
  const b = createApplication({ database: ':memory:', origin: 'http://127.0.0.1:8787' });
  try {
    const result = new ArchiveService(b.write, b.search).import(human, randomUUID(), s.archive);
    expect(result.provenance.omissions).toEqual(['sv']);
    expect(() => b.repo.material(s.p.id, 'sv')).toThrow('材料版本不存在');
    expect(b.repo.history(s.p.id, 'e')[0]).toMatchObject({
      data: { citation: { quote: '', unavailableReason: 'rights' } },
    });
  } finally {
    s.a.db.close();
    b.db.close();
  }
});
