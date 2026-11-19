import { DomainError, requireThat } from '../domain/errors.js';
import type { Principal, SessionCapabilities } from '../services/access.js';
import { bodyText, plainParagraph } from './body-text.js';
import { BodyPatchCommand, MAX_BODY_TEXT_LENGTH, type BodyPatch, type Card, type Command } from './contracts.js';

export function parseBodyPatch(input: object): BodyPatch {
  const sources = ['actor', 'origin', 'delegation'];
  const payload = 'payload' in input ? input.payload : undefined;
  requireThat(
    !sources.some(key => Object.hasOwn(input, key) ||
      (payload && typeof payload === 'object' && Object.hasOwn(payload, key))),
    'UNTRUSTED_PRINCIPAL', '调用者身份和范围必须来自可信会话', 403,
  );
  const result = BodyPatchCommand.safeParse(input);
  if (!result.success) {
    requireThat(
      !result.error.issues.some(issue => issue.path[0] === 'payload' && issue.path[1] === 'range'),
      'CONTENT_RANGE_INVALID', '补丁区间须使用同一块内的非负 UTF-16 整数偏移', 400,
    );
    throw result.error;
  }
  return result.data;
}

export function requireContentWrite(actor: Principal, command: Command, capabilities: SessionCapabilities) {
  if (actor.actor.type !== 'agent') return;
  const delegations = capabilities.contentDelegations;
  if (command.type !== 'body.patch') {
    if (delegations === undefined) return;
    // A separate layout grant still goes through the full layout and
    // project edit checks. Neither delegation widens the other.
    requireThat(
      (command.type === 'pose.move' || command.type === 'pose.batch') &&
        capabilities.layoutDelegations?.some(scope => scope.projectId === command.projectId),
      'CONTENT_OPERATION_UNSUPPORTED', '正文授权只允许修改已授权块的文字区间', 403,
    );
    return;
  }
  const project = (delegations ?? []).filter(scope => scope.projectId === command.projectId);
  requireThat(project.length, 'CONTENT_DELEGATION_REQUIRED', '此会话没有该项目的正文授权', 403);
  const operations = project.filter(scope => scope.operations.includes(command.type));
  requireThat(operations.length, 'CONTENT_OPERATION_FORBIDDEN', '正文授权未包含此操作', 403);
  const { id, blockId } = command.payload;
  const cards = operations.filter(scope => scope.objectKinds.includes('card') &&
    (scope.objectIds === '*' || scope.objectIds.includes(id)));
  requireThat(cards.length, 'CONTENT_OBJECT_FORBIDDEN', '正文授权未包含该卡片', 403);
  requireThat(
    cards.some(scope => scope.blockIds === '*' || scope.blockIds.includes(blockId)),
    'CONTENT_BLOCK_FORBIDDEN', '正文授权未包含该块', 403,
  );
}

function splitsSurrogate(text: string, offset: number): boolean {
  const before = text.charCodeAt(offset - 1);
  const after = text.charCodeAt(offset);
  return before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff;
}

export function patchedBlocks(card: Card, command: BodyPatch): Card['body']['blocks'] {
  const { blockId, range: { start, end }, text } = command.payload;
  const blocks = card.body.blocks;
  const index = blocks.findIndex(block => block.id === blockId);
  const block = blocks[index];
  requireThat(block, 'NOT_FOUND', '正文块不存在或已删除', 404);
  if (command.expected !== card.body.versionId)
    throw new DomainError('VERSION_CONFLICT', `卡片 ${card.id} 的正文已更新，请重新读取块 ${blockId}（当前版本 ${card.body.versionId}）`, 409, {
      cardId: card.id, blockId, expected: command.expected, current: card.body.versionId,
    });
  requireThat(
    plainParagraph(block) && typeof block.text === 'string' && !Object.hasOwn(block, 'inlineId'),
    'CONTENT_BLOCK_UNSUPPORTED', '此操作只支持没有行内身份或额外字段的纯文本段落', 409,
  );
  const original = block.text;
  requireThat(
    start <= end && end <= original.length &&
      !splitsSurrogate(original, start) && !splitsSurrogate(original, end),
    'CONTENT_RANGE_INVALID', '补丁区间越界、反向或切开了 UTF-16 代理对', 400,
  );
  const replacement = original.slice(0, start) + text + original.slice(end);
  if (replacement === original) return blocks;
  if (replacement.length > original.length)
    requireThat(
      bodyText(card.body).length - original.length + replacement.length <= MAX_BODY_TEXT_LENGTH,
      'CONTENT_TOO_LARGE', '正文文字不能超过200000', 400,
    );
  return blocks.with(index, { ...block, text: replacement });
}
