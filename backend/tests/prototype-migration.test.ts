import { createRequire } from 'node:module';
import { createHash, randomUUID } from 'node:crypto';
import { it, expect } from 'vitest';
import { createApplication } from '../src/app.js';
import { PrototypeMigrationService } from '../src/services/prototype-migration.js';
import { AssetService } from '../src/services/assets.js';
import { ArchiveService } from '../src/services/archive.js';
import { ArchiveSchema } from '../src/contracts/assets.js';
import { human, agent } from './helpers.js';
import { eraseProject } from '../src/services/project-lifecycle.js';

const { fixture } = createRequire(import.meta.url)('../scripts/prototype-fixture.cjs');
const setup = () => {
  const app = createApplication({ database: ':memory:', origin: 'http://127.0.0.1:8787' });
  return { ...app, migration: new PrototypeMigrationService(app.write, app.search) };
};
it('真实原型导出结构：只读预览、内容归属与立场、原文引用、画布、草稿和旧历史可迁移与恢复', () => {
  const a = setup(),
    b = setup(),
    workspace = fixture(),
    key = randomUUID();
  try {
    const preview = a.migration.preview(human, { workspace });
    expect(a.repo.listProjects()).toHaveLength(0);
    expect(a.db.prepare('SELECT count(*) AS n FROM operations').get()).toEqual({ n: 0 });
    const input = { workspace, previewHash: preview.previewHash };
    const result = a.migration.import(human, key, input);
    expect(a.migration.import(human, key, input)).toEqual(result);
    const state = a.repo.snapshot(result.project.id);
    const personal = state.objects.find(
      (e) => e.kind === 'statement' && e.data.text.includes('合成迁移案例'),
    )!;
    expect(personal).toMatchObject({
      version: 1,
      data: {
        origin: 'author',
        participation: 'personal',
        stance: { value: 'questioned', reason: '尚未获得量产披露' },
      },
    });
    expect(
      state.objects.find((e) => e.kind === 'statement' && e.data.origin === 'ai')?.data,
    ).toMatchObject({ participation: 'reference', stance: { value: 'pending' } });
    expect(state.objects.filter((e) => e.kind === 'evaluation')).toHaveLength(0);
    expect(state.objects.filter((e) => e.kind === 'verification_node')).toHaveLength(1);
    expect(state.objects.find((e) => e.kind === 'evidence_link')?.data).toMatchObject({
      target: { id: personal.id, versionId: personal.contentVersionId },
      relation: 'opposes',
    });
    const assets = new AssetService(a.repo, a.write),
      layout = assets.layout(result.project.id);
    expect(
      layout.data.canvas?.scenes.mine?.styles[
        `forkwise:${result.project.id}:mine:card:${personal.id}`
      ],
    ).toEqual({ strokeColor: '#276e68', strokeWidth: 4 });
    expect(layout.data.canvas?.attachments?.['free-note']?.target).toBe(personal.id);
    expect(layout.data.canvas?.drafts).toEqual({});
    expect(a.migration.record(result.project.id).workspace).toEqual(workspace);
    expect(preview.report.issues.some((i) => i.code === 'LEGACY_CHECK_RETAINED')).toBe(true);
    expect(a.jobs.list(result.project.id)).toHaveLength(0);
    const archive = assets.export(result.project.id);
    const imageFile = archive.files.find((f) => f.mime === 'image/png')!;
    expect(imageFile.base64).toBe(
      workspace.projects[0][1].study.sources
        .find((s: { kind?: string }) => s.kind === 'image')
        .data.split(',')[1],
    );
    expect(layout.data.canvas?.annotations.files['image-file']?.dataURL).toContain(
      'data:image/png;base64,',
    );
    new ArchiveService(b.write, b.search).import(human, randomUUID(), archive);
    expect(b.files.file(result.project.id, imageFile.id).bytes).toEqual(
      a.files.file(result.project.id, imageFile.id).bytes,
    );
    expect(b.migration.record(result.project.id)).toEqual(a.migration.record(result.project.id));
    expect(b.repo.snapshot(result.project.id)).toEqual(state);
    expect(() => a.migration.import(human, randomUUID(), input)).toThrow('身份已存在');
    // Deleted projects must leave neither private legacy files nor replayable receipts.
    eraseProject(a.db, result.project.id);
    expect(a.db.prepare('SELECT count(*) AS n FROM operations').get()).toEqual({ n: 0 });
    expect(a.db.prepare('SELECT count(*) AS n FROM file_assets').get()).toEqual({ n: 0 });
  } finally {
    a.db.close();
    b.db.close();
  }
});
it('预览绑定副本；材料篡改、回环、重复身份、跨项目草稿及 Agent 导入均不能留下半个项目', () => {
  const a = setup();
  try {
    const original = fixture(),
      preview = a.migration.preview(human, { workspace: original });
    const changed = structuredClone(original);
    changed.projects[0][1].study.question = 'changed';
    expect(() =>
      a.migration.import(human, randomUUID(), {
        workspace: changed,
        previewHash: preview.previewHash,
      }),
    ).toThrow('重新预览');
    const invalid: ((w: ReturnType<typeof fixture>) => void)[] = [
      (w) => {
        w.projects[0][1].study.mine.nodes.p1.sourceRef.quote = '篡改';
      },
      (w) => {
        w.projects[0][1].study.mine.edges.j1.conclusion = 'missing';
      },
      (w) => {
        w.projects[0][1].study.mine.edges.j1.conclusion = 'p1';
      },
      (w) => {
        w.projects[0][1].study.sources.push(w.projects[0][1].study.sources[0]);
      },
      (w) => {
        w.aiThreads.push(['project-2:secret', { question: 'other project' }]);
      },
      (w) => {
        w.projects[0][1].canvasState.annotations.elements[0].link = 'javascript:alert(1)';
      },
      (w) => {
        delete w.projects[0][1].canvasState.annotations.elements[0].groupIds;
      },
      (w) => {
        delete w.projects[0][1].timeline.past[0].before;
      },
      (w) => {
        w.projects[0][1].study.mine.nodes.p1.materials = null;
      },
      (w) => {
        w.projects[0][1].study.mine.nodes.p1.materialExclusions = [
          { source: 'missing', version: 1 },
        ];
      },
      (w) => {
        w.projects[0][1].study.sources.find((s: any) => s.kind === 'image').width = 99;
      },
      (w) => {
        const n = w.projects[0][1].study.mine.nodes.p1,
          s = w.projects[0][1].study.sources.find((s: any) => s.kind === 'image');
        n.evidence.push({
          ...n.evidence[0],
          ref: {
            kind: 'image',
            source: s.id,
            version: s.version,
            width: 1,
            height: 1,
            region: { x: 0, y: 0, width: 2, height: 1 },
          },
        });
      },
    ];
    for (const mutate of invalid) {
      const workspace = fixture();
      mutate(workspace);
      expect(() => a.migration.preview(human, { workspace })).toThrow();
      expect(() =>
        a.migration.import(human, randomUUID(), { workspace, previewHash: preview.previewHash }),
      ).toThrow();
    }
    expect(() => a.migration.preview(agent, { workspace: original })).toThrow('本人');
    expect(() =>
      a.migration.import(agent, randomUUID(), {
        workspace: original,
        previewHash: preview.previewHash,
      }),
    ).toThrow('本人');
    expect(a.repo.listProjects()).toHaveLength(0);
    expect(a.db.prepare('SELECT count(*) AS n FROM operations').get()).toEqual({ n: 0 });
  } finally {
    a.db.close();
  }
});
it('写入中途失败原子回滚，明确受限材料不会经旧档副本绕过导出过滤', () => {
  const a = setup();
  try {
    const workspace = fixture();
    workspace.projects[0][1].study.sources[0].rights = 'restricted';
    const preview = a.migration.preview(human, { workspace }),
      input = { workspace, previewHash: preview.previewHash },
      key = randomUUID();
    a.db.exec(
      "CREATE TEMP TRIGGER fail_legacy_layout BEFORE INSERT ON layouts BEGIN SELECT RAISE(ABORT, 'synthetic disk failure'); END",
    );
    expect(() => a.migration.import(human, key, input)).toThrow('synthetic disk failure');
    expect(a.repo.listProjects()).toHaveLength(0);
    expect(a.db.prepare('SELECT count(*) AS n FROM file_assets').get()).toEqual({ n: 0 });
    expect(a.db.prepare('SELECT count(*) AS n FROM operations').get()).toEqual({ n: 0 });
    a.db.exec('DROP TRIGGER fail_legacy_layout');
    const result = a.migration.import(human, key, input);
    const archive = new AssetService(a.repo, a.write).export(result.project.id);
    expect(
      archive.files
        .filter((f) => f.mime === 'application/json')
        .every((f) => f.base64 === null && f.omission),
    ).toBe(true);
    expect(archive.materials.some((m) => m.text === null && m.omission)).toBe(true);
    expect(a.migration.record(result.project.id).workspace).toEqual(workspace);
  } finally {
    a.db.close();
  }
});
it('过时的推导引用和验证节点保留旧档，作者图不会因迁移变成个人采用', () => {
  const a = setup();
  try {
    const workspace = fixture(),
      study = workspace.projects[0][1].study;
    study.mine.nodes.p1.verificationNode.targetSignature = 'old';
    study.mine.edges.j1.evidence = [
      { ...study.mine.nodes.p1.evidence[0], targetVersion: 1, targetSignature: 'old-endpoints' },
    ];
    let preview = a.migration.preview(human, { workspace });
    let result = a.migration.import(human, randomUUID(), {
      workspace,
      previewHash: preview.previewHash,
    });
    expect(
      a.repo.snapshot(result.project.id).objects.filter((e) => e.kind === 'verification_node'),
    ).toHaveLength(0);
    expect(
      a.repo.snapshot(result.project.id).objects.filter((e) => e.kind === 'evidence_link'),
    ).toHaveLength(1);
    expect(result.report.issues.map((i) => i.code)).toContain('OLD_EVIDENCE_RETAINED');
    delete study.directCanvas;
    study.mine = null;
    preview = a.migration.preview(human, { workspace });
    result = a.migration.import(human, randomUUID(), {
      workspace,
      previewHash: preview.previewHash,
    });
    expect(
      a.repo
        .snapshot(result.project.id)
        .objects.filter((e) => e.kind === 'statement' || e.kind === 'inference')
        .every((e) => e.data.participation === 'reference'),
    ).toBe(true);
  } finally {
    a.db.close();
  }
});
it('HTTP 预览和提交使用相同校验，私有旧记录受本人会话与项目范围限制', async () => {
  const a = setup();
  try {
    const token = a.access.issue('human', ['*']),
      workspace = fixture();
    const request = (path: string, token: string, body?: unknown) =>
      a.app.request(`http://127.0.0.1:8787/api/v1${path}`, {
        method: body ? 'POST' : 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'Idempotency-Key': randomUUID(),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    const preview = await request('/prototype-migrations/preview', token, { workspace });
    expect(preview.status).toBe(200);
    const p = (await preview.json()).data;
    const committed = await request('/prototype-migrations', token, {
      workspace,
      previewHash: p.previewHash,
    });
    expect(committed.status).toBe(200);
    const result = (await committed.json()).data;
    expect(
      (await request(`/projects/${result.project.id}/prototype-migration`, token)).status,
    ).toBe(200);
    expect(
      (
        await request(
          `/projects/${result.project.id}/prototype-migration`,
          a.access.issue('human', ['other']),
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await request(
          '/prototype-migrations/preview',
          a.access.issue('agent', [result.project.id]),
          { workspace },
        )
      ).status,
    ).toBe(403);
  } finally {
    a.db.close();
  }
});

it('旧对象材料合并显式加入、出处和证据；隐藏固定版本且不丢引用或把参考对象变成个人采用', () => {
  const app = setup();
  try {
    const workspace = fixture(({ act, getStudy }: any) => {
      const image = getStudy().sources.find((s: any) => s.kind === 'image');
      act({ type: 'material-attach', id: 'p2', source: image.id, version: 1 });
      act({ type: 'material-remove', id: 'p1', source: image.id });
    });
    const preview = app.migration.preview(human, { workspace });
    expect(preview.report.converter).toBe('prototype-v1-to-project-v2');
    const result = app.migration.import(human, randomUUID(), {
      workspace,
      previewHash: preview.previewHash,
    });
    const mapped = (old: string, kind: string) =>
      result.report.mapping.find((m) => m.legacyId === old && m.kind === kind)!.id;
    const state = app.repo.snapshot(result.project.id),
      image = workspace.projects[0][1].study.sources.find((s: any) => s.kind === 'image');
    const sv = mapped(image.id + '@1', 'source_version'),
      p1 = mapped('p1', 'statement'),
      p2 = mapped('p2', 'statement');
    const member = (target: string) =>
      state.objects.find(
        (e) =>
          e.kind === 'material_membership' &&
          e.data.targetId === target &&
          e.data.sourceVersionId === sv,
      );
    expect(member(p1)?.data).toEqual({ targetId: p1, sourceVersionId: sv, visibility: 'excluded' });
    expect(member(p2)?.data).toEqual({ targetId: p2, sourceVersionId: sv, visibility: 'included' });
    expect(
      state.objects.filter(
        (e) =>
          e.kind === 'material_membership' &&
          e.data.targetId === p1 &&
          e.data.visibility === 'included',
      ),
    ).toHaveLength(2);
    const reference = state.objects.find((e) => e.kind === 'statement' && e.data.origin === 'ai')!;
    expect(reference.data).toMatchObject({
      participation: 'reference',
      stance: { value: 'pending' },
    });
    expect(state.objects.find((e) => e.id === p1)?.data).toMatchObject({
      stance: { value: 'questioned' },
    });
    expect(state.objects.filter((e) => e.kind === 'evidence_link')).toHaveLength(1);
    expect(result.report.issues.some((i) => i.code === 'MATERIAL_MEMBERSHIP_RETAINED')).toBe(false);
    expect(app.migration.record(result.project.id).workspace).toEqual(workspace);
  } finally {
    app.db.close();
  }
});

it('旧原图像素区域按自然尺寸迁移，重复原文件复用且证据与推导上下文随资产往返', async () => {
  const { createCanvas } = await import('@napi-rs/canvas');
  const image = createCanvas(100, 50);
  image.getContext('2d').fillStyle = '#246a91';
  image.getContext('2d').fillRect(0, 0, 100, 50);
  let imageId = '';
  const workspace = fixture(({ act, getStudy }: any) => {
    const material = {
      kind: 'image',
      title: '区域迁移测试',
      text: '',
      data: image.toDataURL('image/png'),
      width: 100,
      height: 50,
    };
    act({ type: 'material-add', id: 'p1', material });
    imageId = getStudy().sources.at(-1).id;
    const ref = {
      kind: 'image',
      source: imageId,
      version: 1,
      width: 100,
      height: 50,
      region: { x: 10, y: 10, width: 20, height: 15 },
      quote: '原图区域（人工框选，未进行 OCR）',
    };
    act({ type: 'material-evidence', id: 'p1', ref, effect: '尚待判断', reason: '' });
    act({ type: 'material-evidence', id: 'j1', ref, effect: '限定', reason: '只覆盖选中区间' });
    act({ type: 'material-add', id: 'p2', replaces: imageId, material });
    act({
      type: 'material-evidence',
      id: 'p2',
      ref: { ...ref, version: 2 },
      effect: '背景',
      reason: '',
    });
    act({ type: 'material-remove', id: 'p1', source: imageId });
  });
  const app = setup(),
    restored = setup();
  try {
    const preview = app.migration.preview(human, { workspace }),
      result = app.migration.import(human, randomUUID(), {
        workspace,
        previewHash: preview.previewHash,
      });
    const state = app.repo.snapshot(result.project.id),
      id = (old: string, kind: string) =>
        result.report.mapping.find((m) => m.legacyId === old && m.kind === kind)!.id;
    const sv1 = state.objects.find((e) => e.id === id(imageId + '@1', 'source_version'))!,
      sv2 = state.objects.find((e) => e.id === id(imageId + '@2', 'source_version'))!;
    expect(sv1.data).toMatchObject({ textOrigin: 'image_original', textLength: 0 });
    expect(sv2.data).toMatchObject({ fileId: (sv1.data as any).fileId });
    const images = state.objects.filter((e) => e.kind === 'evidence' && 'kind' in e.data.citation);
    expect(images).toHaveLength(3);
    expect(images[0]?.data).toMatchObject({
      citation: {
        kind: 'image',
        sourceVersionId: sv1.id,
        page: 1,
        imageWidth: 100,
        imageHeight: 50,
        region: { x: 0.1, y: 0.2, width: 0.2, height: 0.3 },
      },
    });
    expect((images[0]!.data as any).citation).not.toHaveProperty('quote');
    const target = state.objects.find((e) => e.id === id('j1', 'inference'))!;
    const link = state.objects.find(
      (e) => e.kind === 'evidence_link' && e.data.target.id === target.id,
    )!;
    expect(link.data).toMatchObject({
      relation: 'qualifies',
      context: (target.data as any).premiseIds
        .concat((target.data as any).conclusionId)
        .sort()
        .map((id: string) => ({
          id,
          versionId: state.objects.find((e) => e.id === id)!.contentVersionId,
        })),
    });
    expect(
      state.objects
        .filter(
          (e) =>
            e.kind === 'material_membership' &&
            e.data.targetId === id('p1', 'statement') &&
            [sv1.id, sv2.id].includes(e.data.sourceVersionId),
        )
        .map((e) => (e.data as any).visibility),
    ).toEqual(['excluded', 'excluded']);
    expect(result.report.issues.some((i) => i.code === 'IMAGE_REFERENCE_RETAINED')).toBe(false);
    expect(app.files.artifact(result.project.id, sv1.id)).toMatchObject({
      width: 100,
      height: 50,
      text: '',
    });
    const exported = new AssetService(app.repo, app.write).export(result.project.id);
    new ArchiveService(restored.write, restored.search).import(human, randomUUID(), exported);
    expect(restored.repo.snapshot(result.project.id)).toEqual(state);
    const previewImage = await restored.transcription.image(
      result.project.id,
      sv1.id,
      1,
      new AbortController().signal,
    );
    expect(previewImage.width).toBe(100);
    expect(previewImage.height).toBe(50);
  } finally {
    app.db.close();
    restored.db.close();
  }
});

it('静态 GIF 可定位；旧动图未记录帧号时保留引用而不冒认第一帧', () => {
  const frame = '21f90401000000002c0000000001000100000202440100';
  const gif = (frames: number) =>
    Buffer.from(
      '47494638396101000100800000000000ffffff' + frame.repeat(frames) + '3b',
      'hex',
    ).toString('base64');
  const workspace = fixture(({ act, getStudy }: any) => {
    for (const frames of [1, 2]) {
      act({
        type: 'material-add',
        id: 'p1',
        material: {
          kind: 'image',
          title: `${frames} 帧`,
          text: '',
          data: 'data:image/gif;base64,' + gif(frames),
          width: 1,
          height: 1,
        },
      });
      act({
        type: 'material-evidence',
        id: 'p1',
        effect: '尚待判断',
        reason: '',
        ref: {
          kind: 'image',
          source: getStudy().sources.at(-1).id,
          version: 1,
          width: 1,
          height: 1,
          region: { x: 0, y: 0, width: 1, height: 1 },
          quote: '原图区域（人工框选，未进行 OCR）',
        },
      });
    }
  });
  const app = setup();
  try {
    const preview = app.migration.preview(human, { workspace });
    expect(preview.report.issues.filter((i) => i.code === 'IMAGE_REFERENCE_RETAINED')).toHaveLength(
      1,
    );
    const result = app.migration.import(human, randomUUID(), {
      workspace,
      previewHash: preview.previewHash,
    });
    const state = app.repo.snapshot(result.project.id);
    expect(
      state.objects.filter((e) => e.kind === 'evidence' && 'kind' in e.data.citation),
    ).toHaveLength(1);
    expect(app.migration.record(result.project.id).workspace).toEqual(workspace);
  } finally {
    app.db.close();
  }
});

it('旧转换器迁移记录恢复后仍可读取；重复原文件必须在只读校验时拒绝', () => {
  const app = setup(),
    restored = setup();
  try {
    const workspace = fixture(),
      preview = app.migration.preview(human, { workspace });
    const result = app.migration.import(human, randomUUID(), {
      workspace,
      previewHash: preview.previewHash,
    });
    const archive = new AssetService(app.repo, app.write).export(result.project.id);
    const report = archive.files.find(
      (f) => f.name === 'forkwise-prototype-migration-report.json',
    )!;
    const old = JSON.parse(Buffer.from(report.base64!, 'base64').toString());
    old.converter = 'prototype-v1-to-project-v1';
    const bytes = Buffer.from(JSON.stringify(old));
    report.base64 = bytes.toString('base64');
    report.hash = createHash('sha256').update(bytes).digest('hex');
    const restore = new ArchiveService(restored.write, restored.search);
    restore.import(human, randomUUID(), archive);
    expect(restored.migration.record(result.project.id).report.converter).toBe(
      'prototype-v1-to-project-v1',
    );
    expect(restored.migration.record(result.project.id).workspace).toEqual(workspace);
    const duplicate = structuredClone(archive);
    duplicate.files.push({ ...duplicate.files[0]!, id: randomUUID() });
    expect(() => restore.validate(ArchiveSchema.parse(duplicate))).toThrow(
      '同一来源的原文件指纹重复',
    );
  } finally {
    app.db.close();
    restored.db.close();
  }
});
