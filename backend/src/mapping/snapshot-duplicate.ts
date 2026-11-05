import type Database from 'better-sqlite3';
import type { z } from 'zod';
import { requireThat } from '../domain/errors.js';
import { endpointKey, type ConnectorEndpoint } from './connector-contracts.js';
import { captureContainerEndpoints, sidePoint } from './container-endpoints.js';
import type { CanvasDuplicateCommand, CanvasPasteCommand } from './snapshot-contracts.js';
import { readConnectors } from './connector.js';
import { snapshotScope } from './snapshot-tree.js';
import { pasteCanvas, readSnapshotScene, type SnapshotWrite } from './snapshot.js';

type Duplicate = z.infer<typeof CanvasDuplicateCommand>;
type Paste = z.infer<typeof CanvasPasteCommand>;
const OFFSET = 24;
function exact(ids: string[], record: Record<string, unknown>) {
  const keys = Object.keys(record).sort(), wanted = [...ids].sort();
  requireThat(keys.length === wanted.length && keys.every((key, index) => key === wanted[index]),
    'EXPECTED_DOMAINS', '须校验本次复制的全部对象与连线版本', 400);
}

export function duplicateCanvas(db: Database.Database, command: Duplicate): SnapshotWrite {
  const { projectId, expected, payload } = command;
  const { state, values: poses } = readSnapshotScene(db, projectId);
  const ordinary = [
    ...state.cards.map(source => ({ kind: 'card' as const, source })),
    ...state.texts.map(source => ({ kind: 'text' as const, source })),
    ...state.shapes.map(source => ({ kind: 'shape' as const, source })),
    ...state.images.map(source => ({ kind: 'image' as const, source })),
    ...state.strokes.map(source => ({ kind: 'stroke' as const, source })),
  ];
  const canvasId = (ref: Duplicate['payload']['objects'][number]) => ref.kind === 'frame' ? state.frames.find(v => v.id === ref.id)?.id
    : ref.kind === 'group' ? state.groups.find(v => v.id === ref.id)?.itemId : ordinary.find(v => v.kind === ref.kind && v.source.id === ref.id)?.source.item.id;
  const selectedIds = payload.objects.map(ref => { const id = canvasId(ref); requireThat(id, 'NOT_FOUND', '对象不存在于当前项目', 404); return id!; });
  requireThat(new Set(selectedIds).size === selectedIds.length && new Set(payload.connectors.map(v => v.id)).size === payload.connectors.length,
    'INVALID_COMMAND', '同一次复制不能重复对象', 400);
  const selected = new Set(selectedIds);
  const scope = payload.version === 2 ? snapshotScope(state, payload.roots!) : { roots: selectedIds, ids: selected };
  if (payload.version === 2) {
    requireThat(scope.ids.size === selected.size && [...scope.ids].every(id => selected.has(id)), 'VERSION_CONFLICT', '复制归属树已更新，请重新读取', 409);
    exact(selectedIds, expected.containment ?? {});
    requireThat(selectedIds.every(id => expected.containment![id] === (state.containment.find(v => v.id === id)?.versionId ?? null)),
      'VERSION_CONFLICT', '复制归属树已更新，请重新读取', 409);
  }
  const selectedOrdinary = ordinary.filter(v => selected.has(v.source.item.id));
  const groups = state.groups.filter(v => selected.has(v.itemId)), frames = state.frames.filter(v => selected.has(v.id));
  exact(groups.map(v => v.id), expected.groups ?? {}); exact(frames.map(v => v.id), expected.frames ?? {});
  requireThat(groups.every(v => expected.groups![v.id] === v.versionId) && frames.every(v => expected.frames![v.id] === v.versionId),
    'VERSION_CONFLICT', '复制容器已更新，请重新读取', 409);
  for (const kind of ['card', 'text', 'shape', 'image', 'stroke'] as const) {
    const values = selectedOrdinary.filter(v => v.kind === kind);
    exact(values.map(v => v.source.id), expected[kind === 'card' ? 'cards' : `${kind}s` as 'texts' | 'shapes' | 'images' | 'strokes']);
    for (const { source } of values) {
      if ('body' in source) {
        const v = expected.cards[source.id]!;
        requireThat(v.thought === source.versionId && v.body === source.body.versionId && v.pose === source.item.versionId &&
          v.appearance === (source.appearance?.versionId ?? null) && v.cardTags === (source.cardTags?.versionId ?? null), 'VERSION_CONFLICT', '复制依据已更新，请重新读取', 409);
      } else {
        const v = expected[`${kind}s` as 'texts'][source.id]!;
        requireThat(v.content === source.versionId && v.pose === source.item.versionId, 'VERSION_CONFLICT', '复制依据已更新，请重新读取', 409);
      }
    }
  }
  const keys = new Set([...selectedOrdinary.map(v => `item:${v.source.item.id}`), ...groups.map(v => `group:${v.itemId}`), ...frames.map(v => `frame:${v.id}`)]);
  const inside = (end: ConnectorEndpoint) => end.kind === 'bound' && keys.has(endpointKey(end));
  const included = readConnectors(db, projectId).filter(line => payload.connectors.some(v => v.id === line.id) || inside(line.start) && inside(line.end));
  if (payload.version === 2) requireThat(included.length === payload.connectors.length && included.every(v => payload.connectors.some(p => p.id === v.id)), 'VERSION_CONFLICT', '内部连线集合已更新，请重新读取', 409);
  exact(included.map(v => v.id), expected.connectors); exact(included.map(v => v.id), Object.fromEntries(payload.connectors.map(v => [v.id, v.copyId])));
  requireThat(included.every(v => expected.connectors[v.id] === v.versionId), 'VERSION_CONFLICT', '复制连线已更新，请重新读取', 409);
  const anchors = [...new Map(included.flatMap(line => [line.start, line.end].flatMap(end => end.kind === 'bound' && !inside(end) ? [[endpointKey(end), end] as const] : []))).values()];
  const legacy = anchors.every(end => (end.targetKind ?? 'item') === 'item') && Object.keys(expected.anchors).every(key => anchors.some(end => end.itemId === key));
  exact(anchors.map(end => legacy ? end.itemId : endpointKey(end)), expected.anchors);
  for (const end of anchors) {
    const host = poses.find(v => v.key === endpointKey(end));
    requireThat(host, 'NOT_FOUND', '连线端点不存在于当前项目', 404);
    requireThat(expected.anchors[legacy ? end.itemId : endpointKey(end)] === host.versionId, 'VERSION_CONFLICT', '复制依据已更新，请重新读取', 409);
  }
  const containerKeys = anchors.filter(end => (end.targetKind ?? 'item') !== 'item').map(endpointKey);
  if (containerKeys.length) {
    const actual = captureContainerEndpoints({ ...state, connectors: included }, containerKeys);
    requireThat(expected.endpoints && (['connectors', 'groups', 'frames', 'containment', 'poses'] as const).every(domain =>
      Object.keys(actual[domain]).length === Object.keys(expected.endpoints![domain]).length && Object.entries(actual[domain]).every(([id, version]) => expected.endpoints![domain][id] === version)),
    'VERSION_CONFLICT', '容器复制边界或成员已更新，请重新读取', 409);
  }
  const copyIds = new Map(payload.objects.map(ref => [canvasId(ref)!, ref.copyId]));
  const objects: Paste['payload']['objects'] = [
    ...selectedOrdinary.map(({ kind, source }) => {
      const base = { copyId: copyIds.get(source.item.id)!, stack: source.item.createdOrder ?? 0, pose: structuredClone(source.item.pose) };
      if ('body' in source) return { ...base, kind: 'card' as const, title: source.title, blocks: source.body.blocks,
        tagIds: source.cardTags?.tagIds ?? null, appearance: source.appearance ? { titleColor: source.appearance.titleColor, showPreview: source.appearance.showPreview } : null,
        ...(source.item.heightPolicy ? { heightPolicy: source.item.heightPolicy } : {}) };
      return { ...base, kind, content: source.content } as Paste['payload']['objects'][number];
    }),
    ...groups.map(v => ({ kind: 'group' as const, copyId: copyIds.get(v.itemId)!, stack: v.createdOrder, pose: v.bounds })),
    ...frames.map(v => ({ kind: 'frame' as const, copyId: copyIds.get(v.id)!, stack: state.frames.indexOf(v), pose: v.pose, name: v.name, background: v.background })),
  ];
  const mapEnd = (end: ConnectorEndpoint): Paste['payload']['connectors'][number]['start'] => {
    if (end.kind === 'bound' && inside(end)) return { kind: 'bound', copyId: copyIds.get(end.itemId)!, side: end.side, ...(end.targetKind ? { targetKind: end.targetKind } : {}) };
    return { kind: 'free', point: end.kind === 'free' ? end.point : sidePoint(poses.find(v => v.key === endpointKey(end))!.pose, end.side) };
  };
  const tree = payload.version === 2 ? { version: 2 as const, roots: scope.roots.map(id => copyIds.get(id)!),
    containment: state.containment.flatMap(edge => edge.parent && selected.has(edge.id) && selected.has(edge.parent.id) ? [{ copyId: copyIds.get(edge.id)!, parentCopyId: copyIds.get(edge.parent.id)! }] : []) } : {};
  return pasteCanvas(db, { commandId: command.commandId, projectId, type: 'canvas.paste', expected: null,
    payload: { ...tree, translation: { x: OFFSET, y: OFFSET }, objects,
      connectors: included.map(line => ({ copyId: payload.connectors.find(v => v.id === line.id)!.copyId, path: line.path, start: mapEnd(line.start), end: mapEnd(line.end),
        ...(line.style ? { style: line.style } : {}), ...(line.label !== undefined ? { label: line.label } : {}) })) } });
}

