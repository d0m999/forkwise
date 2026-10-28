import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { flushSync } from 'react-dom';
import type { Node } from '@xyflow/react';
import type { Command, ProjectState } from './api';
import type { CanvasText } from '../../backend/src/mapping/text-contracts';
import type { GeometryMemberExpected } from '../../backend/src/mapping/group-geometry-contracts';
import { canvasItems, selectedItemIds, type CanvasSelection } from './canvas-selection';
import { captureGroupCards } from './group-card-measure';

type Item = ReturnType<typeof canvasItems>[number];
type Corner = 'nw' | 'ne' | 'sw' | 'se';
type ScaleCommand = Extract<Command, { type: 'group.scale' }>;
type Options = {
  state: ProjectState | null; selection: CanvasSelection; current: () => ProjectState | null;
  generation: () => number; blocked: boolean; zoom: () => number; flush: () => Promise<boolean>;
  execute: (command: Command, done: () => void, guard: () => boolean) => Promise<boolean | undefined>;
  lock: (value: boolean) => void; fail: (failure: unknown) => void;
};
export function useGroupGeometry(options: Options) {
  const latest = useRef(options); latest.current = options;
  const [preview, setPreview] = useState<Record<string, Item>>({});
  const projected = useRef(preview), cleanup = useRef<(() => void) | null>(null);
  const session = useRef<{ projectId: string; generation: number; submitted: boolean } | null>(null);
  const measurementRequest = useRef(0);
  const sampling = useRef<{ token: number; ids: string[]; values: Record<string, { width: number; height: number }>;
    complete: () => void; cancel: () => void } | null>(null);
  const ids = options.state ? selectedItemIds(options.state, options.selection) : [];
  const targets = options.state ? canvasItems(options.state).filter(v => ids.includes(v.item.id)) : [];
  const grouped = options.selection.targets.some(t => t.kind === 'group');
  const scalable = grouped && targets.length > 0 && targets.every(v => !('kind' in v) || v.kind !== 'stroke');
  const rotatable = grouped && targets.length > 0 && targets.every(v => 'kind' in v && v.kind === 'image');
  function clear() {
    cleanup.current?.(); cleanup.current = null; session.current = null;
    sampling.current?.cancel(); sampling.current = null;
    projected.current = {}; setPreview({}); latest.current.lock(false);
  }
  useEffect(() => {
    const current = session.current;
    if (current && (options.state?.project.id !== current.projectId || options.generation() !== current.generation)) clear();
  }, [options.state?.project.id, options.selection]);
  useEffect(() => () => { cleanup.current?.(); sampling.current?.cancel(); session.current = null; }, []);
  async function capture() {
    const initial = latest.current, selection = structuredClone(initial.selection), state = initial.current();
    if (!state) throw new Error('项目尚未就绪');
    const own = { projectId: state.project.id, generation: initial.generation(), submitted: false };
    session.current = own; initial.lock(true);
    await document.fonts.ready;
    if (!(await initial.flush())) throw new Error('请先确认已有保存，再调整组合');
    if (session.current !== own || latest.current.generation() !== own.generation || latest.current.current()?.project.id !== own.projectId) return null;
    const snapshot = structuredClone(latest.current.current()!);
    const ids = selectedItemIds(snapshot, selection), targets = canvasItems(snapshot).filter(v => ids.includes(v.item.id));
    const items: Record<string, GeometryMemberExpected> = {};
    for (const v of targets) {
      if ('body' in v) items[v.item.id] = { kind: 'card', thought: v.versionId, body: v.body.versionId, pose: v.item.versionId, appearance: v.appearance?.versionId ?? null, cardTags: v.cardTags?.versionId ?? null };
      else if (v.kind === 'text') items[v.item.id] = { kind: 'text', text: v.versionId, pose: v.item.versionId };
      else if (v.kind === 'shape') items[v.item.id] = { kind: 'shape', pose: v.item.versionId };
      else if (v.kind === 'image') items[v.item.id] = { kind: 'image', image: v.versionId, pose: v.item.versionId };
      else throw new Error('含笔迹的选择暂不支持整体缩放或旋转');
    }
    const groupIds = selection.targets.flatMap(t => t.kind === 'group' ? [t.id] : []);
    return { own, targets, expected: { items,
      groups: Object.fromEntries(groupIds.map(id => [id, snapshot.groups!.find(g => g.id === id)!.versionId])),
      containment: Object.fromEntries(ids.map(id => [id, snapshot.containment?.find(c => c.id === id)?.versionId ?? null])) },
      payload: { groupIds, directItemIds: selection.targets.flatMap(t => t.kind === 'item' ? [t.itemId] : []) } };
  }
  async function rotate(direction: 'left' | 'right') {
    if (latest.current.blocked || !rotatable || session.current) return;
    try {
      const captured = await capture(); if (!captured) return;
      captured.own.submitted = true; latest.current.lock(false);
      await latest.current.execute({ commandId: crypto.randomUUID(), projectId: captured.own.projectId, type: 'group.rotate90',
        expected: captured.expected, payload: { ...captured.payload, direction } },
      () => { if (session.current === captured.own) clear(); }, () => session.current === captured.own);
    } catch (failure) { clear(); latest.current.fail(failure); }
  }
  function start(event: ReactPointerEvent, corner: Corner) {
    if (event.button !== 0 || latest.current.blocked || !scalable || session.current) return;
    event.preventDefault(); event.stopPropagation();
    const origin = { x: event.clientX, y: event.clientY }, zoom = latest.current.zoom();
    let pointer = origin, ended = false, cancelled = false;
    let cards: ReturnType<typeof captureGroupCards> | null = null;
    let captured: Awaited<ReturnType<typeof capture>> = null;
    let anchor = { x: 0, y: 0 }, extent = { width: 0, height: 0 }, minimum = 0;
    const anchorCorner: Corner = ({ nw: 'se', ne: 'sw', sw: 'ne', se: 'nw' } as const)[corner];
    const east = anchorCorner.endsWith('e'), south = anchorCorner.startsWith('s');
    const ratio = () => 1 + (((corner.endsWith('w') ? -1 : 1) * (pointer.x - origin.x) / zoom) * extent.width +
      ((corner.startsWith('n') ? -1 : 1) * (pointer.y - origin.y) / zoom) * extent.height) / (extent.width ** 2 + extent.height ** 2);
    function project(scale: number, measured: Record<string, { width: number; height: number }> = {}) {
      const next: Record<string, Item> = {};
      for (const value of captured!.targets) {
        const p = value.item.pose;
        const size = measured[value.item.id] ?? { width: p.width * scale, height: p.height * scale };
        const pose = { ...p, x: anchor.x + scale * (p.x + (east ? p.width : 0) - anchor.x) - (east ? size.width : 0),
          y: anchor.y + scale * (p.y + (south ? p.height : 0) - anchor.y) - (south ? size.height : 0), ...size };
        next[value.item.id] = { ...value, item: { ...value.item, pose },
          ...('kind' in value && value.kind === 'text' ? { content: { ...value.content, fontSize: value.content.fontSize * scale, width: value.content.width * scale } } : {}) } as Item;
      }
      projected.current = next; setPreview(next);
    }
    function move(event: PointerEvent) { pointer = { x: event.clientX, y: event.clientY }; if (captured && !ended && ratio() > 0) project(Math.max(minimum, ratio())); }
    function dispose() { document.removeEventListener('pointermove', move); document.removeEventListener('pointerup', up); cards?.dispose(); }
    function up(event: PointerEvent) {
      pointer = { x: event.clientX, y: event.clientY }; ended = true;
      document.removeEventListener('pointermove', move); document.removeEventListener('pointerup', up);
      void prepared.then(finish);
    }
    cleanup.current = () => { cancelled = true; dispose(); };
    document.addEventListener('pointermove', move); document.addEventListener('pointerup', up);
    const prepared = capture().then(value => {
      if (cancelled || !value) return;
      captured = value;
      const poses = value.targets.map(v => v.item.pose);
      const x = Math.min(...poses.map(p => p.x)), y = Math.min(...poses.map(p => p.y));
      extent = { width: Math.max(...poses.map(p => p.x + p.width)) - x, height: Math.max(...poses.map(p => p.y + p.height)) - y };
      anchor = { x: x + (east ? extent.width : 0), y: y + (south ? extent.height : 0) };
      minimum = Math.max(0, ...value.targets.map(v => 'body' in v ? Math.min(v.item.pose.width, 120) / v.item.pose.width
        : v.kind === 'image' ? Math.max(Math.min(v.item.pose.width, 1) / v.item.pose.width, Math.min(v.item.pose.height, 1) / v.item.pose.height)
        : v.kind === 'text' ? Math.min(v.content.fontSize, 1) / v.content.fontSize : 0));
      const cardTargets = value.targets.filter(v => 'body' in v);
      if (cardTargets.length) cards = captureGroupCards(cardTargets);
      if (!ended && ratio() > 0) project(Math.max(minimum, ratio()));
    }).catch(failure => { if (!cancelled) { clear(); latest.current.fail(failure); } });
    async function finish() {
      if (cancelled || !captured || session.current !== captured.own) return;
      try {
        const requested = ratio();
        if (!(requested > 0) || requested === 1) { clear(); return; }
        const solved = cards?.solve(requested, minimum, Math.max(extent.width, extent.height), zoom) ??
          { scale: Math.max(minimum, requested), cards: {}, measurementCount: 0, remainingMilliseconds: 500 };
        if (solved.scale === 1) { clear(); return; }
        const deadline = performance.now() + solved.remainingMilliseconds;
        const textIds = captured.targets.filter(v => 'kind' in v && v.kind === 'text').map(v => v.item.id);
        let count = solved.measurementCount;
        async function sample(sizes: ScaleCommand['payload']['measurements']['texts']) {
          if (!textIds.length) { flushSync(() => project(solved.scale, sizes)); return {}; }
          if (++count > 24 || performance.now() >= deadline) throw new Error('组合尺寸测量超时，本次未保存，请重新调整');
          return new Promise<ScaleCommand['payload']['measurements']['texts']>((resolve, reject) => {
            const token = ++measurementRequest.current;
            const timeout = setTimeout(() => { sampling.current = null; reject(new Error('独立文字测量超时，本次未保存')); }, deadline - performance.now());
            const pending = { token, ids: textIds, values: {} as ScaleCommand['payload']['measurements']['texts'],
              complete: () => { clearTimeout(timeout); sampling.current = null; resolve(pending.values); },
              cancel: () => { clearTimeout(timeout); reject(new Error('本次组合测量已取消')); } };
            sampling.current = pending;
            flushSync(() => project(solved.scale, sizes));
          });
        }
        const texts = await sample({});
        if (cancelled || session.current !== captured.own) return;
        const verified = await sample(texts);
        if (cancelled || session.current !== captured.own) return;
        for (const id of textIds) if (Math.abs(verified[id]!.width - texts[id]!.width) >= 0.01 || Math.abs(verified[id]!.height - texts[id]!.height) >= 0.01)
          throw new Error('独立文字测量不稳定，本次未保存');
        if (performance.now() > deadline) throw new Error('组合尺寸测量超时，本次未保存，请重新调整');
        cards?.dispose(); captured.own.submitted = true; latest.current.lock(false);
        const own = captured.own;
        await latest.current.execute({ commandId: crypto.randomUUID(), projectId: own.projectId, type: 'group.scale', expected: captured.expected,
          payload: { ...captured.payload, anchorCorner, scale: solved.scale, measurements: { cards: solved.cards, texts } } },
        () => { if (session.current === own) clear(); }, () => session.current === own);
      } catch (failure) { if (!cancelled && session.current === captured.own) { clear(); latest.current.fail(failure); } }
    }
  }
  return { scalable, rotatable, start, rotate, blocked: options.blocked, active: !!session.current,
    hasGesture: () => !!session.current && !session.current.submitted,
    cancel: () => { if (!session.current?.submitted) clear(); }, discard: clear,
    poses: Object.fromEntries(Object.entries(preview).map(([id, v]) => [id, v.item.pose])),
    project<T extends Node>(node: T): T {
      const value = preview[node.id];
      if (!value) return node;
      const text = 'kind' in value && value.kind === 'text';
      const owner = session.current, token = measurementRequest.current;
      return { ...node, position: value.item.pose, style: { ...node.style, width: value.item.pose.width, height: value.item.pose.height },
        data: { ...node.data, ...('body' in value ? { card: value, measurable: false } : { value }),
          ...(text ? { measurable: true, measurementRequest: token, measure: (width: number, height: number) => {
            const pending = sampling.current, current = projected.current[node.id] as CanvasText | undefined;
            if (owner !== session.current || !pending || pending.token !== token || !current ||
              current.versionId !== value.versionId || current.item.versionId !== value.item.versionId ||
              JSON.stringify(current.content) !== JSON.stringify((value as CanvasText).content)) return;
            pending.values[node.id] = { width, height };
            if (pending.ids.every(id => pending.values[id])) pending.complete();
          } } : {}) } };
    },
  };
}
