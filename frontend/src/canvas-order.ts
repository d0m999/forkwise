import type { Node } from "@xyflow/react";
import type { ProjectState } from "./api";

export function orderCanvas(
  nodes: Node[],
  state: ProjectState,
  selection: string[],
  options: { temporaryRaise?: boolean } = {},
): Node[] {
  const items = [...state.cards, ...(state.texts ?? []), ...(state.shapes ?? []), ...(state.images ?? [])].map(
    (value) => value.item,
  );
  items.sort((a, b) => (a.createdOrder ?? 0) - (b.createdOrder ?? 0));
  const rank = new Map(items.map((item, index) => [item.id, index + 1]));
  const cardsOnly = selection.length > 0 && selection.every((id) =>
    state.cards.some((card) => card.item.id === id),
  );
  const raise = options.temporaryRaise !== false && cardsOnly;
  return nodes.map((node) => ({
    ...node,
    zIndex:
      (rank.get(node.id) ?? 0) +
      (raise && selection.includes(node.id) ? items.length : 0),
  }));
}
