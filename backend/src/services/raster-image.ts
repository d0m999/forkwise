import { Image, createCanvas } from '@napi-rs/canvas';
import { requireThat } from '../domain/errors.js';

/** Inspect local raster metadata. Await image.decode() before drawing pixels. SVG, remote URLs and filesystem paths are never accepted. */
export function rasterImage(bytes: Buffer, mime: string) {
  const valid =
    mime === 'image/png'
      ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      : mime === 'image/jpeg'
        ? bytes[0] === 255 && bytes[1] === 216
        : mime === 'image/gif'
          ? /^GIF8[79]a$/.test(bytes.subarray(0, 6).toString('ascii'))
          : mime === 'image/webp' &&
            bytes.subarray(0, 4).toString() === 'RIFF' &&
            bytes.subarray(8, 12).toString() === 'WEBP';
  requireThat(valid && bytes.length <= 25_000_000, 'INVALID_IMAGE', '原图格式或大小无效');
  const image = new Image();
  image.onerror = () => {};
  try {
    image.src = bytes;
  } catch {
    /* Validate decoded dimensions below. */
  }
  const width = image.naturalWidth,
    height = image.naturalHeight;
  requireThat(
    image.complete && width > 0 && height > 0 && width * height <= 40_000_000,
    'INVALID_IMAGE',
    '原图无法读取或超过 4000 万像素',
  );
  return { image, width, height };
}
export async function rasterPreview(bytes: Buffer, mime: string) {
  const { image, width, height } = rasterImage(bytes, mime);
  try {
    await image.decode();
  } catch {
    requireThat(false, 'INVALID_IMAGE', '原图像素无法解码');
  }
  const canvas = createCanvas(width, height);
  canvas.getContext('2d').drawImage(image, 0, 0);
  return {
    base64: canvas.toBuffer('image/png').toString('base64'),
    mime: 'image/png' as const,
    width,
    height,
    pageCount: 1,
  };
}
