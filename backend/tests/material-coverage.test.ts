import { it, expect } from 'vitest';
import { setup, human } from './helpers.js';
import { randomUUID } from 'node:crypto';
import { AssetService } from '../src/services/assets.js';
import { ArchiveService } from '../src/services/archive.js';
import { SearchRepository } from '../src/repositories/search.js';

it('粘贴材料的保存范围属于固定版本；省略时保持未知，不能推定为完整原文', () => {
  const a = setup(),
    restored = setup();
  try {
    a.write([
      {
        op: 'source.create',
        id: 's',
        data: { title: '作者原文', publisher: '', rights: 'authorized' },
      },
      {
        op: 'source.import',
        id: 'excerpt',
        sourceId: 's',
        text: '这只是原文的一段',
        retrievedAt: '2026-10-07T01:00:00Z',
        publishedAt: null,
        coverage: 'excerpt',
      },
      {
        op: 'source.import',
        id: 'unknown',
        sourceId: 's',
        text: '未说明范围的旧文本',
        retrievedAt: '2026-10-07T01:00:00Z',
        publishedAt: null,
      },
    ]);
    expect(a.get('excerpt').data).toMatchObject({ coverage: 'excerpt' });
    expect((a.get('unknown').data as any).coverage ?? 'unknown').toBe('unknown');
    expect(a.repo.history(a.project.id, 'excerpt')[0]?.data).toMatchObject({ coverage: 'excerpt' });
    expect(new AssetService(a.repo, a.service).summary(a.project.id)).toContain('保存范围：摘录');
    const archive = new AssetService(a.repo, a.service).export(a.project.id);
    new ArchiveService(restored.service, new SearchRepository(restored.repo)).import(
      human,
      randomUUID(),
      archive,
    );
    expect(restored.repo.snapshot(a.project.id)).toEqual(a.repo.snapshot(a.project.id));
  } finally {
    a.db.close();
    restored.db.close();
  }
});
