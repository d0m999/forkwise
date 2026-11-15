export function exportFilename(projectName: string, revision: number, extension: 'md' | 'png'): string {
  const safe = projectName.replace(/[\\/:*?"<>|]/g, '-').trim().slice(0, 80) || '见岔项目';
  return `${safe}-r${revision}.${extension}`;
}

export function downloadBlob(blob: Blob, filename: string): void {
  const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.style.display = 'none';
  document.body.append(anchor);
  try {
    anchor.click();
  } catch (error) {
    URL.revokeObjectURL(url);
    throw error;
  } finally {
    anchor.remove();
    previousFocus?.focus({ preventScroll: true });
  }
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
