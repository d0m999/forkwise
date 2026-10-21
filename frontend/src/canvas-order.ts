import type { Node } from "@xyflow/react";
import type { ProjectState } from "./api";
export function orderCanvas(
  nodes: Node[],
  state: ProjectState,
  selection: string[],
): Node[] {
  const items = [...state.cards, ...(state.texts ?? [])].map(
    (value) => value.item,
  );
  items.sort((a, b) => (a.createdOrder ?? 0) - (b.createdOrder ?? 0));
  const rank = new Map(items.map((item, index) => [item.id, index + 1]));
  const cardsOnly = selection.every((id) =>
    state.cards.some((card) => card.item.id === id),
  );
  return nodes.map((node) => ({
    ...node,
    zIndex:
      (rank.get(node.id) ?? 0) +
      (cardsOnly && selection.includes(node.id) ? items.length : 0),
  }));
}
