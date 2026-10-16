import { inflateSync } from 'node:zlib';
const check = (ok) => {
  if (!ok) throw new Error('invalid raster stream');
};
function crc(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let n = 0; n < 8; n++) value = value & 1 ? (value >>> 1) ^ 0xedb88320 : value >>> 1;
  }
  return (value ^ 0xffffffff) >>> 0;
}
function png(bytes) {
  let header,
    ended = false;
  const data = [];
  for (let at = 8; at + 12 <= bytes.length; ) {
    const size = bytes.readUInt32BE(at),
      type = bytes.toString('ascii', at + 4, at + 8);
    check(at + size + 12 <= bytes.length);
    check(crc(bytes.subarray(at + 4, at + 8 + size)) === bytes.readUInt32BE(at + 8 + size));
    if (type === 'IHDR') {
      check(!header && at === 8 && size === 13);
      header = bytes.subarray(at + 8, at + 21);
    }
    if (type === 'IDAT') data.push(bytes.subarray(at + 8, at + 8 + size));
    at += size + 12;
    if (type === 'IEND') {
      check(size === 0 && at === bytes.length);
      ended = true;
      break;
    }
  }
  check(header && ended && data.length);
  const w = header.readUInt32BE(0),
    h = header.readUInt32BE(4),
    depth = header[8],
    color = header[9],
    channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[color];
  check(
    w > 0 &&
      h > 0 &&
      w * h <= 40000000 &&
      channels &&
      header[10] === 0 &&
      header[11] === 0 &&
      header[12] <= 1,
  );
  check(
    { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] }[color].includes(
      depth,
    ),
  );
  const passes = header[12]
    ? [
        [0, 0, 8, 8],
        [4, 0, 8, 8],
        [0, 4, 4, 8],
        [2, 0, 4, 4],
        [0, 2, 2, 4],
        [1, 0, 2, 2],
        [0, 1, 1, 2],
      ]
    : [[0, 0, 1, 1]];
  const rows = passes.map(([x, y, dx, dy]) => {
    const pw = Math.max(0, Math.ceil((w - x) / dx)),
      ph = Math.max(0, Math.ceil((h - y) / dy));
    return { row: Math.ceil((pw * channels * depth) / 8), count: pw ? ph : 0 };
  });
  const expected = rows.reduce((n, p) => n + (p.row + 1) * p.count, 0);
  check(expected > 0 && expected <= 320040000);
  const decoded = inflateSync(Buffer.concat(data), { maxOutputLength: expected });
  check(decoded.length === expected);
  let at = 0;
  for (const pass of rows)
    for (let n = 0; n < pass.count; n++) {
      check(decoded[at] <= 4);
      at += pass.row + 1;
    }
}
function gif(bytes) {
  check(bytes.length >= 14);
  const sw = bytes.readUInt16LE(6),
    sh = bytes.readUInt16LE(8);
  check(sw > 0 && sh > 0 && sw * sh <= 40000000);
  let at = 13 + (bytes[10] & 128 ? 3 * 2 ** ((bytes[10] & 7) + 1) : 0),
    frames = 0,
    pixels = 0;
  const subblocks = () => {
    const parts = [];
    while (at < bytes.length) {
      const n = bytes[at++];
      if (!n) return Buffer.concat(parts);
      check(at + n <= bytes.length);
      parts.push(bytes.subarray(at, at + n));
      at += n;
    }
    throw new Error('missing GIF subblock terminator');
  };
  while (at < bytes.length) {
    const marker = bytes[at++];
    if (marker === 0x3b) {
      check(frames > 0 && at === bytes.length);
      return;
    }
    if (marker === 0x21) {
      check(at < bytes.length);
      at++;
      subblocks();
      continue;
    }
    check(marker === 0x2c && at + 9 <= bytes.length);
    const w = bytes.readUInt16LE(at + 4),
      h = bytes.readUInt16LE(at + 6),
      packed = bytes[at + 8];
    at += 9;
    check(w > 0 && h > 0);
    pixels += w * h;
    check(pixels <= 40000000);
    frames++;
    if (packed & 128) at += 3 * 2 ** ((packed & 7) + 1);
    check(at < bytes.length);
    const minimum = bytes[at++];
    check(minimum >= 2 && minimum <= 8);
    const data = subblocks();
    const clear = 1 << minimum,
      end = clear + 1,
      lengths = new Uint32Array(4096);
    for (let n = 0; n < clear; n++) lengths[n] = 1;
    let bits = minimum + 1,
      next = end + 1,
      previous = -1,
      offset = 0,
      count = 0,
      finished = false,
      cleared = false;
    while (offset + bits <= data.length * 8) {
      let code = 0;
      for (let bit = 0; bit < bits; bit++)
        code |= ((data[(offset + bit) >> 3] >> ((offset + bit) & 7)) & 1) << bit;
      offset += bits;
      if (code === clear) {
        bits = minimum + 1;
        next = end + 1;
        previous = -1;
        cleared = true;
        continue;
      }
      check(cleared);
      if (code === end) {
        finished = true;
        break;
      }
      check(code < next || (code === next && previous >= 0));
      const length = code === next ? lengths[previous] + 1 : lengths[code];
      check(length > 0);
      count += length;
      check(count <= w * h);
      if (previous >= 0 && next < 4096) {
        lengths[next++] = lengths[previous] + 1;
        if (next === 1 << bits && bits < 12) bits++;
      }
      previous = code;
    }
    check(finished && count === w * h);
  }
  throw new Error('missing GIF trailer');
}
export function validateRaster(bytes) {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) png(bytes);
  else if (bytes[0] === 255 && bytes[1] === 216) jpeg(bytes);
  else if (/^GIF8[79]a$/.test(bytes.subarray(0, 6).toString('ascii'))) gif(bytes);
}

function jpeg(bytes) {
  check(bytes[0] === 255 && bytes[1] === 216);
  let at = 2,
    frame = false,
    scan = false;
  const frames = new Set([
    0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
  ]);
  while (at < bytes.length) {
    check(bytes[at++] === 255);
    while (bytes[at] === 255) at++;
    const marker = bytes[at++];
    if (marker === 0xd9) {
      check(frame && scan && at === bytes.length);
      return;
    }
    check(
      marker !== 0xd8 &&
        marker !== 0 &&
        marker !== 1 &&
        !(marker >= 0xd0 && marker <= 0xd7) &&
        at + 2 <= bytes.length,
    );
    const size = bytes.readUInt16BE(at);
    check(size >= 2 && at + size <= bytes.length);
    if (frames.has(marker)) {
      check(!frame && size >= 8);
      const components = bytes[at + 7];
      check(components > 0 && components <= 4 && size === 8 + 3 * components);
      frame = true;
    }
    if (marker !== 0xda) {
      at += size;
      continue;
    }
    check(frame && size >= 6 && size === 6 + 2 * bytes[at + 2]);
    at += size;
    let encoded = 0;
    while (at < bytes.length) {
      if (bytes[at] !== 255) {
        encoded++;
        at++;
        continue;
      }
      let next = at + 1;
      while (bytes[next] === 255) next++;
      check(next < bytes.length);
      if (bytes[next] === 0) {
        encoded++;
        at = next + 1;
        continue;
      }
      if (bytes[next] >= 0xd0 && bytes[next] <= 0xd7) {
        at = next + 1;
        continue;
      }
      break;
    }
    check(encoded > 0);
    scan = true;
  }
  throw new Error('incomplete JPEG codestream');
}
