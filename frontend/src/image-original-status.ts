export function imageOriginalError(status: number) {
  if (status === 404) return '图片原件缺失';
  if (status === 422) return '图片原件字节损坏';
}

export async function readImageOriginalError(url: string) {
  try {
    const response = await fetch(url, { method: 'HEAD', credentials: 'same-origin' });
    return imageOriginalError(response.status);
  } catch {
    return undefined;
  }
}
