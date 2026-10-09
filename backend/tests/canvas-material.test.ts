import { it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { AssetService } from '../src/services/assets.js';
import { ArchiveService } from '../src/services/archive.js';
import { createApplication } from '../src/app.js';
import { statement, human, agent } from './helpers.js';
const png =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jNioAAAAASUVORK5CYII=';
it('将已保存画布原图原子加入对象材料，重复加入复用材料且保留画布与立场', () => {
  const t = createApplication({ database: ':memory:', origin: 'http://127.0.0.1:8787' });
  try {
    const p = t.write.createProject(human, randomUUID(), { name: '图片材料', question: '' });
    t.write.execute(p.id, human, randomUUID(), {
      expected: {},
      commands: [statement('a'), statement('b')],
      layout: {
        expectedVersion: 0,
        data: {
          positions: {},
          drawings: [],
          canvas: {
            scenes: {},
            annotations: {
              elements: [{ id: 'img', type: 'image', x: 0, y: 0, fileId: 'f', isDeleted: false }],
              files: { f: { dataURL: `data:image/png;base64,${png}` } },
            },
          },
        },
      },
    });
    const input = {
      targetId: 'a',
      expectedTargetVersion: 1,
      imageId: 'img',
      expectedLayoutVersion: 1,
    };
    const key = randomUUID();
    const r = t.files.attachCanvas(p.id, human, key, input);
    expect(t.files.attachCanvas(p.id, human, key, input)).toEqual(r);
    const state = t.repo.snapshot(p.id);
    expect(state.objects.find((e) => e.id === 'a')?.data).toMatchObject({
      stance: { value: 'pending' },
    });
    expect(state.objects.filter((e) => e.kind === 'material_membership')).toHaveLength(1);
    expect(t.files.file(p.id, r.fileId).bytes.toString('base64')).toBe(png);
    expect(t.files.attachCanvas(p.id, human, randomUUID(), input).changes.upserted).toEqual([]);
    const second = t.files.attachCanvas(p.id, human, randomUUID(), { ...input, targetId: 'b' });
    expect(second.sourceVersionId).toBe(r.sourceVersionId);
    expect(t.repo.snapshot(p.id).objects.filter((e) => e.kind === 'source')).toHaveLength(1);
    expect(() => t.files.attachCanvas(p.id, agent, randomUUID(), input)).toThrow('本人');
    expect(() =>
      t.files.attachCanvas(p.id, human, randomUUID(), { ...input, expectedLayoutVersion: 0 }),
    ).toThrow('画布');
    expect(() =>
      t.files.attachCanvas(p.id, human, randomUUID(), { ...input, imageId: 'missing' }),
    ).toThrow('图片');
    expect(
      t.repo.snapshot(p.id).objects.filter((e) => e.kind === 'material_membership'),
    ).toHaveLength(2);
    const citation = {
      kind: 'image',
      sourceVersionId: r.sourceVersionId,
      fileId: r.fileId,
      page: 1,
      imageWidth: 1,
      imageHeight: 1,
      region: { x: 0, y: 0, width: 1, height: 1 },
    };
    const cite = (c: unknown, id: string) =>
      t.write.execute(p.id, human, randomUUID(), {
        expected: {},
        commands: [{ op: 'evidence.create', id, data: { citation: c } }],
      });
    cite(citation, 'image-evidence');
    expect(t.repo.snapshot(p.id).objects.find((e) => e.id === 'image-evidence')?.data).toEqual({
      citation,
    });
    expect(() => cite({ ...citation, imageWidth: 20 }, 'bad-size')).toThrow('原图');
    expect(() => cite({ ...citation, fileId: 'missing' }, 'bad-file')).toThrow('原图');
    expect(() =>
      cite({ ...citation, region: { x: 0.5, y: 0, width: 1, height: 1 } }, 'bad-region'),
    ).toThrow();

    const exported = new AssetService(t.repo, t.write).export(p.id);
    const restored = createApplication({ database: ':memory:', origin: 'http://127.0.0.1:8787' });
    try {
      const corrupt = structuredClone(exported);
      for (const e of [...corrupt.objects, ...corrupt.versions.map((v) => v.snapshot)])
        if (e.kind === 'evidence' && 'kind' in e.data.citation) e.data.citation.imageWidth = 4;
      expect(() =>
        new ArchiveService(restored.write, restored.search).import(human, randomUUID(), corrupt),
      ).toThrow('原图');
      expect(restored.repo.listProjects()).toHaveLength(0);
      new ArchiveService(restored.write, restored.search).import(human, randomUUID(), exported);
      expect(restored.files.file(p.id, r.fileId).bytes.toString('base64')).toBe(png);
      expect(
        restored.repo.snapshot(p.id).objects.find((e) => e.id === 'image-evidence')?.data,
      ).toEqual({ citation });
    } finally {
      restored.db.close();
    }
  } finally {
    t.db.close();
  }
});

it('图像入口核对项目权限、事务回滚与可显示的原图像素', async () => {
  const { createCanvas, loadImage } = await import('@napi-rs/canvas');
  const c = createCanvas(40, 20);
  c.getContext('2d').fillStyle = '#ff0000';
  c.getContext('2d').fillRect(0, 0, 40, 20);
  const t = createApplication({ database: ':memory:', origin: 'http://127.0.0.1:8787' });
  try {
    const p = t.write.createProject(human, randomUUID(), { name: '事务测试' });
    t.write.execute(p.id, human, randomUUID(), {
      commands: [statement('a')],
      expected: {},
      layout: {
        expectedVersion: 0,
        data: {
          positions: {},
          drawings: [],
          canvas: {
            scenes: {},
            annotations: {
              elements: [{ id: 'image', type: 'image', x: 0, y: 0, fileId: 'f' }],
              files: { f: { dataURL: c.toDataURL('image/png') } },
            },
          },
        },
      },
    });
    const input = {
        targetId: 'a',
        expectedTargetVersion: 1,
        imageId: 'image',
        expectedLayoutVersion: 1,
      },
      key = randomUUID();
    t.db.exec(
      "CREATE TRIGGER fail_membership BEFORE INSERT ON entities WHEN NEW.kind='material_membership' BEGIN SELECT RAISE(ABORT,'injected failure'); END",
    );
    expect(() => t.files.attachCanvas(p.id, human, key, input)).toThrow('injected failure');
    const failed = new AssetService(t.repo, t.write).export(p.id);
    expect(failed.objects).toHaveLength(1);
    expect(failed.files).toHaveLength(0);
    expect(failed.artifacts).toHaveLength(0);
    t.db.exec('DROP TRIGGER fail_membership');
    const token = t.access.issue('human', ['*']),
      other = t.access.issue('agent', []);
    const request = (auth: string) =>
      t.app.request(`/api/v1/projects/${p.id}/canvas-materials`, {
        method: 'POST',
        headers: {
          Host: '127.0.0.1:8787',
          Authorization: `Bearer ${auth}`,
          'Content-Type': 'application/json',
          'Idempotency-Key': key,
        },
        body: JSON.stringify(input),
      });
    expect((await request(other)).status).toBe(403);
    const response = await request(token);
    expect(response.status).toBe(200);
    const result = (await response.json()).data;
    const image = await t.transcription.image(
      p.id,
      result.sourceVersionId,
      1,
      new AbortController().signal,
    );
    const decoded = await loadImage(Buffer.from(image.base64, 'base64')),
      out = createCanvas(40, 20);
    out.getContext('2d').drawImage(decoded, 0, 0);
    expect([...out.getContext('2d').getImageData(3, 3, 1, 1).data]).toEqual([255, 0, 0, 255]);
    expect(image.width).toBe(40);
    expect(image.height).toBe(20);
    const assets = new AssetService(t.repo, t.write),
      layout = assets.layout(p.id);
    layout.data.canvas!.annotations.files.f!.dataURL = c.toDataURL('image/webp');
    assets.saveLayout(p.id, human, randomUUID(), {
      expectedVersion: layout.version,
      data: layout.data,
    });
    const webpMaterial = t.files.attachCanvas(p.id, human, randomUUID(), {
      ...input,
      expectedLayoutVersion: layout.version + 1,
    });
    const webp = await t.transcription.image(
      p.id,
      webpMaterial.sourceVersionId,
      1,
      new AbortController().signal,
    );
    const preview = await loadImage(Buffer.from(webp.base64, 'base64'));
    out.getContext('2d').drawImage(preview, 0, 0);
    const pixel = [...out.getContext('2d').getImageData(3, 3, 1, 1).data];
    expect(pixel[0]).toBeGreaterThan(245);
    expect(pixel[1]).toBeLessThan(10);
    expect(pixel[3]).toBe(255);

    expect((await (await request(token)).json()).data).toEqual(result);
  } finally {
    t.db.close();
  }
});

it('受限原图导出仅保留定位索引，恢复不声称可读，文本评估不调用模型冒充视觉核对', async () => {
  let calls = 0;
  const t = createApplication({
    database: ':memory:',
    origin: 'http://127.0.0.1:8787',
    agent: {
      evaluate: async () => {
        calls++;
        throw new Error('should not run');
      },
    },
  });
  const restore = createApplication({ database: ':memory:', origin: 'http://127.0.0.1:8787' });
  try {
    const p = t.write.createProject(human, randomUUID(), { name: '受限原图' });
    t.write.execute(p.id, human, randomUUID(), {
      expected: {},
      commands: [
        statement('a'),
        {
          op: 'source.create',
          id: 's',
          data: { title: '受限截图', publisher: '', rights: 'restricted' },
        },
      ],
    });
    const uploaded = t.files.upload(p.id, human, randomUUID(), {
      sourceId: 's',
      expectedSourceVersion: 1,
      name: 'image.png',
      mime: 'image/png',
      base64: png,
      publishedAt: null,
    });
    const parsed = await t.files.run(p.id, uploaded.job.id),
      sv = (parsed.output as { sourceVersionId: string }).sourceVersionId;
    expect(t.repo.snapshot(p.id).objects.find((e) => e.id === sv)?.data).toMatchObject({
      textOrigin: 'image_original',
    });
    t.write.execute(p.id, human, randomUUID(), {
      expected: { a: 1 },
      commands: [
        {
          op: 'evidence.create',
          id: 'e',
          data: {
            citation: {
              kind: 'image',
              sourceVersionId: sv,
              fileId: uploaded.fileId,
              page: 1,
              imageWidth: 1,
              imageHeight: 1,
              region: { x: 0, y: 0, width: 1, height: 1 },
            },
          },
        },
        {
          op: 'condition.create',
          id: 'c',
          data: { description: '图像是否包含目标', mode: 'qualitative', targetIds: ['a'] },
        },
      ],
    });
    const condition = t.repo.snapshot(p.id).objects.find((e) => e.id === 'c')!;
    const job = t.evaluation.request(p.id, 'c', ['e'], condition.contentVersionId);
    await t.evaluation.run(p.id, job.id);
    expect(calls).toBe(0);
    expect(t.jobs.get(p.id, job.id).error).toContain('原图');
    new AssetService(t.repo, t.write).saveLayout(p.id, human, randomUUID(), {
      expectedVersion: 0,
      data: {
        positions: {},
        drawings: [],
        canvas: {
          scenes: {},
          annotations: {
            elements: [],
            files: { restricted: { dataURL: `data:image/png;base64,${png}` } },
          },
        },
      },
    });
    const exported = new AssetService(t.repo, t.write).export(p.id);
    expect(JSON.stringify(exported)).not.toContain(png);
    expect(exported.files[0]?.base64).toBeNull();
    expect(exported.objects.find((e) => e.kind === 'evidence')?.data).toMatchObject({
      citation: { kind: 'image', unavailableReason: 'rights' },
    });
    new ArchiveService(restore.write, restore.search).import(human, randomUUID(), exported);
    expect(() => restore.files.file(p.id, uploaded.fileId)).toThrow('受限');
    const record = restore.repo.snapshot(p.id).objects.find((e) => e.kind === 'evidence');
    expect(record?.data).toMatchObject({
      citation: { region: { x: 0, y: 0, width: 1, height: 1 } },
    });
    const { BackupService } = await import('../src/services/backup.js');
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'forkwise-image-backup-'));
    try {
      const backups = new BackupService(t.repo, join(dir, 'backups')),
        backup = await backups.create();
      const restored = await backups.restoreIsolated(backup.id, join(dir, 'restored'));
      const reopened = createApplication({
        database: join(restored.directory, 'research.sqlite'),
        origin: 'http://127.0.0.1:8787',
      });
      try {
        expect(
          JSON.stringify(new AssetService(reopened.repo, reopened.write).export(p.id)),
        ).not.toContain(png);
        expect(
          new AssetService(reopened.repo, reopened.write).layout(p.id).data.canvas?.annotations
            .files,
        ).toEqual({});
      } finally {
        reopened.db.close();
      }
      expect(
        new AssetService(t.repo, t.write).layout(p.id).data.canvas?.annotations.files.restricted
          ?.dataURL,
      ).toContain(png);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  } finally {
    t.db.close();
    restore.db.close();
  }
});
