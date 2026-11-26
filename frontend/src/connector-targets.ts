import { sidePoint } from '../../backend/src/mapping/container-endpoints';
import { endpointKey } from '../../backend/src/mapping/connector-contracts';
import { useLayoutEffect, useRef, useState } from 'react';
import { useNodesInitialized, useStore } from '@xyflow/react';
import type { ConnectorEndpoint } from '../../backend/src/mapping/connector-contracts';
import type { ProjectState } from './api';
import type { ConnectorPoint } from './connector-geometry';

type Side = Extract<ConnectorEndpoint, { kind: 'bound' }>['side'];
export type ConnectorTarget = { itemId: string; targetKind?: 'group' | 'frame'; side: Side; point: ConnectorPoint; label: string };
const SNAP_DISTANCE = 12;
export function useConnectorTargets(state: ProjectState | null, world: (client: ConnectorPoint) => ConnectorPoint) {
  const nodesInitialized = useNodesInitialized();
  // Object ranks and the temporary selected-card lift can exceed the default control layer.
  const controlsLayer = useStore(store => store.nodes.reduce(
    (layer, node) => Math.max(layer, (node.zIndex ?? 0) + 1), 5));
  const nodeGeometry = useStore(store => JSON.stringify(store.nodes.map(node => [
    node.id, node.position.x, node.position.y, node.measured?.width, node.measured?.height, node.width, node.height, node.hidden,
  ])));
  const current = useRef({ state, world }); current.current = { state, world };
  const [targets, setTargets] = useState<ConnectorTarget[]>([]);
  function read() {
    const project = current.current.state;
    const allowed = new Map<string, { selector: string; label: string }>([
      ...(project?.cards.map(card => [card.item.id, { selector: 'article.thought-card', label: '卡片 ' + card.title }] as const) ?? []),
      ...(project?.shapes?.map(shape => [shape.item.id, { selector: 'div[role=img]', label: '形状 ' + shape.id }] as const) ?? []),
      ...(project?.texts?.map(text => [text.item.id, { selector: 'article.canvas-text', label: '独立文字 ' + text.id }] as const) ?? []),
      ...(project?.images?.map(image => [image.item.id, { selector: '.canvas-image-object', label: '图片 ' + image.id }] as const) ?? []),
    ]);
    const values: (ConnectorTarget & { client: ConnectorPoint; surface: HTMLElement; box: DOMRect })[] = [];
    for (const node of document.querySelectorAll<HTMLElement>('.react-flow__node[data-id]')) {
      const itemId = node.dataset.id;
      if (!itemId || !allowed.has(itemId)) continue;
      const target = allowed.get(itemId)!, surface = node.querySelector<HTMLElement>(target.selector);
      if (!surface || surface.closest('[inert]') || !surface.getClientRects().length || getComputedStyle(surface).visibility !== 'visible') continue;
      const box = surface.getBoundingClientRect();
      if (!box.width || !box.height) continue;
      const sides: [Side, ConnectorPoint][] = [
        ['top', { x: box.left + box.width / 2, y: box.top }], ['right', { x: box.right, y: box.top + box.height / 2 }],
        ['bottom', { x: box.left + box.width / 2, y: box.bottom }], ['left', { x: box.left, y: box.top + box.height / 2 }],
      ];
      for (const [side, client] of sides) values.push({ itemId, side, client, point: current.current.world(client), surface, box, label: target.label });
    }
    for (const container of [
      ...(project?.groups?.map(group => ({ itemId: group.itemId, targetKind: 'group' as const, selector: `[data-group-id="${CSS.escape(group.id)}"]`, label: '组合' })) ?? []),
      ...(project?.frames?.map(frame => ({ itemId: frame.id, targetKind: 'frame' as const, selector: `[data-frame-id="${CSS.escape(frame.id)}"]`, label: '分区 ' + frame.name })) ?? []),
    ]) {
      const surface = document.querySelector<HTMLElement>(container.selector);
      if (!surface || !surface.getClientRects().length) continue;
      const box = surface.getBoundingClientRect();
      for (const side of ['top', 'right', 'bottom', 'left'] as const) {
        const client = sidePoint({ x: box.x, y: box.y, width: box.width, height: box.height }, side);
        values.push({ itemId: container.itemId, targetKind: container.targetKind, side, client, point: current.current.world(client), surface, box, label: container.label });
      }
    }
    return values;
  }
  useLayoutEffect(() => {
    const measure = () => {
      const next = read().map(({ itemId, targetKind, side, point, label }) => ({ itemId, ...(targetKind ? { targetKind } : {}), side, point, label }));
      setTargets(previous => JSON.stringify(previous) === JSON.stringify(next) ? previous : next);
    };
    measure();
    const observer = new ResizeObserver(measure);
    for (const value of read()) observer.observe(value.surface);
    const movement = new MutationObserver(measure);
    for (const value of read().filter(value => value.targetKind)) movement.observe(value.surface, { attributes: true, attributeFilter: ['style'] });
    return () => { observer.disconnect(); movement.disconnect(); };
  }, [state, nodesInitialized, nodeGeometry]);
  return {
    controlsLayer,
    values: targets,
    origin(client: ConnectorPoint, lookup?: 'card-edge') {
      const candidates = read();
      let nearest = candidates.map(value => ({ ...value, distance: Math.hypot(value.client.x - client.x, value.client.y - client.y) }))
        .filter(value => value.distance <= SNAP_DISTANCE).sort((a, b) => a.distance - b.distance)[0];
      if (!nearest && lookup === 'card-edge') {
        const hit = document.elementFromPoint(client.x, client.y);
        const card = hit?.closest('article.thought-card');
        if (card || hit?.classList.contains('react-flow__pane')) {
          nearest = candidates.flatMap(value => {
            if (!value.surface.matches('article.thought-card') || card && card !== value.surface) return [];
            const horizontal = value.side === 'top' || value.side === 'bottom';
            const { left, right, top, bottom } = value.box;
            const distance = horizontal ? Math.abs(client.y - value.client.y) : Math.abs(client.x - value.client.x);
            const onEdge = horizontal ? client.x >= left && client.x <= right : client.y >= top && client.y <= bottom;
            if (!onEdge || distance > SNAP_DISTANCE) return [];
            // The visible card face can extend past an edge covered by another object.
            // Hit-test the edge itself even when the pointer is inside the card.
            const inside = horizontal
              ? { x: client.x, y: value.client.y + (value.side === 'top' ? 1 : -1) }
              : { x: value.client.x + (value.side === 'left' ? 1 : -1), y: client.y };
            return document.elementFromPoint(inside.x, inside.y)?.closest('article.thought-card') === value.surface
              ? [{ ...value, distance }] : [];
          }).sort((a, b) => a.distance - b.distance)[0];
        }
      }
      return nearest ? { endpoint: { kind: 'bound' as const, itemId: nearest.itemId, ...(nearest.targetKind ? { targetKind: nearest.targetKind } : {}), side: nearest.side }, point: nearest.point } : null;
    },
    resolve(endpoint: ConnectorEndpoint) {
      return endpoint.kind === 'free' ? endpoint.point : targets.find(value => endpointKey({ kind: 'bound', ...value }) === endpointKey(endpoint) && value.side === endpoint.side)?.point ?? null;
    },
  };
}
