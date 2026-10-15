import type { Block } from '../../backend/src/mapping/contracts';
import { blockPlainText } from '../../backend/src/mapping/body-text';
import { editableTextBlock, type InlineMark } from '../../backend/src/mapping/general-blocks';
import { validListStructure } from '../../backend/src/mapping/list-structure';
import { sliceTextBlock, type BlockPoint } from './general-block-dom';

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
  return { ...rest, text: left.text! + right.text!, ...(marks.length ? { marks } : {}) };
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
  if (a.type === 'code' && first === last) {
    const text = inserted.map(blockPlainText).join('\n');
    const blocks = [...current];
    blocks[first] = {
      ...a,
      text: a.text!.slice(0, selection.start.offset) + text + a.text!.slice(selection.end.offset),
    };
    return { blocks, point: { blockId: a.id, offset: selection.start.offset + text.length } };
  }
  if (!current.slice(first, last + 1).every(editableTextBlock)) return null;
  const before = sliceTextBlock(a, 0, selection.start.offset),
    after = sliceTextBlock(z, selection.end.offset, z.text!.length);
  const content = structuredClone(inserted);
  if (a.type === 'listItem' && content.every((b) => b.type === 'text'))
    for (let i = 0; i < content.length; i++)
      content[i] = { ...a, ...content[i], type: 'listItem', marks: content[i]!.marks };
  const replacement: Block[] = [];
  if (
    content[0]!.type === 'text' ||
    (a.type === 'listItem' &&
      content[0]!.type === 'listItem' &&
      content[0]!.parentId === a.parentId)
  ) {
    content[0] = join(before, content[0]!);
  } else if (before.text) replacement.push(before);
  replacement.push(...content);
  const tail = replacement.at(-1)!;
  let point = { blockId: tail.id, offset: tail.text?.length ?? 0 };
  if (after.text) {
    if (tail.type === 'text' || (tail.type === 'listItem' && tail.parentId === z.parentId))
      replacement[replacement.length - 1] = join(tail, after);
    else {
      const following = {
        ...after,
        ...(replacement.some((b) => b.id === after.id)
          ? { id: crypto.randomUUID(), inlineId: crypto.randomUUID() }
          : {}),
      };
      replacement.push(following);
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
  if (!validListStructure(blocks)) return null;
  return { blocks, point };
}
