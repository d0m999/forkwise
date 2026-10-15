import type { Block } from '../../backend/src/mapping/contracts';
import {
  editableTextBlock,
  safeLink,
  type InlineMark,
} from '../../backend/src/mapping/general-blocks';
import { sliceTextBlock } from './general-block-dom';

export type TypedRun = { blockId: string; start: number; end: number; text: string };

// Only the range supplied by the current input session is eligible. Historical
// text outside that range is never fed back through a Markdown parser.
export function markdownShortcut(block: Block, run: TypedRun): Block | null {
  if (!editableTextBlock(block) || block.text.slice(run.start, run.end) !== run.text) return null;
  if (run.start === 0) {
    let shape: Partial<Block> | undefined;
    if (block.type === 'text') {
      if (/^#{1,3} $/.test(run.text)) shape = { type: 'heading', level: run.text.length - 1 };
      else if (/^[-+*] $/.test(run.text)) shape = { type: 'listItem', listType: 'bullet' };
      else if (/^\d+[.)] $/.test(run.text)) shape = { type: 'listItem', listType: 'ordered' };
      else if (run.text === '> ') shape = { type: 'quote' };
      else if (block.text === run.text && /^(---|\*\*\*|___)$/.test(run.text))
        return { id: block.id, type: 'divider', inlineId: block.inlineId };
    }
    if ((block.type === 'text' || block.type === 'listItem') && /^\[[ xX]\] $/.test(run.text))
      shape = { type: 'listItem', listType: 'todo', checked: run.text[1]!.toLowerCase() === 'x' };
    if (shape) {
      const remaining = sliceTextBlock(block, run.end, block.text.length);
      return {
        id: block.id,
        inlineId: block.inlineId,
        text: remaining.text!,
        ...(remaining.marks ? { marks: remaining.marks } : {}),
        ...(shape.type === 'listItem' && block.parentId ? { parentId: block.parentId } : {}),
        ...shape,
      } as Block;
    }
  }
  const patterns: [RegExp, InlineMark['type'], number][] = [
    [/\*\*([^*\n]+)\*\*$/, 'bold', 2],
    [/__([^_\n]+)__$/, 'bold', 2],
    [/(?<!\*)\*([^*\n]+)\*$/, 'italic', 1],
    [/(?<!_)_([^_\n]+)_$/, 'italic', 1],
    [/~~([^~\n]+)~~$/, 'strikethrough', 2],
    [/`([^`\n]+)`$/, 'code', 1],
    [/\[([^\]\n]+)\]\(([^\s)]+)\)$/, 'link', 1],
  ];
  for (const [pattern, type, delimiter] of patterns) {
    const match = run.text.match(pattern);
    if (!match || (type === 'link' && !safeLink(match[2]!))) continue;
    const start = run.start + match.index!,
      end = run.end;
    if (start && block.text[start - 1] === '\\') continue;
    if (
      ((block.marks ?? []) as InlineMark[]).some(
        (m) => m.type === 'code' && m.start < end && m.end > start,
      )
    )
      continue;
    const content = match[1]!;
    const left = sliceTextBlock(block, 0, start),
      right = sliceTextBlock(block, end, block.text.length);
    const inside = sliceTextBlock(block, start + delimiter, start + delimiter + content.length);
    const marks: InlineMark[] = [
      ...((left.marks ?? []) as InlineMark[]),
      ...((inside.marks ?? []) as InlineMark[]).map((m) => ({
        ...m,
        start: m.start + start,
        end: m.end + start,
      })),
      {
        type,
        start,
        end: start + content.length,
        ...(type === 'link' ? { value: match[2]! } : {}),
      },
      ...((right.marks ?? []) as InlineMark[]).map((m) => ({
        ...m,
        start: m.start + start + content.length,
        end: m.end + start + content.length,
      })),
    ];
    return { ...block, text: left.text! + content + right.text!, marks };
  }
  return null;
}
