import { it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { createApplication } from '../src/app.js';
import { openMapping } from '../src/mapping/storage.js';
import { human, statement } from './helpers.js';

it('现有资料导入与真实文件上传不占研究历史、不清redo，开放工作台历史独立保留', async () => {
  const root = mkdtempSync(join(tmpdir(), 'forkwise-history-materials-'));
  const app = createApplication({
    database: join(root, 'legacy.sqlite'),
    origin: 'http://127.0.0.1:8787',
  });
  const mapping = openMapping(join(root, 'workspace'));
  try {
    const p = app.write.createProject(human, randomUUID(), { name: '资料隔离' });
    app.write.execute(p.id, human, randomUUID(), { expected: {}, commands: [statement('a')] });
    app.write.travel(p.id, human, randomUUID(), {
      direction: 'undo',
      expectedRevision: app.repo.project(p.id).revision,
      expectedHistoryVersion: app.write.history(p.id).version,
      expectedLayoutVersion: 0,
    });
    const legacyHistory = app.write.history(p.id);
    const actor = mapping.access.authenticate(mapping.access.issue('human', ['*']));
    const run = (command: Record<string, unknown>) =>
      mapping.execute({ projectId: p.id, commandId: randomUUID(), ...command }, actor);
    run({ type: 'project.create', expected: null, payload: { name: '普通卡片' } });
    run({
      type: 'thought.create',
      expected: null,
      payload: { id: 'c', title: '研究', text: '', x: 0, y: 0 },
    });
    run({ type: 'history.undo', expected: 2, payload: {} });
    const mappingHistory = mapping.read({ type: 'history', projectId: p.id }, actor);
    app.write.execute(p.id, human, randomUUID(), {
      expected: {},
      commands: [
        {
          op: 'source.create',
          id: 's',
          data: { title: '原材料', publisher: '', rights: 'authorized' },
        },
        {
          op: 'source.import',
          id: 'sv',
          sourceId: 's',
          text: '导入原文',
          retrievedAt: '2026-10-13T00:00:00Z',
          publishedAt: null,
        },
      ],
    });
    expect(app.write.history(p.id)).toEqual(legacyHistory);
    const source = app.repo.snapshot(p.id).objects.find((e) => e.id === 's')!;
    const bytes = Buffer.from('<html><body><p>上传材料原文</p></body></html>');
    const uploaded = app.files.upload(p.id, human, randomUUID(), {
      sourceId: 's',
      expectedSourceVersion: source.version,
      name: 'material.html',
      mime: 'text/html',
      base64: bytes.toString('base64'),
      publishedAt: null,
    });
    expect(app.write.history(p.id)).toEqual(legacyHistory);
    await app.files.drain();
    expect(app.jobs.get(p.id, uploaded.job.id).state).toBe('succeeded');
    expect(app.write.history(p.id)).toEqual(legacyHistory);
    expect(mapping.read({ type: 'history', projectId: p.id }, actor)).toEqual(mappingHistory);
    run({ type: 'history.redo', expected: 3, payload: {} });
    expect(mapping.read({ type: 'project', projectId: p.id }, actor).cards[0]!.title).toBe('研究');
    expect(app.files.file(p.id, uploaded.fileId).bytes).toEqual(bytes);
    app.write.travel(p.id, human, randomUUID(), {
      direction: 'redo',
      expectedRevision: app.repo.project(p.id).revision,
      expectedHistoryVersion: legacyHistory.version,
      expectedLayoutVersion: 0,
    });
    expect(app.repo.material(p.id, 'sv')).toBe('导入原文');
    expect(app.files.file(p.id, uploaded.fileId).bytes).toEqual(bytes);
  } finally {
    mapping.close();
    app.db.close();
    rmSync(root, { recursive: true, force: true });
  }
});
