import { it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createApplication } from '../src/app.js';
import { ArchiveService } from '../src/services/archive.js';
import { AssetService } from '../src/services/assets.js';
import { human } from './helpers.js';

it('HTML 原文件独立保存，提取不执行脚本，定位/原文件/历史可完整导出再导入', async () => {
  const a = createApplication({ database: ':memory:', origin: 'http://127.0.0.1:8787' });
  const b = createApplication({ database: ':memory:', origin: 'http://127.0.0.1:8787' });
  try {
    const p = a.write.createProject(human, 'material-project', { name: '原文件' });
    a.write.execute(p.id, human, 'material-source', {
      expected: {},
      commands: [
        {
          op: 'source.create',
          id: 's',
          data: { title: '用户 HTML', publisher: '', rights: 'authorized' },
        },
      ],
    });
    const html =
      '<html><body><script>throw new Error("do not run")</script><p>Actual source text</p><p hidden>hidden token</p></body></html>';
    const input = {
      sourceId: 's',
      expectedSourceVersion: 1,
      name: 'source.html',
      mime: 'text/html',
      base64: Buffer.from(html).toString('base64'),
      publishedAt: null,
    };
    const upload = a.files.upload(p.id, human, 'upload-material', input);
    await a.files.drain();
    const job = a.jobs.get(p.id, upload.job.id);
    expect(job.state).toBe('succeeded');
    const result = job.output as { sourceVersionId: string };
    expect(a.repo.material(p.id, result.sourceVersionId)).toBe('Actual source text');
    const artifact = a.files.artifact(p.id, result.sourceVersionId);
    expect(artifact.blocks[0].domPath).toBe('body/p[1]/#text[0]');
    expect(a.files.file(p.id, upload.fileId).bytes.toString()).toBe(html);
    expect(a.files.upload(p.id, human, 'repeat-upload', input).fileId).toBe(upload.fileId);
    const exported = new AssetService(a.repo, a.write).export(p.id);
    new ArchiveService(b.write, b.search).import(human, randomUUID(), exported);
    expect(b.files.file(p.id, upload.fileId).bytes.toString()).toBe(html);
    expect(b.files.artifact(p.id, result.sourceVersionId)).toEqual(artifact);
    expect(() => b.files.file('another-project', upload.fileId)).toThrow('不存在');
  } finally {
    a.db.close();
    b.db.close();
  }
});
it('原图先保存，OCR 未配置明确部分完成；失败解析仍可下载原文件', async () => {
  const a = createApplication({ database: ':memory:', origin: 'http://127.0.0.1:8787' });
  try {
    const p = a.write.createProject(human, 'image-project', { name: '图片' });
    a.write.execute(p.id, human, 'image-source', {
      expected: {},
      commands: [
        {
          op: 'source.create',
          id: 's',
          data: { title: '截图', publisher: '', rights: 'authorized' },
        },
      ],
    });
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jNioAAAAASUVORK5CYII=',
      'base64',
    );
    const uploaded = a.files.upload(p.id, human, 'upload-image', {
      sourceId: 's',
      expectedSourceVersion: 1,
      name: 'image.png',
      mime: 'image/png',
      base64: png.toString('base64'),
      publishedAt: null,
    });
    await a.files.drain();
    const job = a.jobs.get(p.id, uploaded.job.id);
    expect(job.state).toBe('partial');
    expect(job.error).toContain('尚未配置');
    expect(a.files.file(p.id, uploaded.fileId).bytes).toEqual(png);
    const malformed = a.files.upload(p.id, human, 'bad-pdf-file', {
      sourceId: 's',
      expectedSourceVersion: 1,
      name: 'bad.pdf',
      mime: 'application/pdf',
      base64: Buffer.from('%PDF-broken').toString('base64'),
      publishedAt: null,
    });
    await a.files.drain();
    expect(a.jobs.get(p.id, malformed.job.id).state).toBe('failed');
    expect(a.files.file(p.id, malformed.fileId).bytes.toString()).toBe('%PDF-broken');
  } finally {
    a.db.close();
  }
}, 15_000);
