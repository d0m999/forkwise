import type { Block } from './contracts.js';
import { plainParagraph } from './body-text.js';

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
  if (plainParagraph(block)) return true;
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
  return editableBlock(block) && typeof block.text === 'string';
}
