import { createHash, randomUUID } from 'node:crypto';
import { z } from '@hono/zod-openapi';
import { Id, Time, type Actor } from '../contracts/entities.js';
import type { JobRepository } from '../repositories/jobs.js';
import type { GraphWriteService } from './graph-write.js';
import { requireThat, DomainError } from '../domain/errors.js';
import { readLayout } from '../repositories/layout.js';
import { rasterImage } from './raster-image.js';
import type { ChangeSet } from '../contracts/entities.js';
import { parsePdf } from './pdf-parser.js';
import { parseHtml } from './html-parser.js';

export const FileInput = z
  .object({
    sourceId: Id,
    expectedSourceVersion: z.number().int().positive(),
    name: z.string().min(1).max(255),
    mime: z.enum(['application/pdf', 'text/html', 'text/plain', 'image/png', 'image/jpeg']),
    base64: z.string().min(1).max(34_000_000),
    publishedAt: Time.nullable(),
  })
  .strict();
export const CanvasMaterialInput = z
  .object({
    targetId: Id,
    expectedTargetVersion: z.number().int().positive(),
    imageId: Id,
    expectedLayoutVersion: z.number().int().nonnegative(),
  })
  .strict();
interface FileRow {
  id: string;
  project_id: string;
  source_id: string;
  name: string;
  mime: string;
  hash: string;
  bytes: Buffer;
  retrieved_at: string;
  published_at: string | null;
}
export class MaterialFileService {
  private running = new Map<string, AbortController>();
  private stopping = false;
  constructor(
    readonly write: GraphWriteService,
    readonly jobs: JobRepository,
  ) {}
  attachCanvas(projectId: string, actor: Actor, key: string, raw: unknown) {
    const input = CanvasMaterialInput.parse(raw);
    requireThat(actor.type === 'human', 'HUMAN_REQUIRED', '此操作需要本人选择材料', 403);
    this.write.repo.project(projectId);
    return this.write.idempotent(actor, projectId, key, { op: 'material.canvas', input }, () => {
      const layout = readLayout(this.write.repo, projectId);
      requireThat(
        layout.version === input.expectedLayoutVersion,
        'LAYOUT_CONFLICT',
        '画布已变化，请等待保存并重新读取',
        409,
      );
      const target = this.write.repo
        .snapshot(projectId)
        .objects.find((e) => e.id === input.targetId);
      requireThat(
        target &&
          ['statement', 'inference'].includes(target.kind) &&
          target.version === input.expectedTargetVersion,
        'VERSION_CONFLICT',
        '对象已变化，请重新读取',
        409,
      );
      const element = layout.data.canvas?.annotations.elements.find(
        (e) => e.id === input.imageId && e.type === 'image' && !e.isDeleted,
      );
      const asset = element && layout.data.canvas?.annotations.files[String(element.fileId)];
      const match =
        typeof asset?.dataURL === 'string' &&
        /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/=]+)$/.exec(asset.dataURL);
      requireThat(match, 'IMAGE_NOT_FOUND', '画布图片不存在或尚未保存', 404);
      const bytes = Buffer.from(match[2]!, 'base64'),
        mime = match[1]!;
      requireThat(bytes.toString('base64') === match[2], 'INVALID_IMAGE', '原图编码无效');
      const dimensions = rasterImage(bytes, mime);
      const hash = createHash('sha256').update(bytes).digest('hex');
      const snapshot = this.write.repo.snapshot(projectId);
      const candidates = this.write.repo.db
        .prepare('SELECT * FROM file_assets WHERE project_id=? AND hash=? AND length(bytes)>0')
        .all(projectId, hash) as FileRow[];
      let version = snapshot.objects.find(
        (e) =>
          e.kind === 'source_version' &&
          candidates.some((f) => f.id === e.data.fileId) &&
          e.data.textOrigin === 'image_original',
      );
      let fileId = version?.kind === 'source_version' ? version.data.fileId! : randomUUID();
      const batches: ChangeSet[] = [];
      if (!version) {
        const sourceId = randomUUID(),
          sourceVersionId = randomUUID();
        batches.push(
          this.write.execute(projectId, actor, randomUUID(), {
            expected: {},
            commands: [
              {
                op: 'source.create',
                id: sourceId,
                data: { title: '画布图片', publisher: '', rights: 'authorized' },
              },
            ],
          }),
        );
        this.write.repo.db
          .prepare(
            'INSERT INTO file_assets(id,project_id,source_id,name,mime,hash,bytes,retrieved_at,published_at) VALUES(?,?,?,?,?,?,?,?,?)',
          )
          .run(
            fileId,
            projectId,
            sourceId,
            `画布图片.${mime.split('/')[1]}`,
            mime,
            hash,
            bytes,
            this.write.clock(),
            null,
          );
        batches.push(
          this.write.execute(projectId, { id: 'canvas_material', type: 'system' }, randomUUID(), {
            expected: { [sourceId]: 1 },
            commands: [
              {
                op: 'source.parse',
                id: sourceVersionId,
                sourceId,
                fileId,
                text: '',
                normalizerVersion: 'original-image@1',
                textOrigin: 'image_original',
                status: 'partial',
                message: '原图已保存；尚无文字转写，图像证据须对照原图',
              },
            ],
          }),
        );
        this.write.repo.db
          .prepare(
            'INSERT INTO parsed_artifacts(project_id,source_version_id,file_id,data) VALUES(?,?,?,?)',
          )
          .run(
            projectId,
            sourceVersionId,
            fileId,
            JSON.stringify({
              text: '',
              status: 'partial',
              normalizerVersion: 'original-image@1',
              page: 1,
              pageCount: 1,
              width: dimensions.width,
              height: dimensions.height,
              gaps: ['原图未作文字转写；动图按第一帧定位'],
            }),
          );
        version = this.write.repo
          .snapshot(projectId)
          .objects.find((e) => e.id === sourceVersionId)!;
      }
      const membership = snapshot.objects.find(
        (e) =>
          e.kind === 'material_membership' &&
          e.data.targetId === target.id &&
          e.data.sourceVersionId === version!.id,
      );
      batches.push(
        this.write.execute(projectId, actor, randomUUID(), {
          expected: {
            [target.id]: target.version,
            [version.id]: version.version,
            ...(membership ? { [membership.id]: membership.version } : {}),
          },
          commands: [
            {
              op: 'material.attach',
              id: membership?.id ?? randomUUID(),
              targetId: target.id,
              sourceVersionId: version.id,
            },
          ],
        }),
      );
      const changed = new Map(batches.flatMap((b) => b.upserted).map((e) => [e.id, e]));
      const changes: ChangeSet = {
        projectId,
        revisionBefore: batches[0]!.revisionBefore,
        revisionAfter: batches.at(-1)!.revisionAfter,
        upserted: [...changed.values()],
        deletedIds: [],
      };
      return { sourceVersionId: version.id, fileId, changes };
    });
  }
  upload(projectId: string, actor: Actor, key: string, raw: unknown) {
    const input = FileInput.parse(raw);
    const bytes = Buffer.from(input.base64, 'base64');
    requireThat(
      bytes.length > 0 && bytes.length <= 25_000_000 && bytes.toString('base64') === input.base64,
      'INVALID_FILE',
      '文件编码或大小无效',
      413,
    );
    sniff(bytes, input.mime);
    this.write.repo.project(projectId);
    return this.write.idempotent(actor, projectId, key, { op: 'file.upload', input }, () => {
      const source = this.write.repo
        .snapshot(projectId)
        .objects.find((e) => e.id === input.sourceId);
      requireThat(
        source?.kind === 'source' && source.version === input.expectedSourceVersion,
        'VERSION_CONFLICT',
        '来源已改变，请重新读取',
        409,
      );
      const hash = createHash('sha256').update(bytes).digest('hex');
      const previous = this.write.repo.db
        .prepare(
          'SELECT id,length(bytes) AS size FROM file_assets WHERE project_id=? AND source_id=? AND hash=?',
        )
        .get(projectId, input.sourceId, hash) as { id: string; size: number } | undefined;
      const id = previous?.id ?? randomUUID();
      this.jobs.assertCapacity(projectId);
      if (!previous)
        this.write.repo.db
          .prepare(
            'INSERT INTO file_assets(id,project_id,source_id,name,mime,hash,bytes,retrieved_at,published_at) VALUES(?,?,?,?,?,?,?,?,?)',
          )
          .run(
            id,
            projectId,
            input.sourceId,
            input.name,
            input.mime,
            hash,
            bytes,
            this.write.clock(),
            input.publishedAt,
          );
      else if (previous.size === 0)
        this.write.repo.db
          .prepare('UPDATE file_assets SET bytes=? WHERE project_id=? AND id=? AND length(bytes)=0')
          .run(bytes, projectId, id);
      const job = this.jobs.enqueue(
        projectId,
        'material.parse',
        { fileId: id },
        previous?.size === 0 ? `rehydrate:${id}:${key}` : `parse:${id}:v1`,
      );
      return { fileId: id, hash, job: { ...job, runToken: null }, deduplicated: Boolean(previous) };
    });
  }
  file(projectId: string, id: string): FileRow {
    this.write.repo.project(projectId);
    const file = this.write.repo.db
      .prepare('SELECT * FROM file_assets WHERE project_id=? AND id=?')
      .get(projectId, id) as FileRow | undefined;
    requireThat(
      file && file.bytes.length > 0,
      'FILE_NOT_FOUND',
      '原文件不存在或未包含在此次受限导入中',
      404,
    );
    return file;
  }
  artifact(projectId: string, id: string) {
    this.write.repo.project(projectId);
    const row = this.write.repo.db
      .prepare('SELECT data FROM parsed_artifacts WHERE project_id=? AND source_version_id=?')
      .get(projectId, id) as { data: string } | undefined;
    requireThat(row, 'ARTIFACT_NOT_FOUND', '解析定位产物不存在', 404);
    return JSON.parse(row.data);
  }
  async run(projectId: string, id: string) {
    const job = this.jobs.claim(projectId, id);
    if (!job) return this.jobs.get(projectId, id);
    const abort = new AbortController();
    this.running.set(id, abort);
    const { fileId } = z.object({ fileId: Id }).parse(job.input);
    let artifact:
      | {
          text: string;
          status: string;
          normalizerVersion: string;
          gaps: string[];
          [key: string]: unknown;
        }
      | undefined;
    let error: unknown;
    let file: FileRow | undefined;
    try {
      file = this.file(projectId, fileId);
      if (file.mime === 'application/pdf') artifact = await parsePdf(file.bytes, abort.signal);
      else if (file.mime === 'text/plain')
        artifact = {
          text: new TextDecoder('utf-8', { fatal: true }).decode(file.bytes),
          normalizerVersion: 'plain-text@1',
          regions: [],
          status: 'complete',
          gaps: [],
        };
      else if (file.mime === 'text/html')
        artifact = parseHtml(new TextDecoder('utf-8', { fatal: true }).decode(file.bytes));
      else
        artifact = {
          text: '',
          status: 'partial',
          normalizerVersion: 'image-pending@1',
          page: 1,
          pageCount: 1,
          gaps: ['原图已保存，尚未配置并验证多模态转写模型；可对照原图补充文字'],
        };
    } catch (cause) {
      error = cause;
    }
    try {
      this.write.repo.db
        .transaction(() => {
          if (!this.jobs.isRunning(job)) return;
          requireThat(file, 'FILE_NOT_FOUND', '解析原文件不可读取', 404);
          const source = this.write.repo
            .snapshot(projectId)
            .objects.find((e) => e.id === file!.source_id);
          requireThat(source, 'SOURCE_NOT_FOUND', '来源已移除', 404);
          const sourceVersionId = `parsed_${job.id}_${job.attempt}`;
          const status =
            artifact?.status === 'complete' ? 'complete' : artifact ? 'partial' : 'failed';
          const message =
            artifact?.gaps.join('；').slice(0, 2000) ??
            (error instanceof DomainError ? error.message : '解析失败；原文件仍保留，可单独重试');
          const changes = this.write.execute(
            projectId,
            { id: `job_${id}`, type: 'system' },
            `parse_${id}_${job.attempt}`,
            {
              expected: { [source.id]: source.version },
              commands: [
                {
                  op: 'source.parse',
                  id: sourceVersionId,
                  sourceId: source.id,
                  fileId,
                  text: artifact?.text ?? '',
                  status,
                  message,
                  normalizerVersion: artifact?.normalizerVersion ?? 'parse-failed@1',
                  textOrigin:
                    file.mime === 'application/pdf'
                      ? 'pdf_text'
                      : ['text/html', 'text/plain'].includes(file.mime)
                        ? 'html_body'
                        : 'image_original',
                },
              ],
            },
          );
          this.write.repo.db
            .prepare(
              'INSERT INTO parsed_artifacts(project_id,source_version_id,file_id,data) VALUES(?,?,?,?)',
            )
            .run(
              projectId,
              sourceVersionId,
              fileId,
              JSON.stringify(artifact ?? { text: '', status: 'failed', gaps: [message] }),
            );
          this.jobs.finish(
            job,
            status === 'failed' ? 'failed' : status === 'partial' ? 'partial' : 'succeeded',
            { fileId, sourceVersionId, parseStatus: status, changes },
            status === 'complete' ? null : message,
            { pages: artifact?.pageCount ?? null, cost: null },
          );
        })
        .immediate();
    } catch (cause) {
      this.jobs.finish(
        job,
        'failed',
        null,
        cause instanceof DomainError
          ? `${cause.code}: ${cause.message}`
          : '保存解析产物失败，原文件保持',
      );
    } finally {
      this.running.delete(id);
    }
    return this.jobs.get(projectId, id);
  }
  cancel(projectId: string, id: string) {
    const job = this.jobs.cancel(projectId, id);
    this.running.get(id)?.abort();
    return job;
  }
  stop() {
    this.stopping = true;
    for (const controller of this.running.values()) controller.abort();
  }
  async drain() {
    const pending = this.write.repo.db
      .prepare(
        "SELECT project_id,id FROM jobs WHERE kind='material.parse' AND state='queued' ORDER BY created_at,id",
      )
      .all() as { project_id: string; id: string }[];
    for (const job of pending) {
      if (this.stopping) break;
      await this.run(job.project_id, job.id);
    }
  }
}
function sniff(bytes: Buffer, mime: string) {
  const valid =
    mime === 'application/pdf'
      ? bytes.subarray(0, 1024).includes(Buffer.from('%PDF-'))
      : mime === 'image/png'
        ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
        : mime === 'image/jpeg'
          ? bytes[0] === 255 && bytes[1] === 216
          : !bytes.includes(0);
  requireThat(valid, 'MIME_MISMATCH', '文件内容与所选格式不符');
}
