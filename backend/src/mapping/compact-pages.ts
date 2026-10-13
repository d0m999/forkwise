import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { DomainError, requireThat } from '../domain/errors.js';
import type { CompactPage } from './compact-contracts.js';

type Position = { snapshot: string; view: string; offset: number };
export class CompactPages {
  private readonly secret = randomBytes(32);
  private sign(text: string) {
    return createHmac('sha256', this.secret).update(text).digest('base64url');
  }
  cursor(position: Position) {
    const text = Buffer.from(JSON.stringify(position)).toString('base64url');
    return text + '.' + this.sign(text);
  }
  offset(cursor: string | undefined, snapshot: string, view: string): number {
    if (!cursor) return 0;
    const parts = cursor.split('.');
    const [text, signature] = parts;
    const expected = this.sign(text ?? '');
    requireThat(
      text &&
        signature &&
        parts.length === 2 &&
        signature.length === expected.length &&
        /^[A-Za-z0-9_-]+$/.test(signature) &&
        timingSafeEqual(Buffer.from(signature), Buffer.from(expected)),
      'INVALID_CURSOR',
      '分页游标无效',
      409,
    );
    let position: Position;
    try {
      position = JSON.parse(Buffer.from(text, 'base64url').toString('utf8')) as Position;
    } catch {
      throw new DomainError('INVALID_CURSOR', '分页游标无效', 409);
    }
    requireThat(
      position.snapshot === snapshot &&
        position.view === view &&
        Number.isSafeInteger(position.offset) &&
        position.offset > 0,
      'INVALID_CURSOR',
      '游标与本次读取不匹配',
      409,
    );
    return position.offset;
  }
  page<T>(
    base: Omit<CompactPage<T>, 'bytes' | 'items' | 'coverage' | 'nextCursor'>,
    items: T[],
    start: number,
    budget: number,
    view: string,
  ): CompactPage<T> {
    requireThat(start <= items.length, 'INVALID_CURSOR', '分页游标越界', 409);
    const make = (end: number) => {
      const page: CompactPage<T> = {
        ...base,
        bytes: 0,
        items: items.slice(start, end),
        coverage: { start, end, complete: end === items.length },
        nextCursor:
          end < items.length ? this.cursor({ snapshot: base.snapshot, view, offset: end }) : null,
      };
      // Count the bytes field itself, including changes in its decimal width.
      for (;;) {
        const size = Buffer.byteLength(JSON.stringify(page), 'utf8');
        if (size === page.bytes) return page;
        page.bytes = size;
      }
    };
    // The terminal page has no cursor and can be smaller than an intermediate
    // prefix. Check it before assuming prefix sizes are monotone.
    const full = make(items.length);
    if (full.bytes <= budget) return structuredClone(full);
    const empty = make(start);
    if (empty.bytes > budget)
      throw new DomainError('BUDGET_TOO_SMALL', '完整响应元数据的预算不足', 413, {
        budgetUnit: 'utf8_bytes',
        requiredBytes: empty.bytes,
      });
    let result = empty;
    for (let end = start + 1; end <= items.length; end++) {
      const candidate = make(end);
      if (candidate.bytes > budget) {
        if (end === start + 1)
          throw new DomainError('ITEM_EXCEEDS_BUDGET', '不可拆结构项超过完整响应预算', 413, {
            budgetUnit: 'utf8_bytes',
            requiredBytes: candidate.bytes,
          });
        break;
      }
      result = candidate;
    }
    return structuredClone(result);
  }
}
