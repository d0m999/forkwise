import type { Block } from './contracts.js';

// A retained clipboard payload, not a media asset or an upload task. Keep the
// existing HTTP body limit; larger payloads must remain on the clipboard.
export const PENDING_IMAGE_MAX_BYTES = 512 * 1024;
export function validPendingImage(block: Block): boolean {
  const size = block.byteLength,
    data = block.base64;
  if (
    block.status !== 'unsupported' ||
    typeof block.name !== 'string' ||
    !block.name ||
    block.name.length > 4096 ||
    typeof block.mime !== 'string' ||
    !/^image\/[a-z0-9.+-]+$/i.test(block.mime) ||
    typeof size !== 'number' ||
    !Number.isInteger(size) ||
    size < 1 ||
    size > PENDING_IMAGE_MAX_BYTES ||
    typeof data !== 'string' ||
    data.length !== 4 * Math.ceil(size / 3) ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(data) ||
    !Object.keys(block).every((k) =>
      ['id', 'type', 'inlineId', 'name', 'mime', 'byteLength', 'base64', 'status'].includes(k),
    )
  )
    return false;
  const padding = (3 - (size % 3)) % 3;
  return data.length - data.replace(/=+$/, '').length === padding;
}
