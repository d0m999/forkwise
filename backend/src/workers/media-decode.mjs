import { validateRaster } from './raster-integrity.mjs';
import { loadImage, createCanvas } from '@napi-rs/canvas';
const chunks = [];
for await (const part of process.stdin) chunks.push(part);
try {
  // loadImage waits for onload and only then awaits bitmap decode. Calling
  // Image.decode immediately after assigning src can race lazy native decoding.
  const bytes = Buffer.concat(chunks);
  validateRaster(bytes);
  const image = await loadImage(bytes);
  const width = image.naturalWidth,
    height = image.naturalHeight;
  if (!width || !height || width * height > 40_000_000) throw new Error('dimensions');
  const canvas = createCanvas(width, height);
  canvas.getContext('2d').drawImage(image, 0, 0);
  // Force pixel materialization before acknowledging durable asset eligibility.
  canvas.getContext('2d').getImageData(0, 0, 1, 1);
  process.stdout.write(JSON.stringify({ width, height }));
} catch {
  process.stderr.write('MEDIA_DECODE_FAILED');
  process.exitCode = 1;
}
