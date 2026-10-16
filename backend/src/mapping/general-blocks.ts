import { validImage, validImageTask } from './media-blocks.js';
import type { Block } from './contracts.js';
import { plainParagraph } from './body-text.js';
import { invalidListStructureIds } from './list-structure.js';
import { validPendingImage } from './pending-image.js';

export const INLINE_TYPES = [
  'bold',
  'italic',
  'underline',
  'strikethrough',
  'code',
  'link',
  'textColor',
  'highlight',
] as const;
export const TEXT_COLORS = ['default', 'gray', 'red', 'orange', 'green', 'blue', 'purple'] as const;
export const HIGHLIGHTS = ['yellow', 'green', 'blue', 'pink'] as const;
export type InlineMark = {
  type: (typeof INLINE_TYPES)[number];
  start: number;
  end: number;
  value?: string;
};
export type TextBlock = Block & { text: string; marks?: InlineMark[] };
export type TableCell = { text: string; marks?: InlineMark[] };

export function safeLink(value: string): boolean {
  try {
    return ['https:', 'http:', 'mailto:'].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}
function validMark(value: unknown, length: number): value is InlineMark {
  if (!value || typeof value !== 'object') return false;
  const m = value as InlineMark;
  if (
    !INLINE_TYPES.includes(m.type) ||
    !Number.isInteger(m.start) ||
    !Number.isInteger(m.end) ||
    m.start < 0 ||
    m.end <= m.start ||
    m.end > length ||
    !Object.keys(m).every((k) => ['type', 'start', 'end', 'value'].includes(k))
  )
    return false;
  if (m.type === 'link') return typeof m.value === 'string' && safeLink(m.value);
  if (m.type === 'textColor') return TEXT_COLORS.includes(m.value as (typeof TEXT_COLORS)[number]);
  if (m.type === 'highlight') return HIGHLIGHTS.includes(m.value as (typeof HIGHLIGHTS)[number]);
  return m.value === undefined;
}

// Recognition is deliberately exact: extension JSON stays a read-only original.
export function editableBlock(block: Block): boolean {
  if (block.type==='image') return validImage(block);
  if (block.type==='imageTask') return validImageTask(block);
  if (plainParagraph(block)) return true;
  if (block.type === 'pendingImage') return validPendingImage(block);
  if (block.type === 'code')
    return (
      typeof block.text === 'string' &&
      typeof block.language === 'string' &&
      typeof block.wrap === 'boolean' &&
      Object.keys(block).every((k) =>
        ['id', 'type', 'inlineId', 'text', 'language', 'wrap'].includes(k),
      )
    );
  if (block.type === 'table') {
    const rows = block.rows;
    return (
      typeof block.header === 'boolean' &&
      Object.keys(block).every((k) =>
        ['id', 'type', 'inlineId', 'rows', 'header', 'columnWidths'].includes(k),
      ) &&
      Array.isArray(rows) &&
      rows.length > 0 &&
      Array.isArray(rows[0]) &&
      rows[0].length > 0 &&
      (block.columnWidths === undefined ||
        (Array.isArray(block.columnWidths) &&
          block.columnWidths.length === rows[0].length &&
          block.columnWidths.every(
            (width) =>
              typeof width === 'number' && Number.isFinite(width) && width >= 48 && width <= 2000,
          ))) &&
      rows.every(
        (row) =>
          Array.isArray(row) &&
          row.length === rows[0].length &&
          row.every(
            (cell) =>
              cell &&
              typeof cell === 'object' &&
              typeof cell.text === 'string' &&
              Object.keys(cell).every((k) => ['text', 'marks'].includes(k)) &&
              (cell.marks === undefined ||
                (Array.isArray(cell.marks) &&
                  cell.marks.every((m: unknown) => validMark(m, cell.text.length)))),
          ),
      )
    );
  }
  if (block.type === 'divider')
    return Object.keys(block).every((k) => ['id', 'type', 'inlineId'].includes(k));
  const keys = ['id', 'type', 'text', 'inlineId', 'marks'];
  if (block.type === 'heading') {
    if (![1, 2, 3].includes(block.level as number)) return false;
    keys.push('level');
  } else if (block.type === 'listItem') {
    if (!['bullet', 'ordered', 'todo'].includes(block.listType as string)) return false;
    keys.push('listType');
    if (block.parentId !== undefined) {
      if (typeof block.parentId !== 'string' || !block.parentId || block.parentId.length > 160)
        return false;
      keys.push('parentId');
    }
    if (block.listType === 'todo') {
      if (typeof block.checked !== 'boolean') return false;
      keys.push('checked');
    }
  } else if (!['text', 'quote'].includes(block.type)) return false;
  return (
    typeof block.text === 'string' &&
    Object.keys(block).every((key) => keys.includes(key)) &&
    (block.marks === undefined ||
      (Array.isArray(block.marks) && block.marks.every((m) => validMark(m, block.text!.length))))
  );
}

export function editableTextBlock(block: Block): block is TextBlock {
  return block.type !== 'code' && editableBlock(block) && typeof block.text === 'string';
}

// A recognized list shape may still be an unsupported legacy original when its
// parent cannot be interpreted in this body. Do not reinterpret that JSON.
export function unsupportedBlockIds(blocks: Block[]): Set<string> {
  const unsupported = new Set(
    blocks.filter((block) => !editableBlock(block)).map((block) => block.id),
  );
  const structure = blocks.map((block) =>
    unsupported.has(block.id) ? { id: block.id, type: 'opaque' } : block,
  );
  for (const id of invalidListStructureIds(structure)) unsupported.add(id);
  return unsupported;
}
