import { z } from 'zod';
import { CanvasData, type Layout } from '../contracts/layout.js';
import type { AnyEntity } from '../contracts/entities.js';
import { requireThat } from '../domain/errors.js';

export function migratePrototypeCanvas(
  raw: Record<string, unknown>,
  owner: string,
  projectId: string,
  mapped: Map<string, AnyEntity>,
  graph: { edges: Record<string, Record<string, unknown>> },
  fromAuthor: boolean,
  issue: (path: string, code: string, message: string) => void,
): Pick<Layout['data'], 'canvas' | 'ports'> {
  const input = CanvasData.parse(raw),
    mode = fromAuthor ? 'author' : 'mine';
  // The drawing renderer consumes complete native elements. The general layout
  // envelope alone cannot guarantee that a legacy export is renderable.
  const native = z
    .object({
      id: z.string().min(1),
      type: z.string(),
      x: z.number().finite(),
      y: z.number().finite(),
      width: z.number().finite().nonnegative(),
      height: z.number().finite().nonnegative(),
      angle: z.number().finite(),
      groupIds: z.array(z.string()),
      isDeleted: z.boolean(),
      version: z.number().int().positive(),
      strokeColor: z.string(),
      backgroundColor: z.string(),
      strokeWidth: z.number().finite(),
      fillStyle: z.string(),
      strokeStyle: z.string(),
      roughness: z.number().finite(),
      opacity: z.number().finite(),
      seed: z.number().finite(),
      versionNonce: z.number().finite(),
      updated: z.number().finite(),
      boundElements: z.array(z.object({ id: z.string(), type: z.string() })).nullable(),
      frameId: z.string().nullable(),
      link: z.string().nullable(),
      locked: z.boolean(),
    })
    .passthrough();
  const seen = new Set<string>();
  for (const element of input.annotations.elements) {
    requireThat(
      native.safeParse(element).success,
      'LEGACY_DRAWING_INVALID',
      `旧版绘图 ${element.id} 缺少必要字段，请从原型重新导出完整副本`,
    );
    requireThat(!seen.has(String(element.id)), 'LEGACY_DRAWING_INVALID', '旧版绘图身份重复');
    seen.add(String(element.id));
    if (element.type === 'text')
      requireThat(
        z
          .object({
            text: z.string(),
            originalText: z.string(),
            fontSize: z.number().positive(),
            fontFamily: z.number().int().positive(),
            lineHeight: z.number().positive(),
            textAlign: z.enum(['left', 'center', 'right']),
            verticalAlign: z.enum(['top', 'middle', 'bottom']),
            containerId: z.string().nullable(),
          })
          .safeParse(element).success,
        'LEGACY_DRAWING_INVALID',
        '旧版文本绘图字段不完整',
      );
    if (['arrow', 'line', 'freedraw'].includes(String(element.type)))
      requireThat(
        z.array(z.tuple([z.number().finite(), z.number().finite()])).safeParse(element.points)
          .success,
        'LEGACY_DRAWING_INVALID',
        '旧版线条坐标不完整',
      );
    if (element.type === 'image')
      requireThat(
        typeof element.fileId === 'string' &&
          Boolean(input.annotations.files[element.fileId]) &&
          z.tuple([z.number().finite(), z.number().finite()]).safeParse(element.scale).success,
        'LEGACY_DRAWING_INVALID',
        '旧版画布图片缺少本地文件或缩放信息',
      );
  }
  const aliases = new Map<string, string>();
  for (const [oldId, e] of mapped) {
    for (const field of ['card', 'group', 'origin-tag', 'stance-tag', 'divider'])
      aliases.set(
        `forkwise:${owner}:${mode}:${field}:${oldId}`,
        `forkwise:${projectId}:mine:${field}:${e.id}`,
      );
    for (const field of ['body', 'origin', 'stance', 'verification', 'footer'])
      aliases.set(
        `forkwise:${owner}:${mode}:text:${oldId}:${field}`,
        `forkwise:${projectId}:mine:text:${e.id}:${field}`,
      );
    if (e.kind === 'inference') {
      for (const [oldPremise, premise] of mapped)
        if (e.data.premiseIds.includes(premise.id))
          aliases.set(
            `forkwise:${owner}:${mode}:link:${oldId}:p:${oldPremise}`,
            `forkwise:${projectId}:mine:link:${e.id}-from-${premise.id}`,
          );
      aliases.set(
        `forkwise:${owner}:${mode}:link:${oldId}:c`,
        `forkwise:${projectId}:mine:link:${e.id}-to`,
      );
    }
  }
  const rename = (key: string) => aliases.get(key) ?? key;
  const keys = <T>(value: Record<string, T>) =>
    Object.fromEntries(
      Object.entries(value).flatMap(([key, v]) => {
        if (key.startsWith(`forkwise:${owner}:`) && !aliases.has(key)) {
          issue(
            `canvas.${key}`,
            'OLD_CANVAS_REFERENCE_RETAINED',
            '未映射的研究图样式或选择记录保留在旧档。',
          );
          return [];
        }
        return [[rename(key), v]];
      }),
    );
  const scene = input.scenes[mode];
  const view = scene?.view;
  const canvas: z.infer<typeof CanvasData> = {
    scenes: scene
      ? {
          mine: {
            styles: keys(scene.styles),
            ...(scene.frames ? { frames: keys(scene.frames) } : {}),
            ...(view
              ? {
                  view: {
                    ...view,
                    selectedElementIds: keys(view.selectedElementIds),
                    selectedGroupIds: keys(view.selectedGroupIds),
                    ...(view.relationIds
                      ? {
                          relationIds: view.relationIds.flatMap((i) =>
                            mapped.has(i) ? [mapped.get(i)!.id] : [],
                          ),
                        }
                      : {}),
                  },
                }
              : {}),
          },
        }
      : {},
    annotations: structuredClone(input.annotations),
    drafts: {},
    attachments: {},
  };
  for (const e of canvas.annotations.elements) {
    if (Array.isArray(e.boundElements))
      e.boundElements = e.boundElements.map((raw) => {
        const binding = z.object({ id: z.string() }).passthrough().parse(raw);
        return { ...binding, id: rename(binding.id) };
      });
    for (const field of ['startBinding', 'endBinding'])
      if (e[field]) {
        const binding = z.object({ elementId: z.string() }).passthrough().parse(e[field]);
        e[field] = { ...binding, elementId: rename(binding.elementId) };
      }
    if (Array.isArray(e.groupIds)) e.groupIds = e.groupIds.map((i) => rename(z.string().parse(i)));
  }
  for (const [elementId, a] of Object.entries(input.attachments ?? {})) {
    if (a.mode !== mode || !mapped.has(a.target)) {
      issue(
        `canvas.attachments.${elementId}`,
        'OLD_ATTACHMENT_RETAINED',
        '原版或已删除对象的批注绑定保留在旧档；绘图仍保留。',
      );
      continue;
    }
    requireThat(
      canvas.annotations.elements.some((e) => e.id === elementId),
      'LEGACY_ATTACHMENT',
      '旧版批注绑定的绘图不存在',
    );
    canvas.attachments![elementId] = { ...a, mode: 'mine', target: mapped.get(a.target)!.id };
  }
  if (Object.keys(input.drafts ?? {}).length || Object.keys(input.returnViews ?? {}).length)
    issue(
      'canvas.drafts',
      'OLD_DRAFT_RETAINED',
      '未提交草稿和返回位置保留在旧档，可查看复制；不会自动提交或覆盖新草稿。',
    );
  const ports: NonNullable<Layout['data']['ports']> = {};
  for (const [oldId, n] of Object.entries(graph.edges))
    if (n.ports) {
      const p = z
        .object({
          premises: z.record(z.string(), z.enum(['top', 'right', 'bottom', 'left'])),
          conclusion: z.enum(['top', 'right', 'bottom', 'left']),
        })
        .strict()
        .parse(n.ports);
      const inference = mapped.get(oldId)!;
      requireThat(
        inference.kind === 'inference' &&
          Object.keys(p.premises).every(
            (key) => mapped.has(key) && inference.data.premiseIds.includes(mapped.get(key)!.id),
          ),
        'LEGACY_PORTS',
        '旧版连接边引用的前提无效',
      );
      ports[inference.id] = {
        conclusion: p.conclusion,
        premises: Object.fromEntries(
          Object.entries(p.premises).map(([old, side]) => [mapped.get(old)!.id, side]),
        ),
      };
    }
  return { canvas: CanvasData.parse(canvas), ports };
}
