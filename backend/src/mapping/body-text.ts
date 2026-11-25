import type { Block, BodyPatch, Card } from './contracts.js';

// Recovery validates the JSON shape without loading server command schemas
// into the browser. Extra keys are preserved, never treated as supported input.
export function validBlocks(value: unknown): value is Block[] {
  const id = (v: unknown) => typeof v === 'string' && v.length > 0 && v.length <= 160;
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(
      (b) =>
        b &&
        typeof b === 'object' &&
        id(b.id) &&
        typeof b.type === 'string' &&
        b.type.length > 0 &&
        (b.text === undefined || typeof b.text === 'string') &&
        (b.inlineId === undefined || id(b.inlineId)),
    )
  );
}

export function bodyText(body: Pick<Card['body'], 'blocks'>): string {
  return body.blocks.map(blockPlainText).join('\n');
}

export function hasPreviewText(body: Pick<Card['body'], 'blocks'>): boolean {
  return body.blocks.some(block => typeof block.text === 'string' && block.text.trim().length > 0);
}

export function blockPlainText(block: Block): string {
  if (typeof block.text === 'string') return block.text;
  if (block.type === 'image') return typeof block.caption==='string'?block.caption:'';
  if (block.type === 'imageTask' && typeof block.name === 'string') return `${block.name}（${block.status==='failed'?'图片失败':'图片处理中'}）`;
  if (block.type === 'pendingImage' && typeof block.name === 'string')
    return `${block.name}（图片尚未支持）`;
  if (block.type === 'table' && Array.isArray(block.rows))
    return block.rows
      .map((row) =>
        Array.isArray(row)
          ? row.map((cell) => (cell && typeof cell.text === 'string' ? cell.text : '')).join('\t')
          : '',
      )
      .join('\n');
  return '';
}

// Only this ticket's plain paragraphs are editable. Other JSON remains original
// data, including text blocks with fields belonging to a future editor.
export function plainParagraph(block: Block): block is Block & { type: 'text'; text: string } {
  return (
    block.type === 'text' &&
    typeof block.text === 'string' &&
    Object.keys(block).every((key) => ['id', 'type', 'text', 'inlineId'].includes(key))
  );
}

function splitsSurrogate(text: string, offset: number): boolean {
  const before = text.charCodeAt(offset - 1);
  const after = text.charCodeAt(offset);
  return before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff;
}

export function validBodyPatchRange(text: string, { start, end }: BodyPatch['payload']['range']): boolean {
  return start <= end && end <= text.length &&
    !splitsSurrogate(text, start) && !splitsSurrogate(text, end);
}
