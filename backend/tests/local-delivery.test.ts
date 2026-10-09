import { it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync, symlinkSync, mkdirSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApplication } from '../src/app.js';
import { human, statement, inference } from './helpers.js';
import { readMaterialPage } from '../src/services/material-read.js';
import { importLocalFile } from '../src/services/local-import.js';
import { editDrawings } from '../src/services/drawing.js';
import { AssetService } from '../src/services/assets.js';
import { ArchiveService } from '../src/services/archive.js';
import { BackupService, researchFingerprint } from '../src/services/backup.js';
import { readLayout } from '../src/repositories/layout.js';
import { createCanvas } from '@napi-rs/canvas';
const origin = 'http://127.0.0.1:8787';
function scannedPdf() {
  const canvas = createCanvas(300, 100),
    ctx = canvas.getContext('2d');
  ctx.fillStyle = 'white';
  ctx.fillRect(0, 0, 300, 100);
  ctx.fillStyle = 'black';
  ctx.font = '20px sans-serif';
  ctx.fillText('TEST SCAN 12', 20, 50);
  const jpeg = canvas.toBuffer('image/jpeg');
  const stream = 'q 300 0 0 100 0 0 cm /Im0 Do Q';
  const objects = [
    Buffer.from('<< /Type /Catalog /Pages 2 0 R >>'),
    Buffer.from('<< /Type /Pages /Kids [3 0 R] /Count 1 >>'),
    Buffer.from(
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 100] /Resources << /XObject << /Im0 5 0 R >> >> /Contents 4 0 R >>',
    ),
    Buffer.from(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`),
    Buffer.concat([
      Buffer.from(
        `<< /Type /XObject /Subtype /Image /Width 300 /Height 100 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`,
      ),
      jpeg,
      Buffer.from('\nendstream'),
    ]),
  ];
  const parts = [Buffer.from('%PDF-1.4\n')],
    offsets = [0];
  let length = parts[0]!.length;
  objects.forEach((object, i) => {
    offsets.push(length);
    const part = Buffer.concat([
      Buffer.from(`${i + 1} 0 obj\n`),
      object,
      Buffer.from('\nendobj\n'),
    ]);
    parts.push(part);
    length += part.length;
  });
  parts.push(
    Buffer.from(
      `xref\n0 6\n0000000000 65535 f \n${offsets
        .slice(1)
        .map((n) => String(n).padStart(10, '0') + ' 00000 n \n')
        .join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${length}\n%%EOF`,
    ),
  );
  return Buffer.concat(parts);
}
function fixture(database = ':memory:') {
  const app = createApplication({ database, origin, metrics: ['测试指标'] }),
    project = app.write.createProject(human, randomUUID(), { name: '本机交付隔离测试' });
  app.write.execute(project.id, human, randomUUID(), {
    expected: {},
    commands: [
      statement('a'),
      statement('b'),
      inference('i', ['a'], 'b'),
      {
        op: 'source.create',
        id: 's',
        data: { title: '合成公开材料', publisher: '测试', rights: 'authorized' },
      },
      {
        op: 'source.import',
        id: 'sv',
        sourceId: 's',
        text: '收入增长。😀 下一段。',
        retrievedAt: new Date().toISOString(),
        publishedAt: null,
      },
    ],
  });
  const token = app.access.issue('agent', [project.id]),
    principal = app.access.authenticate(token);
  const state = () => app.repo.snapshot(project.id),
    get = (id: string) => state().objects.find((e) => e.id === id)!;
  const job = (kind = 'verify', targetIds = ['a']) =>
    app.externalResearch.request(project.id, principal.actor, randomUUID(), {
      kind,
      sourceVersionIds: ['sv'],
      targetIds,
    });
  const submit = (id: string, result: unknown, state = 'succeeded', gaps: string[] = []) =>
    app.externalResearch.submit(project.id, principal.actor, randomUUID(), id, {
      state,
      result,
      gaps,
    });
  const verify = (target = get('a')) => ({
    checks: [
      {
        target: { id: target.id, versionId: target.contentVersionId },
        relation: 'supports',
        explanation: '合成材料仅供测试',
        citations: [{ sourceVersionId: 'sv', start: 0, end: 5, quote: '收入增长。' }],
        gaps: [],
      },
    ],
    gaps: [],
  });
  return { app, project, token, principal, state, get, job, submit, verify };
}
it('外部记录固定输入，后台不会领取；提交与原键回查共用同一业务事务', async () => {
  const f = fixture();
  try {
    const job = f.job();
    expect(f.app.jobs.claim(f.project.id, job.id)).toBeNull();
    await f.app.researchTasks.drain();
    await f.app.evaluation.drain();
    expect(f.app.jobs.get(f.project.id, job.id).state).toBe('queued');
    const page = readMaterialPage(f.app.repo, f.project.id, 'sv', { start: 0, limit: 5 });
    f.app.externalResearch.recordRead(f.project.id, f.principal.actor, job.id, {
      sourceVersionId: 'sv',
      start: page.start,
      end: page.end,
      hash: page.hash,
    });
    const key = randomUUID(),
      input = {
        state: 'succeeded',
        result: f.verify(),
        gaps: [],
        agentCoverage: { unverified: '其他网站自报' },
        agentUsage: { tokens: 10 },
      };
    const result = f.app.externalResearch.submit(
      f.project.id,
      f.principal.actor,
      key,
      job.id,
      input,
    );
    expect(result.state).toBe('succeeded');
    expect(result.output).toMatchObject({
      stale: false,
      coverage: {
        modelCalled: false,
        serverReads: [{ sourceVersionId: 'sv' }],
        agentReported: { unverified: '其他网站自报' },
      },
    });
    expect(result.usage).toEqual({ agentReported: { tokens: 10 }, verified: false });
    expect(
      f.app.externalResearch.submit(f.project.id, f.principal.actor, key, job.id, input),
    ).toEqual(result);
    expect(f.app.write.operation(f.project.id, f.principal.actor, key)).toEqual(result);
    const evidence = f.state().objects.filter((e) => e.kind === 'evidence_link');
    expect(evidence).toHaveLength(1);
    expect(evidence[0]!.data).toMatchObject({ origin: 'ai', participation: 'candidate' });
  } finally {
    f.app.db.close();
  }
});
it('目标及推导直接前提变化后旧结果可读取，不写当前图谱', () => {
  const f = fixture();
  try {
    const job = f.job('verify', ['i']),
      old = f.get('i');
    f.app.write.execute(f.project.id, human, randomUUID(), {
      expected: { a: 1, i: 1 },
      commands: [{ op: 'statement.edit', id: 'a', text: '变化后的前提', scope: 'all' }],
    });
    const result = f.submit(job.id, f.verify(old));
    expect(result.output).toMatchObject({ stale: true, changes: null });
    expect(f.state().objects.some((e) => e.kind === 'evidence')).toBe(false);
    expect(f.app.jobs.get(f.project.id, job.id).input).toMatchObject({
      context: [{ id: 'a', data: { text: 'a' } }, { id: 'b' }],
    });
  } finally {
    f.app.db.close();
  }
});
it('部分完成、失败、新记录重试及取消后晚到提交保留历史；其他 Agent 不能伪造结果', () => {
  const f = fixture();
  try {
    const job = f.job(),
      other = f.app.access.authenticate(f.app.access.issue('agent', [f.project.id]));
    expect(() =>
      f.app.controller.jobAction(other, f.project.id, randomUUID(), job.id, 'cancel'),
    ).toThrow('创建 Agent');
    expect(() =>
      f.app.externalResearch.submit(f.project.id, other.actor, randomUUID(), job.id, {
        state: 'failed',
        error: '测试失败',
        gaps: [],
      }),
    ).toThrow('创建 Agent');
    const partial = f.submit(job.id, { checks: [], gaps: ['待继续'] }, 'partial', ['待继续']);
    expect(partial.state).toBe('partial');
    const retry = f.app.externalResearch.action(
      f.project.id,
      f.principal.actor,
      randomUUID(),
      job.id,
      'retry',
    );
    expect(retry.id).not.toBe(job.id);
    expect(retry.input).toMatchObject({ external: { retryOf: job.id } });
    expect(f.app.jobs.get(f.project.id, job.id).state).toBe('partial');
    expect(() => f.app.jobs.retry(f.project.id, job.id)).toThrow('新记录');
    f.app.externalResearch.action(
      f.project.id,
      f.principal.actor,
      randomUUID(),
      retry.id,
      'cancel',
    );
    expect(() => f.submit(retry.id, f.verify())).toThrow('已取消');
    const failed = f.job();
    f.app.externalResearch.submit(f.project.id, f.principal.actor, randomUUID(), failed.id, {
      state: 'failed',
      error: '明确失败',
      gaps: ['缺少资料'],
    });
    expect(f.app.jobs.get(f.project.id, failed.id).error).toBe('明确失败');
  } finally {
    f.app.db.close();
  }
});
it('非法外部引文及批次错误原子回滚，不留下回执或半份候选', () => {
  const f = fixture();
  try {
    const job = f.job(),
      input = f.verify();
    input.checks[0]!.citations[0]!.quote = '错误原句';
    const key = randomUUID(),
      before = f.state();
    expect(() =>
      f.app.externalResearch.submit(f.project.id, f.principal.actor, key, job.id, {
        state: 'succeeded',
        result: input,
        gaps: [],
      }),
    ).toThrow('引用');
    expect(f.state()).toEqual(before);
    expect(f.app.jobs.get(f.project.id, job.id).state).toBe('queued');
    expect(() => f.app.write.operation(f.project.id, f.principal.actor, key)).toThrow('尚未找到');
    const reconstruct = f.job('reconstruct', []);
    const cyclic = {
      statements: [{ key: 'x', text: '候选', origin: 'ai', citations: [], gaps: [] }],
      inferences: [
        {
          key: 'edge',
          premiseKeys: ['x'],
          conclusionKey: 'x',
          reason: '自环',
          combination: 'independent',
          origin: 'ai',
          citations: [],
          gaps: [],
        },
      ],
      gaps: [],
    };
    expect(() => f.submit(reconstruct.id, cyclic)).toThrow();
    expect(f.state()).toEqual(before);
  } finally {
    f.app.db.close();
  }
});
it('全文检索过滤受限材料及其引文，不泄露跨项目结果', () => {
  const f = fixture();
  try {
    f.app.write.execute(f.project.id, human, randomUUID(), {
      expected: {},
      commands: [
        {
          op: 'source.create',
          id: 'restricted',
          data: { title: '仅保存索引', publisher: '', rights: 'restricted' },
        },
        {
          op: 'source.import',
          id: 'restricted_version',
          sourceId: 'restricted',
          text: '受限秘密内容',
          retrievedAt: new Date().toISOString(),
          publishedAt: null,
        },
        {
          op: 'evidence.create',
          id: 'restricted_quote',
          data: {
            citation: {
              sourceVersionId: 'restricted_version',
              start: 0,
              end: 6,
              quote: '受限秘密内容',
            },
          },
        },
      ],
    });
    expect(f.app.search.search(f.project.id, '秘密').results).toEqual([]);
    expect(f.app.search.search(f.project.id, '收入').results.map((r) => r.entityId)).toContain(
      'sv',
    );
    const other = f.app.write.createProject(human, randomUUID(), { name: '另一项目' });
    expect(f.app.search.search(other.id, '收入').results).toEqual([]);
  } finally {
    f.app.db.close();
  }
});
it('项目委托支持立场、条件与笔记，执行者仍为 Agent；旧凭据、撤销与管理操作拒绝', async () => {
  const f = fixture();
  try {
    const input = {
      expected: { a: 1 },
      commands: [
        { op: 'stance.set', id: 'a', stance: { value: 'accepted', reason: '本人委托记录的理由' } },
      ],
    };
    expect(() => f.app.controller.execute(f.principal, f.project.id, randomUUID(), input)).toThrow(
      '委托',
    );
    const owner = f.app.access.authenticate(f.app.access.issue('human', ['*'])),
      grant = f.app.controller.grant(owner, randomUUID(), [f.project.id], [f.project.id]),
      p = f.app.access.authenticate(grant.token);
    const r = f.app.controller.execute(p, f.project.id, randomUUID(), input);
    expect(r.upserted[0]!.data).toMatchObject({ origin: 'user', stance: { value: 'accepted' } });
    const actor = JSON.parse(
      (
        f.app.db.prepare('SELECT actor FROM versions WHERE id=?').get(r.upserted[0]!.versionId) as {
          actor: string;
        }
      ).actor,
    );
    expect(actor).toMatchObject({
      type: 'agent',
      delegation: { projectId: f.project.id, capability: 'personal_record' },
    });
    f.app.controller.execute(p, f.project.id, randomUUID(), {
      expected: { a: 2 },
      commands: [{ op: 'note.create', id: 'n', targetId: 'a', text: '代录笔记' }],
    });
    const exported = new AssetService(f.app.repo, f.app.write).export(f.project.id);
    const other = createApplication({ database: ':memory:', origin });
    try {
      new ArchiveService(other.write, other.search).import(human, randomUUID(), exported);
      expect(new AssetService(other.repo, other.write).export(f.project.id).actionHistory).toEqual(
        exported.actionHistory,
      );
      expect(other.access.grants()).toEqual([]);
    } finally {
      other.db.close();
    }
    expect(() => f.app.controller.create(p, randomUUID(), { name: '越权' })).toThrow('本机会话');
    expect(() => f.app.controller.execute(p, 'other-project', randomUUID(), input)).toThrow(
      '访问授权',
    );
    f.app.access.revokeGrant(p.actor.id);
    expect(() => f.app.access.authenticate(grant.token)).toThrow('无效');
    expect(() =>
      f.app.controller.execute(p, f.project.id, randomUUID(), {
        expected: { a: 2 },
        commands: [{ op: 'stance.set', id: 'a', stance: { value: 'pending', reason: '' } }],
      }),
    ).toThrow('委托');
    const deny = await f.app.app.request(origin + '/api/v1/agent-grants', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${f.token}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': randomUUID(),
      },
      body: JSON.stringify({ projectIds: [f.project.id], personalRecordProjects: [f.project.id] }),
    });
    expect(deny.status).toBe(403);
  } finally {
    f.app.db.close();
  }
});
it('路径导入默认关闭并按项目拒绝目录越界、符号链接及非普通文件；原键恢复不重读变化文件', async () => {
  const f = fixture(),
    dir = mkdtempSync(join(tmpdir(), 'forkwise-path-'));
  try {
    const root = join(dir, 'allowed');
    mkdirSync(root);
    const file = join(root, 'material.txt');
    writeFileSync(file, '路径原文');
    const input = {
      source: { title: '路径测试', publisher: '', rights: 'authorized' },
      path: file,
      mime: 'text/plain',
      publishedAt: null,
    };
    expect(() =>
      importLocalFile(f.app.files, {}, f.project.id, f.principal.actor, randomUUID(), input),
    ).toThrow('未配置');
    const roots = { [f.project.id]: [root] };
    const outside = join(dir, 'outside.txt');
    writeFileSync(outside, '目录外');
    symlinkSync(outside, join(root, 'escape.txt'));
    for (const path of [outside, join(root, 'escape.txt'), root])
      expect(() =>
        importLocalFile(f.app.files, roots, f.project.id, f.principal.actor, randomUUID(), {
          ...input,
          path,
        }),
      ).toThrow();
    symlinkSync(root, join(root, 'linked'));
    expect(() =>
      importLocalFile(f.app.files, roots, f.project.id, f.principal.actor, randomUUID(), {
        ...input,
        path: join(root, 'linked', 'material.txt'),
      }),
    ).toThrow('符号链接');
    const key = randomUUID(),
      result = importLocalFile(f.app.files, roots, f.project.id, f.principal.actor, key, input);
    unlinkSync(file);
    expect(
      importLocalFile(f.app.files, roots, f.project.id, f.principal.actor, key, input),
    ).toEqual(result);
    await f.app.files.drain();
    const parsed = f.app.jobs.get(f.project.id, result.job.id).output as {
      sourceVersionId: string;
    };
    expect(f.app.repo.material(f.project.id, parsed.sourceVersionId)).toBe('路径原文');
  } finally {
    f.app.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
it('材料分页有界、固定指纹、UTF-16 不拆字符，HTML 和转写锚点独立回读，跨项目拒绝', () => {
  const f = fixture();
  try {
    const page = readMaterialPage(f.app.repo, f.project.id, 'sv', { start: 6, limit: 1 });
    expect(page.text).toBe('😀');
    expect(page.start).toBe(5);
    expect(page.end).toBe(7);
    expect(page.nextStart).toBe(7);
    expect(() => readMaterialPage(f.app.repo, 'other-project', 'sv', {})).toThrow();
    expect(() => readMaterialPage(f.app.repo, f.project.id, 'sv', { start: 999 })).toThrow('范围');
    f.app.db.prepare("UPDATE materials SET text='篡改' WHERE source_version_id='sv'").run();
    expect(() => readMaterialPage(f.app.repo, f.project.id, 'sv', {})).toThrow('指纹');
  } finally {
    f.app.db.close();
  }
});
it('绘图只有一份规范数据，普通箭头不建推导；位置、版本冲突与多命令回滚', () => {
  const f = fixture();
  try {
    const result = editDrawings(
      f.app.write,
      f.app.files,
      f.project.id,
      f.principal.actor,
      randomUUID(),
      {
        expectedVersion: 0,
        commands: [
          {
            op: 'drawing.put',
            drawing: { id: 'arrow', type: 'arrow', x: 5, y: 6, width: 90, height: 20 },
          },
          { op: 'object.position', id: 'a', x: 120, y: 100 },
        ],
      },
    );
    expect(result.layout?.data.canvas?.annotations.elements).toHaveLength(1);
    expect(result.layout?.data.drawings).toHaveLength(0);
    expect(f.state().objects.filter((e) => e.kind === 'inference')).toHaveLength(1);
    expect(() =>
      editDrawings(f.app.write, f.app.files, f.project.id, f.principal.actor, randomUUID(), {
        expectedVersion: 0,
        commands: [{ op: 'drawing.delete', id: 'arrow' }],
      }),
    ).toThrow('画布已改变');
    const before = readLayout(f.app.repo, f.project.id);
    expect(() =>
      editDrawings(f.app.write, f.app.files, f.project.id, f.principal.actor, randomUUID(), {
        expectedVersion: 1,
        commands: [
          { op: 'drawing.delete', id: 'arrow' },
          { op: 'object.position', id: 'outside', x: 0, y: 0 },
        ],
      }),
    ).toThrow('不属于');
    expect(readLayout(f.app.repo, f.project.id)).toEqual(before);
    editDrawings(f.app.write, f.app.files, f.project.id, f.principal.actor, randomUUID(), {
      expectedVersion: 1,
      commands: [
        {
          op: 'drawing.put',
          drawing: {
            id: 'arrow',
            type: 'text',
            text: '同一 ID 更新',
            x: 3,
            y: 4,
            width: 100,
            height: 30,
          },
        },
      ],
    });
    expect(readLayout(f.app.repo, f.project.id).data.canvas?.annotations.elements).toHaveLength(1);
  } finally {
    f.app.db.close();
  }
});
it('外部转写绑定原文件指纹和区域，Agent 执行者与未核验状态随 JSON 往返', async () => {
  const f = fixture(),
    other = createApplication({ database: ':memory:', origin });
  try {
    const uploaded = f.app.controller.importFile(f.principal, f.project.id, randomUUID(), {
      source: { title: '测试像素', publisher: '', rights: 'authorized' },
      file: {
        name: 'pixel.png',
        mime: 'image/png',
        base64:
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jNioAAAAASUVORK5CYII=',
        publishedAt: null,
      },
    });
    await f.app.files.drain();
    const id = (f.app.jobs.get(f.project.id, uploaded.job.id).output as { sourceVersionId: string })
      .sourceVersionId;
    const input = {
      sourceVersionId: id,
      page: 1,
      fileHash: uploaded.hash,
      result: {
        blocks: [
          { text: '合成转写', region: { x: 0, y: 0, width: 1, height: 1 }, uncertain: false },
        ],
        gaps: [],
      },
    };
    await expect(
      f.app.transcription.submitExternal(f.project.id, f.principal.actor, randomUUID(), {
        ...input,
        fileHash: '0'.repeat(64),
      }),
    ).rejects.toThrow('指纹');
    const output = await f.app.transcription.submitExternal(
      f.project.id,
      f.principal.actor,
      randomUUID(),
      input,
    );
    expect(output.artifact).toMatchObject({
      verified: false,
      executor: 'external',
      createdBy: f.principal.actor.id,
      fileHash: uploaded.hash,
      regions: [{ verification: 'unverified', page: 1 }],
    });
    expect(
      readMaterialPage(f.app.repo, f.project.id, output.sourceVersionId, {}).anchors,
    ).toHaveLength(1);
    const exported = new AssetService(f.app.repo, f.app.write).export(f.project.id);
    new ArchiveService(other.write, other.search).import(human, randomUUID(), exported);
    expect(other.files.artifact(f.project.id, output.sourceVersionId)).toEqual(output.artifact);
  } finally {
    f.app.db.close();
    other.db.close();
  }
});
it('扫描 PDF 页图和外部转写绑定原件、页码与区域，恢复后仍能定位未核验结果', async () => {
  const f = fixture(),
    other = createApplication({ database: ':memory:', origin });
  try {
    const uploaded = f.app.controller.importFile(f.principal, f.project.id, randomUUID(), {
      source: { title: '生成的扫描页夹具', publisher: '测试', rights: 'authorized' },
      file: {
        name: 'scan.pdf',
        mime: 'application/pdf',
        base64: scannedPdf().toString('base64'),
        publishedAt: null,
      },
    });
    await f.app.files.drain();
    const parsed = f.app.jobs.get(f.project.id, uploaded.job.id).output as {
      sourceVersionId: string;
    };
    const image = await f.app.transcription.image(
      f.project.id,
      parsed.sourceVersionId,
      1,
      new AbortController().signal,
    );
    expect(image.width).toBe(600);
    expect(image.height).toBe(200);
    expect(readMaterialPage(f.app.repo, f.project.id, parsed.sourceVersionId, {}).text.trim()).toBe(
      '',
    );
    expect(f.app.files.artifact(f.project.id, parsed.sourceVersionId)).toMatchObject({
      pages: [{ page: 1, status: 'needs_ocr' }],
      regions: [],
    });
    const result = await f.app.transcription.submitExternal(
      f.project.id,
      f.principal.actor,
      randomUUID(),
      {
        sourceVersionId: parsed.sourceVersionId,
        fileHash: uploaded.hash,
        page: 1,
        result: {
          blocks: [
            { text: 'TEST SCAN 12', region: { x: 0, y: 0, width: 1, height: 1 }, uncertain: false },
          ],
          gaps: [],
        },
      },
    );
    const exported = new AssetService(f.app.repo, f.app.write).export(f.project.id);
    new ArchiveService(other.write, other.search).import(human, randomUUID(), exported);
    const page = readMaterialPage(other.repo, f.project.id, result.sourceVersionId, {});
    expect(page.text).toBe('TEST SCAN 12\n');
    expect(page.anchors[0]).toMatchObject({
      page: 1,
      verification: 'unverified',
      start: 0,
      end: 12,
    });
    expect(other.files.artifact(f.project.id, result.sourceVersionId)).toMatchObject({
      fileHash: uploaded.hash,
      derivedFrom: parsed.sourceVersionId,
      verified: false,
    });
    const restored = await other.transcription.image(
      f.project.id,
      result.sourceVersionId,
      1,
      new AbortController().signal,
    );
    expect(restored.base64).toBe(image.base64);
    await expect(
      other.transcription.image(
        f.project.id,
        result.sourceVersionId,
        2,
        new AbortController().signal,
      ),
    ).rejects.toThrow('此页不存在');
  } finally {
    f.app.db.close();
    other.db.close();
  }
}, 20_000);
it('重启不调用模型；SQLite 备份恢复保留外部结果、绘图与委托审计但不恢复授权', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'forkwise-delivery-backup-'));
  const f = fixture(join(dir, 'research.sqlite'));
  let restored: ReturnType<typeof createApplication> | undefined;
  try {
    const job = f.job();
    f.submit(job.id, f.verify());
    const pending = f.job('stance_draft');
    const owner = f.app.access.authenticate(f.app.access.issue('human', ['*'])),
      grant = f.app.controller.grant(owner, randomUUID(), [f.project.id], [f.project.id]),
      p = f.app.access.authenticate(grant.token);
    f.app.controller.execute(p, f.project.id, randomUUID(), {
      expected: { a: 1 },
      commands: [{ op: 'stance.set', id: 'a', stance: { value: 'accepted', reason: '委托' } }],
    });
    editDrawings(f.app.write, f.app.files, f.project.id, p.actor, randomUUID(), {
      expectedVersion: 0,
      commands: [
        {
          op: 'drawing.put',
          drawing: { id: 'box', type: 'rectangle', x: 1, y: 1, width: 100, height: 50 },
        },
      ],
    });
    const backups = new BackupService(f.app.repo, join(dir, 'backups')),
      before = researchFingerprint(f.app.db),
      backup = await backups.create(),
      copy = await backups.restoreIsolated(backup.id, join(dir, 'restored'));
    restored = createApplication({ database: join(copy.directory, 'research.sqlite'), origin });
    expect(researchFingerprint(restored.db)).toBe(before);
    expect(restored.access.grants()).toEqual([]);
    expect(() => restored!.access.authenticate(grant.token)).toThrow('无效');
    expect(restored.jobs.get(f.project.id, job.id).state).toBe('succeeded');
    await restored.researchTasks.drain();
    expect(restored.jobs.get(f.project.id, pending.id).state).toBe('queued');
    expect(readLayout(restored.repo, f.project.id).data.canvas?.annotations.elements).toHaveLength(
      1,
    );
  } finally {
    f.app.db.close();
    restored?.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
it('外部混合评估由确定性工具算数值，仅明确共同满足才合并；旧规则结果不写当前', () => {
  const f = fixture();
  try {
    const rule = {
      subject: '测试主体',
      metric: '测试指标',
      operator: 'gt',
      threshold: 10,
      unit: '个',
      currency: '',
      scope: '合并',
      periodKind: 'single',
      periods: [{ start: '2025-01-01', end: '2025-03-31' }],
    };
    f.app.write.execute(f.project.id, human, randomUUID(), {
      expected: {},
      commands: [
        {
          op: 'condition.create',
          id: 'c',
          data: { description: '未指定组合', mode: 'mixed', rule, targetIds: [] },
        },
        {
          op: 'evidence.create',
          id: 'ev',
          data: {
            citation: { sourceVersionId: 'sv', start: 0, end: 5, quote: '收入增长。' },
            fact: {
              subject: '测试主体',
              metric: '测试指标',
              value: 5,
              rawValue: '5',
              unit: '个',
              currency: '',
              scope: '合并',
              periodKind: 'single',
              period: { start: '2025-01-01', end: '2025-03-31' },
            },
          },
        },
      ],
    });
    const qualitative = {
      verdict: 'satisfied',
      reason: 'Agent 定性意见',
      evidenceIds: ['ev'],
      citations: [],
      missing: [],
      tentative: true,
    };
    const request = () =>
      f.app.externalResearch.requestEvaluation(f.project.id, f.principal.actor, randomUUID(), {
        conditionId: 'c',
        ruleVersionId: f.get('c').contentVersionId,
        evidenceIds: ['ev'],
      });
    let result = f.submit(request().id, qualitative);
    expect(result.output).toMatchObject({
      result: { verdict: 'satisfied', components: { numeric: { verdict: 'not_satisfied' } } },
    });
    f.app.write.execute(f.project.id, human, randomUUID(), {
      expected: { c: 1 },
      commands: [
        {
          op: 'condition.edit',
          id: 'c',
          scope: 'all',
          data: { ...f.get('c').data, mixedCombination: 'joint_required' },
        },
      ],
    });
    result = f.submit(request().id, qualitative);
    expect(result.output).toMatchObject({
      result: { verdict: 'not_satisfied', inputVerification: 'agent_inputs_unverified' },
    });
    const stale = request();
    f.app.write.execute(f.project.id, human, randomUUID(), {
      expected: { c: 2 },
      commands: [
        {
          op: 'condition.edit',
          id: 'c',
          scope: 'all',
          data: { ...f.get('c').data, description: '新标准' },
        },
      ],
    });
    result = f.submit(stale.id, qualitative);
    expect(result.output).toMatchObject({ stale: true, changes: null });
  } finally {
    f.app.db.close();
  }
});
