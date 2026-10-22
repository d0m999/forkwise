import type { ClipboardEvent } from 'react';

export function canvasPasteAllowed(event: ClipboardEvent<HTMLElement>): boolean {
  const editing = (element: EventTarget | null) => element instanceof Element &&
    (!!element.closest('input, textarea') || element instanceof HTMLElement && element.isContentEditable);
  return !event.defaultPrevented && !editing(event.target) && !editing(document.activeElement);
}
export function canvasPlainText(event: ClipboardEvent<HTMLElement>): string | null {
  if (!canvasPasteAllowed(event)) return null;
  if (event.clipboardData.files.length || event.clipboardData.types.includes('text/html')) return null;
  const text = event.clipboardData.getData('text/plain');
  return text || null;
}
