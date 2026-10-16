import type { Block } from './contracts.js';
import { validPendingImage } from './pending-image.js';
export function validImageTask(block: Block): boolean {
  const { ticket, width, height, status, reason, ...original } = block;
  return (
    block.type === 'imageTask' &&
    typeof ticket === 'string' &&
    ticket.length > 0 &&
    ticket.length <= 160 &&
    typeof width === 'number' &&
    Number.isFinite(width) &&
    width > 0 &&
    width <= 40000000 &&
    typeof height === 'number' &&
    Number.isFinite(height) &&
    height > 0 &&
    height <= 40000000 &&
    (status === 'queued' || status === 'failed') &&
    (reason === undefined || (typeof reason === 'string' && reason.length <= 2000)) &&
    typeof original.mime === 'string' &&
    original.mime.length > 0 &&
    original.mime.length <= 100 &&
    validPendingImage({
      ...original,
      type: 'pendingImage',
      mime: 'image/octet-stream',
      status: 'unsupported',
    })
  );
}
export function validImage(block: Block): boolean {
  return (
    block.type === 'image' &&
    typeof block.assetId === 'string' &&
    block.assetId.length > 0 &&
    block.assetId.length <= 160 &&
    typeof block.name === 'string' &&
    block.name.length > 0 &&
    block.name.length <= 4096 &&
    typeof block.mime === 'string' &&
    typeof block.naturalWidth === 'number' &&
    Number.isFinite(block.naturalWidth) &&
    block.naturalWidth > 0 &&
    typeof block.naturalHeight === 'number' &&
    Number.isFinite(block.naturalHeight) &&
    block.naturalHeight > 0 &&
    (block.width === undefined ||
      (typeof block.width === 'number' && Number.isFinite(block.width) && block.width > 0)) &&
    (block.caption === undefined || typeof block.caption === 'string') &&
    (block.alt === undefined || typeof block.alt === 'string') &&
    (block.request === undefined ||
      (!!block.request &&
        typeof block.request === 'object' &&
        validImageTask(block.request as Block))) &&
    Object.keys(block).every((k) =>
      [
        'id',
        'type',
        'inlineId',
        'assetId',
        'name',
        'mime',
        'naturalWidth',
        'naturalHeight',
        'width',
        'caption',
        'alt',
        'request',
      ].includes(k),
    )
  );
}
export function imageTask(block: Block): Block | undefined {
  return block.type === 'imageTask' && validImageTask(block)
    ? block
    : validImage(block) && block.request
      ? (block.request as Block)
      : undefined;
}
