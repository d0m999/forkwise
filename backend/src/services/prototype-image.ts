/** Old browser selections had no frame identity. Only proven single-frame files can retain a region. */
export function prototypeImageIsStatic(bytes: Buffer, mime: string): boolean {
  if (mime === 'image/jpeg') return true;
  if (mime === 'image/png') {
    for (let at = 8; at + 12 <= bytes.length; ) {
      const size = bytes.readUInt32BE(at),
        type = bytes.toString('ascii', at + 4, at + 8);
      if (at + size + 12 > bytes.length || type === 'acTL') return false;
      if (type === 'IEND') return true;
      at += size + 12;
    }
    return false;
  }
  if (mime === 'image/webp') {
    let at = 12;
    while (at + 8 <= bytes.length) {
      const type = bytes.toString('ascii', at, at + 4),
        size = bytes.readUInt32LE(at + 4);
      if (type === 'ANIM' || type === 'ANMF' || (type === 'VP8X' && size > 0 && bytes[at + 8]! & 2))
        return false;
      at += 8 + size + (size % 2);
    }
    return at === bytes.length;
  }
  if (mime !== 'image/gif' || bytes.length < 13) return false;
  let at = 13 + (bytes[10]! & 128 ? 3 * 2 ** ((bytes[10]! & 7) + 1) : 0),
    frames = 0;
  const skipBlocks = () => {
    while (at < bytes.length) {
      const size = bytes[at++]!;
      if (!size) return true;
      at += size;
    }
    return false;
  };
  while (at < bytes.length) {
    const marker = bytes[at++];
    if (marker === 0x3b) return frames === 1;
    if (marker === 0x21) {
      at++; // Extension label, followed by size-prefixed sub-blocks.
      if (!skipBlocks()) return false;
    } else if (marker === 0x2c) {
      if (++frames > 1 || at + 9 > bytes.length) return false;
      const packed = bytes[at + 8]!;
      at += 9 + (packed & 128 ? 3 * 2 ** ((packed & 7) + 1) : 0);
      at++; // LZW code size; the image payload also uses sub-blocks.
      if (!skipBlocks()) return false;
    } else return false;
  }
  return false;
}
