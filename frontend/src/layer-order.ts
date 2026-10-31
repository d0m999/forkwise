import type { ProjectState } from './api';
import { nextLayerOrder, type LayerOperation } from '../../backend/src/mapping/layer-algorithm';

export type { LayerOperation } from '../../backend/src/mapping/layer-algorithm';
export type LayerAvailability = Record<LayerOperation, boolean>;
export type LayerItem = {
  id: string;
  itemId: string;
  kind: 'card' | 'text' | 'shape' | 'image';
  item: {
    createdOrder?: number | undefined;
    versionId: string;
    pose: { x: number; y: number; width: number; height: number };
  };
};

export function layerItems(state: ProjectState): LayerItem[] {
  const values: LayerItem[] = [
    ...state.cards.map(value => ({ id: value.id, itemId: value.item.id, kind: 'card' as const, item: value.item })),
    ...(state.texts ?? []).map(value => ({ id: value.id, itemId: value.item.id, kind: 'text' as const, item: value.item })),
    ...(state.shapes ?? []).map(value => ({ id: value.id, itemId: value.item.id, kind: 'shape' as const, item: value.item })),
    ...(state.images ?? []).map(value => ({ id: value.id, itemId: value.item.id, kind: 'image' as const, item: value.item })),
  ];
  return values.sort((a, b) => (a.item.createdOrder ?? 0) - (b.item.createdOrder ?? 0));
}

export function layerItemIds(state: ProjectState, selection: string[]) {
  const content = new Set(layerItems(state).map(value => value.itemId));
  return [...new Set(selection)].filter(id => content.has(id));
}

export function layerAvailability(state: ProjectState, selection: string[]): LayerAvailability {
  const items = layerItems(state),
    current = items.map(value => value.itemId),
    selected = new Set(layerItemIds(state, selection));
  if (!selected.size) return { front: false, back: false, forward: false, backward: false };
  const nodes = items.map(value => ({ id: value.itemId, pose: value.item.pose }));
  const changes = (operation: LayerOperation) =>
    nextLayerOrder(nodes, selected, operation).some((id, index) => id !== current[index]);
  return {
    front: changes('front'),
    back: changes('back'),
    forward: changes('forward'),
    backward: changes('backward'),
  };
}
