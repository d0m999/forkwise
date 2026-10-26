import { useLayoutEffect, useRef, useState } from 'react';
import { useNodesInitialized, useStore } from '@xyflow/react';
import type { ConnectorEndpoint } from '../../backend/src/mapping/connector-contracts';
import type { ProjectState } from './api';
import type { ConnectorPoint } from './connector-geometry';

type Side = Extract<ConnectorEndpoint, { kind: 'bound' }>['side'];
export type ConnectorTarget = { itemId: string; side: Side; point: ConnectorPoint; label: string };
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
    const values: (ConnectorTarget & { client: ConnectorPoint; surface: HTMLElement })[] = [];
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
      for (const [side, client] of sides) values.push({ itemId, side, client, point: current.current.world(client), surface, label: target.label });
    }
    return values;
  }
  useLayoutEffect(() => {
    const measure = () => {
      const next = read().map(({ itemId, side, point, label }) => ({ itemId, side, point, label }));
      setTargets(previous => JSON.stringify(previous) === JSON.stringify(next) ? previous : next);
    };
    measure();
    const observer = new ResizeObserver(measure);
    for (const value of read()) observer.observe(value.surface);
    return () => observer.disconnect();
  }, [state, nodesInitialized, nodeGeometry]);
  return {
    controlsLayer,
    values: targets,
    origin(client: ConnectorPoint) {
      const nearest = read().map(value => ({ ...value, distance: Math.hypot(value.client.x - client.x, value.client.y - client.y) }))
        .filter(value => value.distance <= 12).sort((a, b) => a.distance - b.distance)[0];
      return nearest ? { endpoint: { kind: 'bound' as const, itemId: nearest.itemId, side: nearest.side }, point: nearest.point } : null;
    },
    resolve(endpoint: ConnectorEndpoint) {
      return endpoint.kind === 'free' ? endpoint.point : targets.find(value => value.itemId === endpoint.itemId && value.side === endpoint.side)?.point ?? null;
    },
  };
}
