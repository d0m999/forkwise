import type { Block, Card } from './contracts.js';

// Recovery validates the JSON shape without loading server command schemas
// into the browser. Extra keys are preserved, never treated as supported input.
export function validBlocks(value: unknown): value is Block[] {
  const id = (v: unknown) => typeof v === 'string' && v.length > 0 && v.length <= 160;
  return Array.isArray(value) && value.length > 0 && value.every(b => b && typeof b === 'object' && id(b.id) && typeof b.type === 'string' && b.type.length > 0 && (b.text === undefined || typeof b.text === 'string') && (b.inlineId === undefined || id(b.inlineId)));
}

export function bodyText(body: Pick<Card['body'], 'blocks'>): string {
  return body.blocks.map((block) => typeof block.text === 'string' ? block.text : '').join('\n');
}

// Only this ticket's plain paragraphs are editable. Other JSON remains original
// data, including text blocks with fields belonging to a future editor.
export function plainParagraph(block: Block): boolean {
  return block.type === 'text' && typeof block.text === 'string' &&
    Object.keys(block).every((key) => ['id', 'type', 'text', 'inlineId'].includes(key));
}

