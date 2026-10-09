import { randomUUID, createHash } from 'node:crypto';
import type { Actor } from '../contracts/entities.js';
import { DrawingOperations } from '../contracts/drawing.js';
import { readLayout } from '../repositories/layout.js';
import type { GraphWriteService } from './graph-write.js';
import type { MaterialFileService } from './material-files.js';
import { requireThat } from '../domain/errors.js';
import { rasterImage } from './raster-image.js';
export function editDrawings(
  write: GraphWriteService,
  files: MaterialFileService,
  projectId: string,
  actor: Actor,
  key: string,
  raw: unknown,
) {
  const input = DrawingOperations.parse(raw);
  return write.idempotent(actor, projectId, key, { op: 'drawing.operations', input }, () => {
    const old = readLayout(write.repo, projectId),
      data = structuredClone(old.data);
    requireThat(
      old.version === input.expectedVersion,
      'LAYOUT_CONFLICT',
      '画布已改变，请重新读取',
      409,
    );
    data.canvas ??= { scenes: {}, annotations: { elements: [], files: {} } };
    const layer = data.canvas.annotations;
    const objects = new Set(
      write.repo
        .snapshot(projectId)
        .objects.filter((e) => e.kind === 'statement' || e.kind === 'inference')
        .map((e) => e.id),
    );
    for (const command of input.commands) {
      if (command.op === 'object.position') {
        requireThat(
          objects.has(command.id),
          'INVALID_LAYOUT_REFERENCE',
          '研究对象不属于此项目',
          422,
        );
        const { op, id, ...position } = command;
        data.positions[id] = position;
        continue;
      }
      const id = command.op === 'drawing.put' ? command.drawing.id : command.id;
      requireThat(!objects.has(id), 'DRAWING_ID_CONFLICT', '绘图不能使用研究对象身份', 409);
      const prior = layer.elements.find((e) => e.id === id);
      if (command.op === 'drawing.delete') {
        requireThat(prior, 'DRAWING_NOT_FOUND', '图形不存在', 404);
        layer.elements = layer.elements.filter((e) => e.id !== id);
        if (data.canvas.attachments) delete data.canvas.attachments[id];
        continue;
      }
      const d = command.drawing;
      if (d.type === 'image') {
        const file = files.file(projectId, d.fileId!);
        requireThat(
          ['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(file.mime),
          'INVALID_IMAGE',
          '绘图需引用项目内原图',
        );
        requireThat(
          createHash('sha256').update(file.bytes).digest('hex') === file.hash,
          'FILE_CORRUPTED',
          '原图指纹不一致',
          409,
        );
        rasterImage(file.bytes, file.mime);
        layer.files[d.fileId!] = {
          id: d.fileId!,
          mimeType: file.mime,
          dataURL: `data:${file.mime};base64,${file.bytes.toString('base64')}`,
          created: Date.parse(file.retrieved_at),
        };
      }
      const element: Record<string, unknown> = {
        id,
        type: d.type,
        x: d.x,
        y: d.y,
        width: d.width,
        height: d.height,
        angle: 0,
        strokeColor: d.color,
        backgroundColor: 'transparent',
        fillStyle: 'solid',
        strokeWidth: 2,
        strokeStyle: 'solid',
        roughness: 0,
        opacity: 100,
        groupIds: [],
        frameId: null,
        index: prior?.index ?? null,
        roundness: null,
        seed: 1,
        version: Number(prior?.version ?? 0) + 1,
        versionNonce: 1,
        isDeleted: false,
        boundElements: null,
        updated: Date.parse(write.clock()),
        link: null,
        locked: false,
      };
      if (d.type === 'text')
        Object.assign(element, {
          text: d.text,
          originalText: d.text,
          fontSize: 20,
          fontFamily: 1,
          textAlign: 'left',
          verticalAlign: 'top',
          containerId: null,
          autoResize: true,
          lineHeight: 1.25,
        });
      if (['line', 'arrow', 'freedraw'].includes(d.type))
        Object.assign(element, {
          points: d.points ?? [
            [0, 0],
            [d.width, d.height],
          ],
          startBinding: null,
          endBinding: null,
          startArrowhead: null,
          endArrowhead: d.type === 'arrow' ? 'arrow' : null,
          lastCommittedPoint: null,
          pressures: [],
          simulatePressure: true,
          elbowed: false,
        });
      if (d.type === 'image')
        Object.assign(element, { fileId: d.fileId, status: 'saved', scale: [1, 1], crop: null });
      const at = layer.elements.findIndex((e) => e.id === id);
      if (at < 0) layer.elements.push(element);
      else layer.elements[at] = element;
    }
    const used = new Set(
      layer.elements.filter((e) => !e.isDeleted && e.type === 'image').map((e) => String(e.fileId)),
    );
    // Preserve files used by old/deleted native elements for their own history.
    for (const e of layer.elements) if (e.type === 'image') used.add(String(e.fileId));
    layer.files = Object.fromEntries(Object.entries(layer.files).filter(([id]) => used.has(id)));
    return write.execute(projectId, actor, randomUUID(), {
      expected: {},
      commands: [],
      layout: { expectedVersion: input.expectedVersion, data },
    });
  });
}
