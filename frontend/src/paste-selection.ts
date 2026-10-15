import type { Block } from '../../backend/src/mapping/contracts';
import { blockPlainText } from '../../backend/src/mapping/body-text';
import {
  editableBlock,
  editableTextBlock,
  type InlineMark,
} from '../../backend/src/mapping/general-blocks';
import { listEnd, validListStructure } from '../../backend/src/mapping/list-structure';
import { sliceTextBlock, type BlockPoint } from './general-block-dom';
import { cellBlock, withCell, sameCell } from './table-selection';

export function plainTextBlocks(text: string): Block[] {
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((text) => ({
      id: crypto.randomUUID(),
      inlineId: crypto.randomUUID(),
      type: 'text',
      text,
    }));
}
function join(left: Block, right: Block): Block {
  const offset = left.text!.length;
  const marks = [
    ...((left.marks ?? []) as InlineMark[]),
    ...((right.marks ?? []) as InlineMark[]).map((m) => ({
      ...m,
      start: m.start + offset,
      end: m.end + offset,
    })),
  ];
  const { marks: oldMarks, ...rest } = left;
  return {
    ...rest,
    text: left.text! + right.text!,
    ...(marks.length ? { marks } : {}),
  };
}

export function replaceTextSelection(
  current: Block[],
  selection: { start: BlockPoint; end: BlockPoint },
  inserted: Block[],
) {
  const first = current.findIndex((b) => b.id === selection.start.blockId),
    last = current.findIndex((b) => b.id === selection.end.blockId);
  const a = current[first],
    z = current[last];
  if (!a || !z || last < first || !inserted.length) return null;
  if (a.type === 'table' && sameCell(selection.start, selection.end)) {
    if (inserted.some((block) => block.type === 'pendingImage' || !editableBlock(block)))
      return null;
    const cell = cellBlock(a, selection.start.cell);
    if (!cell) return null;
    const inline = inserted.map((b) => ({
      id: 'cell',
      type: 'text',
      text: blockPlainText(b),
      ...(editableTextBlock(b) && b.marks ? { marks: b.marks } : {}),
    }));
    let content: Block = inline[0]!;
    for (const next of inline.slice(1))
      content = join(join(content, { id: 'cell', type: 'text', text: '\n' }), next);
    const result = join(
      join(sliceTextBlock(cell, 0, selection.start.offset), content),
      sliceTextBlock(cell, selection.end.offset, cell.text!.length),
    );
    const blocks = [...current];
    blocks[first] = withCell(a, selection.start.cell!, result);
    return {
      blocks,
      point: {
        ...selection.start,
        offset: selection.start.offset + content.text!.length,
      },
    };
  }
  if (a.type === 'code' && first === last) {
    const text = inserted.map(blockPlainText).join('\n');
    const blocks = [...current];
    blocks[first] = {
      ...a,
      text: a.text!.slice(0, selection.start.offset) + text + a.text!.slice(selection.end.offset),
    };
    return {
      blocks,
      point: { blockId: a.id, offset: selection.start.offset + text.length },
    };
  }
  if (!current.slice(first, last + 1).every(editableTextBlock)) return null;
  const before = sliceTextBlock(a, 0, selection.start.offset),
    after = sliceTextBlock(z, selection.end.offset, z.text!.length);
  const content = structuredClone(inserted);
  if (a.type === 'listItem' && content.every((b) => b.type === 'text'))
    for (let i = 0; i < content.length; i++)
      content[i] = {
        ...a,
        ...content[i],
        type: 'listItem',
        marks: content[i]!.marks,
      };
  if (
    a.type === 'listItem' &&
    a.parentId &&
    content.every((b) => b.type === 'listItem' && editableTextBlock(b))
  )
    for (let i = 0; i < content.length; i++)
      if (!content[i]!.parentId) content[i] = { ...content[i]!, parentId: a.parentId };
  const replacement: Block[] = [];
  if (
    content[0]!.type === 'text' ||
    (a.type === 'listItem' &&
      content[0]!.type === 'listItem' &&
      content[0]!.parentId === a.parentId)
  ) {
    const incomingId = content[0]!.id;
    content[0] = join(before, content[0]!);
    // The joined root keeps the destination identity. Its copied children
    // must follow that surviving root, not the incoming identity it replaced.
    for (let i = 1; i < content.length; i++)
      if (
        editableTextBlock(content[i]!) &&
        content[i]!.type === 'listItem' &&
        content[i]!.parentId === incomingId
      )
        content[i] = { ...content[i]!, parentId: content[0]!.id };
  } else if (before.text) replacement.push(before);
  replacement.push(...content);
  const tail = replacement.at(-1)!;
  let point = { blockId: tail.id, offset: tail.text?.length ?? 0 };
  const hasFollowingChildren = listEnd(current, last) > last + 1;
  let endpointParent = z.id;
  let suffixAfterChildren: Block | undefined;
  if (after.text || hasFollowingChildren) {
    if (
      (tail.type === 'text' || (tail.type === 'listItem' && tail.parentId === z.parentId)) &&
      (!hasFollowingChildren || tail.type === 'listItem')
    ) {
      replacement[replacement.length - 1] = join(tail, after);
      endpointParent = tail.id;
    } else {
      const following: Block = {
        ...after,
        ...(replacement.some((b) => b.id === after.id)
          ? { id: crypto.randomUUID(), inlineId: crypto.randomUUID() }
          : {}),
      };
      if (
        hasFollowingChildren &&
        first === last &&
        following.type === 'listItem' &&
        following.parentId === z.parentId &&
        replacement.some((b) => b.id === z.id)
      )
        suffixAfterChildren = following;
      else replacement.push(following);
      endpointParent = following.id;
      if (['table', 'pendingImage', 'divider'].includes(tail.type))
        point = { blockId: following.id, offset: 0 };
    }
  } else if (['table', 'pendingImage', 'divider'].includes(tail.type)) {
    const following = plainTextBlocks('')[0]!;
    replacement.push(following);
    point = { blockId: following.id, offset: 0 };
  }
  const blocks = [...current];
  blocks.splice(first, last - first + 1, ...replacement);
  // As with splitting a list item at the caret, the original unselected
  // subtree stays with that item. Its new sibling suffix follows the group.
  if (suffixAfterChildren)
    blocks.splice(
      first + replacement.length + listEnd(current, last) - last - 1,
      0,
      suffixAfterChildren,
    );
  // A continuous text selection does not select the endpoint's descendants.
  // If compatible text merged away that endpoint, its unselected children
  // belong to the surviving list item; their own IDs and subtrees stay intact.
  if (hasFollowingChildren && endpointParent !== z.id && !blocks.some((b) => b.id === z.id))
    for (let i = first + replacement.length; i < blocks.length; i++)
      if (
        editableTextBlock(blocks[i]!) &&
        blocks[i]!.type === 'listItem' &&
        blocks[i]!.parentId === z.id
      )
        blocks[i] = { ...blocks[i]!, parentId: endpointParent };
  if (!validListStructure(blocks)) return null;
  return { blocks, point };
}
