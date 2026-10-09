import { prototypeMaterialMemberships } from './prototype-migration-materials.js';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { ArchiveSchema, type Archive } from '../contracts/assets.js';
import {
  BodySchemas,
  ImageCitation,
  Time,
  type Actor,
  type AnyEntity,
  type Bodies,
  type Kind,
} from '../contracts/entities.js';
import { LayoutData } from '../contracts/layout.js';
import {
  PrototypeMigrationInput,
  PrototypeMigrationCommit,
  MigrationReport,
  type Report,
} from '../contracts/prototype-migration.js';
import { assertGraph } from '../domain/graph.js';
import { requireThat } from '../domain/errors.js';
import { canonical, digest, type GraphWriteService } from './graph-write.js';
import { ArchiveService } from './archive.js';
import type { SearchRepository } from '../repositories/search.js';
import { migratePrototypeCanvas } from './prototype-migration-canvas.js';
import { rasterImage } from './raster-image.js';
import { prototypeImageIsStatic } from './prototype-image.js';

const record = z.record(z.string(), z.unknown());
const legacyId = z.string().min(1).max(200);
const sourceSchema = z
  .object({ id: legacyId, version: z.number().int().positive(), text: z.string().max(5_000_000) })
  .passthrough();
const nodeSchema = z
  .object({
    id: legacyId,
    type: z.enum(['claim', 'inference']),
    text: z.string().max(100_000),
    x: z.number().finite(),
    y: z.number().finite(),
    version: z.number().int().positive(),
    history: z.array(record),
    evidence: z.array(record),
    notes: z.array(record),
    stanceHistory: z.array(record).optional(),
    correctionHistory: z.array(record).optional(),
  })
  .passthrough();
const graphSchema = z
  .object({ nodes: z.record(z.string(), nodeSchema), edges: z.record(z.string(), nodeSchema) })
  .passthrough();
const studySchema = z
  .object({
    question: z.string().max(100_000),
    sources: z.array(sourceSchema),
    author: graphSchema,
    mine: graphSchema.nullable().optional(),
    baseline: graphSchema.nullable().optional(),
    directCanvas: z.boolean().optional(),
  })
  .passthrough();
const snapshotSchema = z
  .object({ study: studySchema, canvasState: record, view: record })
  .passthrough();
const timelineEntrySchema = z
  .object({ label: z.string(), before: snapshotSchema, after: snapshotSchema })
  .passthrough();
const projectSchema = z
  .object({
    name: z.string().min(1).max(60).optional(),
    study: studySchema,
    canvasState: record,
    view: record,
    formCache: record,
    composer: record,
    readerDraft: record,
    timeline: z
      .object({ past: z.array(timelineEntrySchema), future: z.array(timelineEntrySchema) })
      .passthrough(),
  })
  .passthrough();
const workspaceSchema = z
  .object({
    format: z.literal('forkwise-prototype-workspace'),
    version: z.literal(1),
    activeProjectId: legacyId,
    projectSerial: z.number().int().positive(),
    openProjectIds: z.array(legacyId).optional(),
    navPinned: z.boolean().optional(),
    projects: z.array(z.tuple([legacyId, projectSchema])).length(1),
    aiThreads: z.array(z.tuple([legacyId, record])).optional(),
  })
  .strict();
type LegacyNode = z.infer<typeof nodeSchema>;
type LegacySource = z.infer<typeof sourceSchema>;
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const object = (v: unknown): Record<string, unknown> => record.parse(v);
const list = (v: unknown): unknown[] => z.array(z.unknown()).parse(v);
const str = (v: unknown) => z.string().parse(v);
const time = (v: unknown): string | null => (Time.safeParse(v).success ? (v as string) : null);
const recoveryName = 'forkwise-prototype-recovery.json';
const reportName = 'forkwise-prototype-migration-report.json';

/** Explicit conversion only. No imported code, network requests or job execution. */
export class PrototypeMigrationService {
  constructor(
    readonly write: GraphWriteService,
    readonly search: SearchRepository,
  ) {}
  preview(actor: Actor, raw: unknown) {
    requireThat(actor.type === 'human', 'HUMAN_REQUIRED', '旧版研究迁移须由本人发起', 403);
    const { workspace } = PrototypeMigrationInput.parse(raw);
    const prepared = preparePrototype(workspace, this.write.clock());
    // Validate exactly the archive that commit will restore, without writing.
    new ArchiveService(this.write, this.search).validate(prepared.archive);
    return { report: prepared.report, previewHash: digest(prepared.report) };
  }
  import(actor: Actor, key: string, raw: unknown) {
    requireThat(actor.type === 'human', 'HUMAN_REQUIRED', '旧版研究迁移须由本人发起', 403);
    const input = PrototypeMigrationCommit.parse(raw);
    return this.write.idempotent(actor, '__prototype_imports__', key, input, () => {
      const prepared = preparePrototype(input.workspace, this.write.clock());
      requireThat(
        digest(prepared.report) === input.previewHash,
        'MIGRATION_PREVIEW_CHANGED',
        '副本或转换规则已变化，请重新预览',
        409,
      );
      const imported = new ArchiveService(this.write, this.search).import(
        actor,
        key,
        prepared.archive,
      );
      return {
        project: imported.project,
        report: prepared.report,
        recoveryFileId: prepared.recoveryFileId,
      };
    });
  }
  record(projectId: string) {
    this.write.repo.project(projectId);
    const files = this.write.repo.db
      .prepare('SELECT name,bytes FROM file_assets WHERE project_id=? AND name IN (?,?) AND mime=?')
      .all(projectId, recoveryName, reportName, 'application/json') as {
      name: string;
      bytes: Buffer;
    }[];
    requireThat(
      files.length === 2 && files.every((f) => f.bytes.length),
      'MIGRATION_RECORD_MISSING',
      '此项目没有可读取的旧版迁移记录',
      404,
    );
    const workspace: unknown = JSON.parse(
      files.find((f) => f.name === recoveryName)!.bytes.toString('utf8'),
    );
    workspaceSchema.parse(workspace);
    const report = MigrationReport.parse(
      JSON.parse(files.find((f) => f.name === reportName)!.bytes.toString('utf8')),
    );
    requireThat(
      report.projectId === projectId && report.sourceHash === digest(workspace),
      'MIGRATION_RECORD_INVALID',
      '旧版恢复副本与迁移说明不匹配',
    );
    return { workspace: workspace as Record<string, unknown>, report };
  }
}

export function preparePrototype(
  raw: unknown,
  importedAt: string,
): { archive: Archive; report: Report; recoveryFileId: string } {
  // Validate with parsed views but preserve every legacy project field verbatim.
  requireThat(
    Buffer.byteLength(JSON.stringify(raw)) <= 25_000_000,
    'LEGACY_PROJECT_TOO_LARGE',
    '单个旧版项目超过 25 MB，请保留原副本；当前迁移入口无法处理此大小',
    413,
  );
  const workspace = workspaceSchema.parse(raw),
    [oldProjectId, project] = workspace.projects[0]!;
  requireThat(
    workspace.activeProjectId === oldProjectId &&
      (!workspace.openProjectIds || workspace.openProjectIds.every((id) => id === oldProjectId)),
    'LEGACY_SCOPE',
    '迁移副本只能包含选中的一个项目',
  );
  requireThat(
    (workspace.aiThreads ?? []).every(([key]) => key.startsWith(`${oldProjectId}:`)),
    'LEGACY_SCOPE',
    '讨论草稿不能来自其他项目',
  );
  requireThat(
    /^project-[1-9]\d*$/.test(oldProjectId) &&
      Number(oldProjectId.slice(8)) <= workspace.projectSerial,
    'LEGACY_ID',
    '旧版项目标识无效',
  );
  const sourceHash = digest(raw),
    projectId = `legacy_${sourceHash.slice(0, 40)}`;
  const id = (...parts: unknown[]) => `l_${sha(canonical([projectId, ...parts])).slice(0, 40)}`;
  const study = project.study;
  // D65: an existing personal graph was adopted explicitly; an author-only
  // graph remains reference material when brought onto the D66 research canvas.
  const graph = study.mine ?? study.author;
  const fromAuthor = !study.mine;
  const report: Report = {
    converter: 'prototype-v1-to-project-v2',
    sourceHash,
    legacyProjectId: oldProjectId,
    projectId,
    name: project.name ?? [...(study.question.trim() || '旧版研究')].slice(0, 24).join(''),
    counts: {},
    mapping: [],
    issues: [],
    retained: [
      '作者整理原版与初始对照',
      '旧对象内容、立场及校正历史',
      '撤销与重做快照',
      '输入、编辑和 AI 讨论草稿',
      '材料元数据及未转换的引用',
      '原画布状态',
    ],
  };
  const issue = (path: string, code: string, message: string) => {
    report.issues.push({ path, code, message });
  };
  issue(
    'study',
    'LEGACY_HISTORY',
    '新后端从导入时建立 v1；旧版本和撤销记录保存在旧版副本，未伪造为后端审计历史。',
  );
  issue(
    'study.sources',
    'LEGACY_TIME',
    '无法严格识别的发布时间保留为未知；获取时间缺失时记录本次导入时间，原字段保留在旧档。',
  );
  const archive: Archive = {
    format: 'forkwise-project',
    schemaVersion: 1,
    exportedAt: importedAt,
    project: {
      id: projectId,
      name: report.name,
      question: study.question,
      revision: 1,
      createdAt: importedAt,
      deletedAt: null,
    },
    objects: [],
    versions: [],
    materials: [],
    files: [],
    artifacts: [],
    tasks: [],
    judgments: [],
    workflowGroups: [],
    layout: { version: 1, data: { positions: {}, drawings: [] } },
  };
  const add = <K extends Kind>(kind: K, key: unknown[], data: Bodies[K]) => {
    const entity = {
      id: id(kind, ...key),
      projectId,
      kind,
      data: BodySchemas[kind].parse(data),
      version: 1,
      versionId: id('version', kind, ...key),
      contentVersionId: id('version', kind, ...key),
      createdAt: importedAt,
      updatedAt: importedAt,
      deletedAt: null,
    } as AnyEntity;
    archive.objects.push(entity);
    archive.versions.push({ snapshot: entity, actor: { id: 'legacy_import', type: 'system' } });
    return entity;
  };
  const addFile = (
    sourceId: string,
    key: unknown[],
    name: string,
    mime: string,
    bytes: Buffer,
    retrievedAt = importedAt,
    publishedAt: string | null = null,
  ) => {
    requireThat(bytes.length <= 25_000_000, 'LEGACY_FILE_TOO_LARGE', '旧档原文件超过 25 MB', 413);
    const hash = sha(bytes),
      existing = archive.files.find((f) => f.sourceId === sourceId && f.hash === hash);
    if (existing) {
      requireThat(existing.mime === mime, 'LEGACY_FILE_INVALID', '同一原文件被标记为不同类型');
      return existing.id;
    }
    const fileId = id('file', ...key);
    archive.files.push({
      id: fileId,
      sourceId,
      name,
      mime,
      hash,
      base64: bytes.toString('base64'),
      retrievedAt,
      publishedAt,
    });
    return fileId;
  };
  const sources = new Map<
    string,
    {
      legacy: LegacySource;
      version: AnyEntity;
      image?: { width: number; height: number; static: boolean };
    }
  >();
  const sourceIds = new Map<string, string>();
  const restricted = new Set(
    study.sources.filter((s) => s.rights === 'restricted').map((s) => s.id),
  );
  for (const source of study.sources) {
    const key = canonical([source.id, source.version]);
    requireThat(!sources.has(key), 'LEGACY_SOURCE_DUPLICATE', '旧版材料版本重复');
    let sourceId = sourceIds.get(source.id);
    if (!sourceId) {
      const url = typeof source.originalUrl === 'string' ? source.originalUrl : '';
      const usableUrl =
        /^https?:\/\//i.test(url) &&
        z.url().safeParse(url).success &&
        !new URL(url).username &&
        !new URL(url).password;
      const e = add('source', [source.id], {
        title:
          typeof source.title === 'string' && source.title.trim()
            ? source.title
            : `旧版材料 ${source.id}`,
        publisher: typeof source.author === 'string' ? source.author : '',
        rights: restricted.has(source.id) ? 'restricted' : 'authorized',
        ...(usableUrl ? { url } : {}),
      });
      sourceId = e.id;
      sourceIds.set(source.id, sourceId);
      if (url && !usableUrl)
        issue(
          `sources.${source.id}`,
          'SOURCE_URL_RETAINED',
          '无法识别的来源地址保留在旧档，未设置可点击链接。',
        );
    }
    const retrievedAt = time(source.acquired) ?? importedAt,
      publishedAt = time(source.published);
    let fileId: string | undefined;
    let image: { width: number; height: number; static: boolean } | undefined;
    if (source.kind === 'image' || source.kind === 'pdf') {
      const match = str(source.data).match(
        /^data:(image\/(?:png|jpeg|gif|webp)|application\/pdf);base64,([A-Za-z0-9+/=]+)$/,
      );
      requireThat(
        match &&
          (source.kind === 'pdf' ? match[1] === 'application/pdf' : match[1]!.startsWith('image/')),
        'LEGACY_FILE_INVALID',
        '旧版原文件类型或编码无效',
      );
      const bytes = Buffer.from(match[2]!, 'base64');
      requireThat(
        bytes.length && bytes.toString('base64') === match[2],
        'LEGACY_FILE_INVALID',
        '旧版原文件编码无效',
      );
      if (source.kind === 'image') {
        const actual = rasterImage(bytes, match[1]!);
        requireThat(
          actual.width === source.width && actual.height === source.height,
          'LEGACY_IMAGE_DIMENSIONS',
          '旧版图像尺寸与原文件不符，请保留副本并核对原图',
        );
        image = {
          width: actual.width,
          height: actual.height,
          static: prototypeImageIsStatic(bytes, match[1]!),
        };
      }
      fileId = addFile(
        sourceId,
        [source.id, source.version],
        `legacy-${source.id.slice(0, 70)}-v${source.version}.${match[1]!.split('/')[1]}`,
        match[1]!,
        bytes,
        retrievedAt,
        publishedAt,
      );
      issue(
        `sources.${source.id}.v${source.version}`,
        'LEGACY_FILE_TEXT',
        '原文件和已有文本分别保留；旧解析文本未当作已核验转写。',
      );
    } else
      requireThat(
        source.kind === undefined || source.kind === 'text',
        'LEGACY_SOURCE_KIND',
        '旧档含未知材料类型',
      );
    const version = add('source_version', [source.id, source.version], {
      sourceId,
      contentHash: sha(source.text),
      textLength: source.text.length,
      retrievedAt,
      publishedAt,
      parseStatus: 'partial',
      parseMessage: '旧版导入；原文按旧档保存，旧解析状态和时间未经重新核验。',
      ...(fileId ? { fileId } : {}),
      ...(image && source.text === '' ? { textOrigin: 'image_original' as const } : {}),
    });
    archive.materials.push({ id: version.id, text: source.text });
    if (image)
      archive.artifacts.push({
        sourceVersionId: version.id,
        fileId: fileId!,
        data: {
          text: source.text,
          status: 'partial',
          normalizerVersion: 'legacy-image@2',
          page: 1,
          pageCount: 1,
          width: image.width,
          height: image.height,
          gaps: [
            '旧版文本未经重新转写或核验；原文件保留。',
            ...(!image.static ? ['当前读取显示第一帧；旧引用未记录帧号，需重新定位。'] : []),
          ],
        },
      });
    sources.set(key, { legacy: source, version, ...(image ? { image } : {}) });
    report.mapping.push({
      legacyId: `${source.id}@${source.version}`,
      id: version.id,
      kind: 'source_version',
    });
  }
  function citation(rawRef: unknown, path: string): Bodies['evidence']['citation'] | undefined {
    if (!rawRef) return;
    const r = object(rawRef),
      source = sources.get(canonical([r.source, r.version]));
    requireThat(source, 'LEGACY_CITATION_SOURCE', `旧版引用的材料版本缺失：${path}`);
    if (r.kind === 'image') {
      requireThat(
        source.image && r.width === source.image.width && r.height === source.image.height,
        'LEGACY_IMAGE_DIMENSIONS',
        `旧版图像引用尺寸与原文件不符：${path}`,
      );
      const region = z
        .object({
          x: z.number().finite().nonnegative(),
          y: z.number().finite().nonnegative(),
          width: z.number().finite().positive(),
          height: z.number().finite().positive(),
        })
        .parse(r.region);
      const { width, height } = source.image;
      const converted = ImageCitation.parse({
        kind: 'image',
        sourceVersionId: source.version.id,
        fileId: (source.version.data as Bodies['source_version']).fileId,
        page: 1,
        imageWidth: width,
        imageHeight: height,
        region: {
          x: region.x / width,
          y: region.y / height,
          width: region.width / width,
          height: region.height / height,
        },
      });
      if (!source.image.static) {
        issue(
          path,
          'IMAGE_REFERENCE_RETAINED',
          '旧图像的帧号无法确定；原文件和引用保留在旧档，请对照当前第一帧重新定位。',
        );
        return;
      }
      return converted;
    }
    const c = {
      sourceVersionId: source.version.id,
      start: z.number().int().nonnegative().parse(r.start),
      end: z.number().int().positive().parse(r.end),
      quote: str(r.quote),
    };
    requireThat(
      c.start < c.end && c.quote && source.legacy.text.slice(c.start, c.end) === c.quote,
      'LEGACY_CITATION_MISMATCH',
      `旧版引用与原文不符：${path}`,
    );
    return c;
  }
  const all = [...Object.entries(graph.nodes), ...Object.entries(graph.edges)];
  const mapped = new Map<string, AnyEntity>();
  for (const [oldId, n] of all) {
    requireThat(
      n.id === oldId &&
        !mapped.has(oldId) &&
        (graph.nodes[oldId] ? n.type === 'claim' : n.type === 'inference'),
      'LEGACY_OBJECT_ID',
      '旧版对象身份或图结构不一致',
    );
    const originKey =
      n.originKind ??
      (n.origin === 'AI 推断'
        ? 'ai'
        : n.origin === '作者表达'
          ? 'source'
          : ['本人补充', '本人推导'].includes(String(n.origin))
            ? 'user'
            : undefined);
    requireThat(
      ['ai', 'source', 'user'].includes(String(originKey)),
      'LEGACY_ORIGIN',
      '旧版对象的内容归属无法识别',
    );
    const origin: Bodies['statement']['origin'] =
      originKey === 'source' ? 'author' : (originKey as 'ai' | 'user');
    const research =
      !fromAuthor &&
      (n.researchUse === 'research' ||
        (!study.directCanvas && n.researchUse === undefined) ||
        (n.researchUse === undefined && origin === 'user'));
    requireThat(
      n.researchUse === undefined || ['research', 'reference'].includes(String(n.researchUse)),
      'LEGACY_PARTICIPATION',
      '旧版对象的研究参与状态无法识别',
    );
    const stanceValue = {
      待研究: 'pending',
      认可: 'accepted',
      质疑: 'questioned',
      不认可: 'rejected',
    }[String(n.stance)] as Bodies['statement']['stance']['value'] | undefined;
    requireThat(stanceValue, 'LEGACY_STANCE', '旧版个人立场无法识别');
    requireThat(
      research || stanceValue === 'pending',
      'LEGACY_STANCE_SCOPE',
      '参考内容含个人立场，需先在旧原型确认研究归属',
    );
    const c = citation(n.sourceRef, `objects.${oldId}.sourceRef`);
    const common = {
      origin,
      participation: research ? ('personal' as const) : ('reference' as const),
      stance: { value: stanceValue, reason: typeof n.reason === 'string' ? n.reason : '' },
      citations: c ? [c] : [],
    };
    let e: AnyEntity;
    if (n.type === 'claim') e = add('statement', [oldId], { text: n.text, ...common });
    else {
      const premises = z.array(legacyId).min(1).max(100).parse(n.premises),
        conclusion = legacyId.parse(n.conclusion);
      const combination = {
        共同依赖: 'joint_required',
        单一前提: 'independent',
        组合待说明: 'unspecified',
        尚待说明: 'unspecified',
      }[str(n.combination)] as Bodies['inference']['combination'] | undefined;
      requireThat(combination, 'LEGACY_COMBINATION', '旧版前提组合无法识别');
      e = add('inference', [oldId], {
        premiseIds: premises.map((p) => id('statement', p)),
        conclusionId: id('statement', conclusion),
        reason: n.text,
        combination,
        ...common,
      });
    }
    mapped.set(oldId, e);
    report.mapping.push({ legacyId: oldId, id: e.id, kind: e.kind });
    archive.layout.data.positions[e.id] = { x: n.x, y: n.y };
    if (n.verification)
      issue(
        `objects.${oldId}.verification`,
        'LEGACY_CHECK_RETAINED',
        '旧版查证含模拟结果，仅保留旧档，未转换成当前查证或人工判断。',
      );
    if (n.localOf || n.base || n.copiedFrom)
      issue(
        `objects.${oldId}`,
        'LEGACY_LINEAGE_RETAINED',
        '旧版内容来历保留在对照记录，未伪造新的内容版本引用。',
      );
  }
  const signature = (n: LegacyNode) =>
    JSON.stringify([
      n.id,
      n.version,
      n.text,
      n.type === 'inference'
        ? list(n.premises).map((p) => {
            const x = graph.nodes[str(p)]!;
            return [p, x.version, x.text];
          })
        : null,
      n.type === 'inference'
        ? [
            n.conclusion,
            graph.nodes[str(n.conclusion)]!.version,
            graph.nodes[str(n.conclusion)]!.text,
            n.combination,
          ]
        : null,
    ]);
  // Check endpoints and cycles before evaluating version signatures.
  assertGraph(new Map(archive.objects.map((e) => [e.id, e])));
  for (const [oldId, n] of all) {
    const target = mapped.get(oldId)!,
      ref = { id: target.id, versionId: target.contentVersionId };
    for (const membership of prototypeMaterialMemberships(n)) {
      const source = sources.get(canonical([membership.source, membership.version]));
      requireThat(
        source,
        'LEGACY_MATERIAL_REFERENCE',
        `旧对象材料的指定版本缺失：objects.${oldId}.${membership.source}@${membership.version}`,
      );
      add('material_membership', [oldId, membership.source, membership.version], {
        targetId: target.id,
        sourceVersionId: source.version.id,
        visibility: membership.visibility,
      });
    }
    for (const [index, note] of n.notes.entries()) {
      if (
        typeof note.text === 'string' &&
        note.text.trim() &&
        (note.version === undefined || note.version === n.version)
      )
        add('note', [oldId, index], { targetId: target.id, text: note.text });
      else
        issue(
          `objects.${oldId}.notes.${index}`,
          'OLD_NOTE_RETAINED',
          '旧内容上的问题或非文本批注保留在旧档，未绑定到当前内容。',
        );
    }
    for (const [index, ev] of n.evidence.entries()) {
      const c = citation(ev.ref, `objects.${oldId}.evidence.${index}`);
      if (!c) continue;
      const evidence = add('evidence', [oldId, index], { citation: c });
      if (
        ev.targetVersion !== n.version ||
        (n.type === 'inference' && ev.targetSignature !== signature(n)) ||
        (ev.targetSignature !== undefined && ev.targetSignature !== signature(n))
      ) {
        issue(
          `objects.${oldId}.evidence.${index}`,
          'OLD_EVIDENCE_RETAINED',
          '证据原文已迁移；旧关联无法确定对应当前内容，保留旧档待重新关联。',
        );
        continue;
      }
      const relation = {
        支持: 'supports',
        反驳: 'opposes',
        限定: 'qualifies',
        背景: 'background',
        尚待判断: 'unjudged',
      }[String(ev.effect)] as Bodies['evidence_link']['relation'] | undefined;
      requireThat(relation, 'LEGACY_EVIDENCE_RELATION', '旧版证据作用无法识别');
      add('evidence_link', [oldId, index], {
        evidenceId: evidence.id,
        target: ref,
        context:
          target.kind === 'inference'
            ? [...new Set([...target.data.premiseIds, target.data.conclusionId])]
                .sort()
                .map((i) => ({
                  id: i,
                  versionId: archive.objects.find((e) => e.id === i)!.contentVersionId,
                }))
            : [],
        relation,
        explanation:
          typeof ev.reason === 'string' && ev.reason.trim()
            ? ev.reason
            : '从旧版迁入的引用；未记录进一步说明。',
        origin: 'human',
        participation: 'adopted',
      });
    }
    if (n.verificationNode) {
      const v = object(n.verificationNode);
      if (v.by === 'user' && v.targetVersion === n.version && v.targetSignature === signature(n)) {
        const context =
          target.kind === 'inference'
            ? [...new Set([...target.data.premiseIds, target.data.conclusionId])]
                .sort()
                .map((i) => ({
                  id: i,
                  versionId: archive.objects.find((e) => e.id === i)!.contentVersionId,
                }))
            : [];
        add('verification_node', [oldId], {
          target: ref,
          context,
          status: 'confirmed',
          gaps: [],
          event: str(v.event),
          goal: str(v.goal),
          period: str(v.period) || null,
          date: str(v.date) || null,
        });
      } else
        issue(
          `objects.${oldId}.verificationNode`,
          'OLD_VERIFICATION_RETAINED',
          '验证节点对应旧内容或端点，已保留旧档，未标为当前本人确认。',
        );
    }
  }
  archive.layout.data = LayoutData.parse({
    ...archive.layout.data,
    ...migratePrototypeCanvas(
      project.canvasState,
      oldProjectId,
      projectId,
      mapped,
      graph,
      fromAuthor,
      issue,
    ),
  });
  assertGraph(new Map(archive.objects.map((e) => [e.id, e])));
  report.counts = Object.fromEntries(
    Object.keys(BodySchemas).map((kind) => [
      kind,
      archive.objects.filter((e) => e.kind === kind).length,
    ]),
  );
  report.counts.drawings = archive.layout.data.canvas?.annotations.elements.length ?? 0;
  report.counts.imageEvidence = archive.objects.filter(
    (e) => e.kind === 'evidence' && 'kind' in e.data.citation && e.data.citation.kind === 'image',
  ).length;
  report.counts.includedMaterials = archive.objects.filter(
    (e) => e.kind === 'material_membership' && e.data.visibility === 'included',
  ).length;
  report.counts.excludedMaterials = archive.objects.filter(
    (e) => e.kind === 'material_membership' && e.data.visibility === 'excluded',
  ).length;
  report.counts.legacyUndo = project.timeline.past.length;
  report.counts.legacyRedo = project.timeline.future.length;
  report.counts.legacyHistory = all.reduce((n, [, value]) => n + value.history.length, 0);
  if (restricted.size)
    issue(
      'study.sources',
      'RESTRICTED_RECOVERY',
      '副本含明确标记为受限的来源，项目 JSON 导出将省略相关原文及完整旧版副本。',
    );
  const recovery = add('source', ['legacy-recovery'], {
    title: '旧版研究完整副本与迁移说明',
    publisher: '本人导入；历史身份未经外部认证',
    rights: restricted.size ? 'restricted' : 'authorized',
  });
  const recoveryFileId = addFile(
    recovery.id,
    ['recovery'],
    recoveryName,
    'application/json',
    Buffer.from(JSON.stringify(raw)),
  );
  addFile(
    recovery.id,
    ['report'],
    reportName,
    'application/json',
    Buffer.from(JSON.stringify(report)),
  );
  return { archive: ArchiveSchema.parse(archive), report, recoveryFileId };
}
