import { rasterImage } from '../services/raster-image.js';
import { createHash } from 'node:crypto';
import { randomUUID } from 'node:crypto';
import {
  BodySchemas,
  isImageCitation,
  type Actor,
  type AnyEntity,
  type Bodies,
  type Entity,
  type Kind,
  type Citation,
  type Ref,
} from '../contracts/entities.js';
import type { z } from 'zod';
import type { ResearchRepository } from '../repositories/research.js';
import { requireThat } from './errors.js';
import { ofKind } from './graph.js';

export class WriteContext {
  readonly original: Map<string, AnyEntity>;
  readonly objects: Map<string, AnyEntity>;
  readonly texts = new Map<string, string>();
  constructor(
    readonly repo: ResearchRepository,
    readonly projectId: string,
    readonly actor: Actor,
    readonly expected: Record<string, number>,
    readonly now: string,
    readonly controlledResult = false,
  ) {
    this.original = new Map(repo.objects(projectId).map((e) => [e.id, e]));
    this.objects = new Map(structuredClone([...this.original]));
    for (const [id, version] of Object.entries(expected)) {
      const e = this.original.get(id);
      requireThat(
        e && !e.deletedAt && e.version === version,
        'VERSION_CONFLICT',
        '对象已经改变，请重新读取并保留草稿',
        409,
      );
    }
  }
  read<K extends Kind>(id: string, kind: K): Entity<K> {
    this.expect(id);
    return ofKind(this.objects, id, kind);
  }
  readTarget(id: string): Entity<'statement'> | Entity<'inference'> {
    this.expect(id);
    const e = this.get(id);
    requireThat(
      e.kind === 'statement' || e.kind === 'inference',
      'INVALID_TARGET',
      '目标必须为陈述或推导',
    );
    return e;
  }
  expect(id: string): void {
    const e = this.original.get(id);
    if (e)
      requireThat(
        this.expected[id] === e.version,
        'RELATED_VERSION_REQUIRED',
        '缺少相关对象的当前版本，请重新读取',
        409,
      );
  }
  human(): void {
    requireThat(
      this.actor.type === 'human',
      'HUMAN_REQUIRED',
      '此操作需要本人确认，Agent 不能代替研究者判断',
      403,
    );
  }
  personalRecord(): void {
    if (this.actor.type === 'human') return;
    const rows = this.repo.db
      .prepare(
        "SELECT projects,capabilities FROM sessions WHERE actor_id=? AND type='agent' AND expires_at>?",
      )
      .all(this.actor.id, this.now) as { projects: string; capabilities: string }[];
    requireThat(
      rows.some(
        (r) =>
          JSON.parse(r.projects).includes(this.projectId) &&
          (JSON.parse(r.capabilities).personalRecordProjects ?? []).includes(this.projectId),
      ),
      'HUMAN_REQUIRED',
      '需要本人签发当前项目的个人记录委托',
      403,
    );
    this.actor.delegation = {
      projectId: this.projectId,
      capability: 'personal_record',
      issuedBy: 'local-owner',
    };
  }
  get(id: string): AnyEntity {
    const e = this.objects.get(id);
    requireThat(e && !e.deletedAt, 'OBJECT_NOT_FOUND', '研究对象不存在', 404);
    return e;
  }
  add<K extends Kind>(id: string, kind: K, data: Bodies[K]): Entity<K> {
    requireThat(
      !this.objects.has(id),
      'IDENTITY_EXISTS',
      '对象身份已存在，请复用或使用新的身份',
      409,
    );
    const versionId = randomUUID();
    const e = {
      id,
      projectId: this.projectId,
      kind,
      data: BodySchemas[kind].parse(data),
      version: 1,
      versionId,
      contentVersionId: versionId,
      createdAt: this.now,
      updatedAt: this.now,
      deletedAt: null,
    } as Entity<K>;
    this.objects.set(id, e as AnyEntity);
    return e;
  }
  change<K extends Kind>(e: Entity<K>, data: Bodies[K], contentChanged: boolean): Entity<K> {
    this.expect(e.id);
    const valid = BodySchemas[e.kind].parse(data) as Bodies[K];
    if (JSON.stringify(e.data) === JSON.stringify(valid)) return e;
    const base = this.original.get(e.id);
    const versionId = base?.versionId === e.versionId ? randomUUID() : e.versionId;
    const next = {
      ...e,
      data: valid,
      version: base ? base.version + 1 : 1,
      versionId,
      contentVersionId: contentChanged ? versionId : e.contentVersionId,
      updatedAt: this.now,
    };
    this.objects.set(e.id, next as AnyEntity);
    return next;
  }
  remove(e: AnyEntity): void {
    this.expect(e.id);
    const base = this.original.get(e.id);
    this.objects.set(e.id, {
      ...e,
      version: base ? base.version + 1 : 1,
      versionId: randomUUID(),
      updatedAt: this.now,
      deletedAt: this.now,
    });
  }
  pinned(ref: z.infer<typeof Ref>): AnyEntity {
    const current = this.objects.get(ref.id);
    const value =
      current && (current.versionId === ref.versionId || current.contentVersionId === ref.versionId)
        ? current
        : this.repo.version(this.projectId, ref.id, ref.versionId);
    requireThat(value, 'VERSION_NOT_FOUND', '引用的对象版本不在当前项目中', 422);
    return value;
  }
  citation(c: z.infer<typeof Citation>): void {
    if (isImageCitation(c)) {
      requireThat(
        !c.unavailableReason,
        'CITATION_UNAVAILABLE',
        '原图不可复核，请补齐有权使用的原文件',
      );
      const version = ofKind(this.objects, c.sourceVersionId, 'source_version');
      const file = this.repo.db
        .prepare('SELECT bytes,mime,hash,source_id FROM file_assets WHERE project_id=? AND id=?')
        .get(this.projectId, c.fileId) as
        | { bytes: Buffer; mime: string; hash: string; source_id: string }
        | undefined;
      requireThat(
        version.data.fileId === c.fileId &&
          file &&
          file.source_id === version.data.sourceId &&
          createHash('sha256').update(file.bytes).digest('hex') === file.hash,
        'INVALID_IMAGE_CITATION',
        '原图与材料版本不匹配',
      );
      const image = rasterImage(file.bytes, file.mime);
      requireThat(
        image.width === c.imageWidth && image.height === c.imageHeight,
        'INVALID_IMAGE_CITATION',
        '引用尺寸与原图不一致',
      );
      return;
    }
    requireThat(
      !c.unavailableReason && c.quote.length > 0,
      'CITATION_UNAVAILABLE',
      '此引用尚不可复核，请补齐有权使用的原文',
    );
    ofKind(this.objects, c.sourceVersionId, 'source_version');
    const text =
      this.texts.get(c.sourceVersionId) ?? this.repo.material(this.projectId, c.sourceVersionId);
    requireThat(
      c.start < c.end && c.end <= text.length && text.slice(c.start, c.end) === c.quote,
      'INVALID_CITATION',
      '引用不能定位到所指定材料版本的原文',
    );
    if (c.visualRegionId) {
      const artifact = this.repo.db
        .prepare('SELECT data FROM parsed_artifacts WHERE project_id=? AND source_version_id=?')
        .get(this.projectId, c.sourceVersionId) as { data: string } | undefined;
      const region =
        artifact &&
        JSON.parse(artifact.data).regions?.find((r: { id: string }) => r.id === c.visualRegionId);
      requireThat(
        region && region.start <= c.start && region.end >= c.end,
        'INVALID_VISUAL_ANCHOR',
        '转写引用不能定位至所选材料版本的图像区域',
      );
    }
  }
  attribution(data: Bodies['statement'] | Bodies['inference']): void {
    requireThat(!data.editProvenance, 'USE_IMPACT_ADOPTION', 'AI 修改来历必须通过采用建议操作生成');
    for (const c of data.citations) this.citation(c);
    requireThat(
      data.origin !== 'author' || data.citations.length > 0,
      'AUTHOR_CITATION_REQUIRED',
      '作者表达必须有具体材料引用',
    );
    if (this.actor.type !== 'human')
      requireThat(
        data.origin !== 'user' &&
          data.participation !== 'personal' &&
          data.stance.value === 'pending',
        'ATTRIBUTION_FORBIDDEN',
        'Agent 新增内容须保留来源或 AI 归属，不得冒充本人判断',
        403,
      );
  }
  changed(): AnyEntity[] {
    return [...this.objects.values()].filter((e) => {
      const before = this.original.get(e.id);
      return (
        !before ||
        before.deletedAt !== e.deletedAt ||
        JSON.stringify(before.data) !== JSON.stringify(e.data)
      );
    });
  }
}
