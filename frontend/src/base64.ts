// 二进制转 base64：分块拼接，避免一次展开超长参数列表。
export function bytesToBase64(bytes: Uint8Array): string {
  let raw = '';
  for (let at = 0; at < bytes.length; at += 8192) raw += String.fromCharCode(...bytes.subarray(at, at + 8192));
  return btoa(raw);
}
