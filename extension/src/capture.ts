import type { Rect } from './protocol.ts';

export interface Capture {
  text: string;
  title: string;
  url: string;
  rect: Rect | null;
}

/**
 * Runs in the page (via chrome.scripting.executeScript, so it must be
 * self-contained) and returns the selected text and where it is. Text selected
 * inside an input or textarea isn't part of window.getSelection().
 */
export function captureSelection(): Capture {
  const toRect = (r: DOMRect): Rect => ({ top: r.top, left: r.left, bottom: r.bottom, right: r.right });
  const active = document.activeElement;
  let text = '';
  let rect: Rect | null = null;
  if (active instanceof HTMLTextAreaElement || active instanceof HTMLInputElement) {
    const { selectionStart: start, selectionEnd: end } = active;
    if (start !== null && end !== null && end > start) {
      text = active.value.slice(start, end);
      rect = toRect(active.getBoundingClientRect());
    }
  }
  if (!text) {
    const selection = window.getSelection();
    if (selection && selection.rangeCount > 0 && !selection.isCollapsed) {
      text = selection.toString();
      const r = selection.getRangeAt(0).getBoundingClientRect();
      if (r.width > 0 || r.height > 0) rect = toRect(r);
    }
  }
  return { text, title: document.title, url: location.href, rect };
}
