// Owned synthetic 80x60 GIF: two complete, opaque red/green frames, 120 ms each.
// A clear before each pixel keeps the LZW dictionary at its initial code size.
export function twoFrameGif(): Buffer {
  const word = (n: number) => [n & 255, n >> 8];
  const bytes = [
    ...Buffer.from("GIF89a"),
    ...word(80),
    ...word(60),
    0x80,
    0,
    0,
    255,
    0,
    0,
    0,
    255,
    0,
    0x21,
    0xff,
    11,
    ...Buffer.from("NETSCAPE2.0"),
    3,
    1,
    0,
    0,
    0,
  ];
  for (const color of [0, 1]) {
    bytes.push(
      0x21,
      0xf9,
      4,
      4,
      12,
      0,
      0,
      0,
      0x2c,
      0,
      0,
      0,
      0,
      ...word(80),
      ...word(60),
      0,
      2,
    );
    const codes = Array.from({ length: 80 * 60 }, () => [4, color]).flat();
    codes.push(5);
    let bits = 0,
      count = 0;
    const data: number[] = [];
    for (const code of codes) {
      bits |= code << count;
      count += 3;
      while (count >= 8) {
        data.push(bits & 255);
        bits >>= 8;
        count -= 8;
      }
    }
    if (count) data.push(bits & 255);
    for (let i = 0; i < data.length; i += 255)
      bytes.push(Math.min(255, data.length - i), ...data.slice(i, i + 255));
    bytes.push(0);
  }
  bytes.push(0x3b);
  return Buffer.from(bytes);
}
