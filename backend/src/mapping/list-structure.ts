import type { Block } from './contracts.js';

// Body order is preorder. Only list items can be parents; a closed subtree
// cannot be resumed later in the document.
export function validListStructure(blocks: Block[]): boolean {
  const ancestors: string[] = [];
  for (const block of blocks) {
    if (block.parentId !== undefined) {
      if (block.type !== 'listItem' || typeof block.parentId !== 'string') return false;
      const parent = ancestors.indexOf(block.parentId);
      if (parent < 0) return false;
      ancestors.length = parent + 1;
    } else ancestors.length = 0;
    if (block.type === 'listItem') ancestors.push(block.id);
  }
  return true;
}

export function listEnd(blocks: Block[], index: number): number {
  const block = blocks[index];
  if (!block || block.type !== 'listItem') return index + 1;
  const parents = new Set([block.id]);
  let end = index + 1;
  while (end < blocks.length && parents.has(blocks[end]!.parentId as string)) {
    parents.add(blocks[end]!.id);
    end++;
  }
  return end;
}

export function previousListSibling(blocks: Block[], index: number): number {
  const block = blocks[index];
  if (block?.type !== 'listItem') return -1;
  for (let i = index - 1; i >= 0; i--) {
    const candidate = blocks[i]!;
    if (candidate.type !== 'listItem' || candidate.id === block.parentId) return -1;
    if (candidate.parentId === block.parentId) return i;
  }
  return -1;
}

export function withListParent(block: Block, parentId: unknown): Block {
  const { parentId: previous, ...rest } = block;
  return typeof parentId === 'string' ? { ...rest, parentId } : rest;
}

export function promoteListChildren(blocks: Block[], index: number): Block[] {
  const end = listEnd(blocks, index),
    parent = blocks[index]!;
  return blocks.map((block, i) =>
    i > index && i < end && block.parentId === parent.id
      ? withListParent(block, parent.parentId)
      : block,
  );
}

export function indentList(blocks: Block[], id: string, decrease: boolean): Block[] {
  const index = blocks.findIndex((b) => b.id === id),
    block = blocks[index];
  if (block?.type !== 'listItem') return blocks;
  const next = [...blocks];
  if (!decrease) {
    const previous = previousListSibling(blocks, index);
    if (previous < 0) return blocks;
    next[index] = withListParent(block, blocks[previous]!.id);
  } else {
    const parentIndex = blocks.findIndex((b) => b.id === block.parentId);
    if (parentIndex < 0) return blocks;
    const end = listEnd(blocks, index),
      parentEnd = listEnd(blocks, parentIndex);
    const group = next.splice(index, end - index);
    group[0] = withListParent(block, blocks[parentIndex]!.parentId);
    next.splice(parentEnd - group.length, 0, ...group);
  }
  return next;
}

export function listDepth(blocks: Block[], block: Block): number {
  let parent = block.parentId,
    depth = 0;
  const seen = new Set<string>();
  while (typeof parent === 'string' && !seen.has(parent)) {
    seen.add(parent);
    const ancestor = blocks.find((b) => b.id === parent);
    if (!ancestor) break;
    depth++;
    parent = ancestor.parentId;
  }
  return depth;
}

export function moveBlockRange(blocks: Block[], ids: string[], direction: -1 | 1): Block[] {
  const first = blocks.findIndex((b) => b.id === ids[0]),
    end = first + ids.length;
  if (first < 0 || !ids.every((id, i) => blocks[first + i]?.id === id)) return blocks;
  const parent = blocks[first]!.parentId;
  let target: number;
  if (direction === 1) {
    if (end === blocks.length || blocks[end]!.parentId !== parent) return blocks;
    target = listEnd(blocks, end);
  } else {
    target = first - 1;
    while (target >= 0 && blocks[target]!.parentId !== parent) {
      if (blocks[target]!.id === parent) return blocks;
      target--;
    }
    if (target < 0) return blocks;
  }
  const next = [...blocks],
    group = next.splice(first, ids.length);
  next.splice(direction === 1 ? target - group.length : target, 0, ...group);
  return validListStructure(next) ? next : blocks;
}
