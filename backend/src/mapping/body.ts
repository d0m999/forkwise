import type { Block, Card } from './contracts.js';
import { requireThat } from '../domain/errors.js';
import { canonical } from '../domain/canonical.js';

import { plainParagraph } from './body-text.js';
import { editableBlock } from './general-blocks.js';
import type Database from 'better-sqlite3';

export function requireBlockOwnership(db: Database.Database, body: Card['body'], blocks: Block[]) {
  const ids = new Set(blocks.map((b) => b.id));
  const inlineIds = new Map(blocks.filter((b) => b.inlineId).map((b) => [b.inlineId!, b.id]));
  // Immutable versions retain ownership even after deletion/merge and after a
  // block has left the 40-step history. This is a read, not a data migration.
  const rows = db.prepare("SELECT id,value FROM mapping_versions WHERE domain='body'").all() as {
    id: string;
    value: string;
  }[];
  for (const row of rows) {
    const previous = JSON.parse(row.value) as Card['body'];
    for (const block of previous.blocks) {
      requireThat(
        row.id === body.id || !ids.has(block.id),
        'BLOCK_ID_CONFLICT',
        '正文块身份已归属另一正文',
        409,
      );
      if (block.inlineId && inlineIds.has(block.inlineId))
        requireThat(
          row.id === body.id && inlineIds.get(block.inlineId) === block.id,
          'BLOCK_ID_CONFLICT',
          '行内身份已归属另一正文块',
          409,
        );
    }
  }
  for (const block of blocks) {
    const previous = body.blocks.find((b) => b.id === block.id);
    if (previous?.inlineId)
      requireThat(
        block.inlineId === previous.inlineId,
        'BLOCK_ID_CONFLICT',
        '既有行内身份须保持稳定',
        409,
      );
  }
}

export function editedBlocks(
  body: Card['body'],
  payload: { text?: string | undefined; blocks?: Block[] | undefined },
): Block[] {
  if (payload.blocks === undefined) {
    requireThat(
      body.blocks.length === 1 && plainParagraph(body.blocks[0]!),
      'BODY_FORMAT_UNSUPPORTED',
      '此正文须使用完整块编辑，原文已保留',
      409,
    );
    return [{ ...body.blocks[0]!, text: payload.text! }];
  }
  const blocks = structuredClone(payload.blocks);
  const ids = new Set<string>(),
    inlineIds = new Set<string>();
  for (const block of blocks) {
    requireThat(!ids.has(block.id), 'BLOCK_ID_CONFLICT', '正文块身份重复', 409);
    ids.add(block.id);
    if (block.inlineId) {
      requireThat(!inlineIds.has(block.inlineId), 'BLOCK_ID_CONFLICT', '正文行内身份重复', 409);
      inlineIds.add(block.inlineId);
    }
    const previous = body.blocks.find((b) => b.id === block.id);
    if (previous?.type === 'divider')
      requireThat(block.type === 'divider', 'BODY_FORMAT_UNSUPPORTED', '分隔线不支持文字转换', 409);
    if (!editableBlock(block) || (previous && !editableBlock(previous)))
      requireThat(
        previous && canonical(previous) === canonical(block),
        'BODY_FORMAT_UNSUPPORTED',
        '尚不支持的内容须保留原件',
        409,
      );
  }
  for (const block of body.blocks)
    if (!editableBlock(block))
      requireThat(
        blocks.some((b) => b.id === block.id && canonical(b) === canonical(block)),
        'BODY_FORMAT_UNSUPPORTED',
        '尚不支持的内容原件不能删除或降级',
        409,
      );
  const originals = body.blocks.filter((block) => !editableBlock(block)).map((block) => block.id);
  const originalIds = new Set(originals);
  requireThat(
    canonical(blocks.filter((block) => originalIds.has(block.id)).map((block) => block.id)) ===
      canonical(originals),
    'BODY_FORMAT_UNSUPPORTED',
    '尚不支持的内容须保留原顺序',
    409,
  );
  return blocks;
}

export function bodyContentUnchanged(before: Block[], after: Block[]): boolean {
  return (
    canonical(before) === canonical(after) ||
    (before.length === after.length &&
      before.every((b, i) => {
        const next = after[i]!;
        return (
          plainParagraph(b) &&
          plainParagraph(next) &&
          b.id === next.id &&
          b.text === next.text &&
          (b.inlineId === undefined || b.inlineId === next.inlineId)
        );
      }))
  );
}
