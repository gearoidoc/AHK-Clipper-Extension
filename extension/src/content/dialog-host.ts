// Content script, injected on demand into the top frame. It shows the dialog
// as an extension-origin iframe, so the page can neither style it nor read
// what's typed into it, and gives focus back to the page afterwards. It only
// takes orders from the service worker; the page can't message it.
import { placeDialog } from '../position.ts';
import type { FrameMessage, Rect } from '../protocol.ts';

declare const __E2E__: boolean;

const WIDTH = 360;
// About the dialog's usual height, so it barely moves when it reports its real one.
const INITIAL_HEIGHT = 440;
// How long the toast with Undo stays up (the e2e test doesn't wait 10 s).
const TOAST_MS = __E2E__ ? 3000 : 10_000;
// How long the toast stays after Undo has run.
const DONE_MS = 2000;
const CORNER_MARGIN = 16;

interface PageFocus {
  element: Element | null;
  range: Range | null;
  input: { start: number; end: number; direction: 'forward' | 'backward' | 'none' } | null;
}

declare global {
  interface Window {
    ahkClipperDialogHost?: boolean;
  }
}

// executeScript runs this file again for every dialog; only the first run sets up.
if (!window.ahkClipperDialogHost) {
  window.ahkClipperDialogHost = true;

  let frame: HTMLIFrameElement | null = null;
  let anchor: Rect | null = null;
  let height = INITIAL_HEIGHT;
  let pageFocus: PageFocus | null = null;
  let toast = false;
  let closeTimer: number | undefined;
  let closeAt = 0;

  chrome.runtime.onMessage.addListener((message: FrameMessage, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id || sender.tab) return false;
    switch (message.type) {
      case 'frame.open':
        open(message.rect);
        break;
      case 'frame.resize':
        height = Math.max(40, Math.min(Math.ceil(message.height), window.innerHeight - 24));
        place();
        break;
      case 'frame.close':
        close();
        break;
      case 'frame.toast':
        restoreFocus();
        toast = true;
        place();
        closeIn(TOAST_MS);
        break;
      case 'frame.toastDone':
        closeIn(DONE_MS);
        break;
    }
    sendResponse(true);
    return false;
  });

  function open(rect: Rect | null): void {
    // Opening again while the dialog is up keeps the page focus from the first time.
    const earlierFocus = frame ? pageFocus : null;
    removeFrame();
    pageFocus = earlierFocus ?? rememberFocus();
    anchor = rect;
    height = INITIAL_HEIGHT;
    toast = false;
    frame = document.createElement('iframe');
    frame.src = chrome.runtime.getURL('dialog.html');
    frame.title = 'Add AHK hotstring';
    // CSSOM only, which a page's style-src can't block; !important beats page styles.
    const style: [string, string][] = [
      ['all', 'initial'],
      ['position', 'fixed'],
      ['z-index', '2147483647'],
      ['display', 'block'],
      ['visibility', 'visible'],
      ['opacity', '1'],
      ['width', `${WIDTH}px`],
      ['border', 'none'],
      ['border-radius', '10px'],
      ['box-shadow', '0 8px 32px rgba(0, 0, 0, 0.28)'],
      ['color-scheme', 'light dark'],
    ];
    for (const [name, value] of style) frame.style.setProperty(name, value, 'important');
    place();
    const opened = frame;
    opened.addEventListener('load', () => opened.focus(), { once: true });
    // The toast waits while the pointer is over it, so Undo can't vanish under it.
    opened.addEventListener('mouseenter', () => {
      if (closeTimer !== undefined) {
        window.clearTimeout(closeTimer);
        closeTimer = undefined;
      }
    });
    opened.addEventListener('mouseleave', () => {
      if (toast && closeAt) closeIn(Math.max(closeAt - Date.now(), 1500));
    });
    document.documentElement.append(opened);
    window.addEventListener('resize', place);
  }

  function place(): void {
    if (!frame) return;
    const { top, left } = toast
      ? { top: window.innerHeight - height - CORNER_MARGIN, left: window.innerWidth - WIDTH - CORNER_MARGIN }
      : placeDialog(anchor, { width: window.innerWidth, height: window.innerHeight }, { width: WIDTH, height });
    frame.style.setProperty('top', `${top}px`, 'important');
    frame.style.setProperty('left', `${left}px`, 'important');
    frame.style.setProperty('height', `${height}px`, 'important');
  }

  function close(): void {
    // Only move focus if it's still in the dialog; after a save it was already given back.
    const focusWasInDialog = frame !== null && document.activeElement === frame;
    removeFrame();
    if (focusWasInDialog) restoreFocus();
    pageFocus = null;
  }

  function closeIn(ms: number): void {
    window.clearTimeout(closeTimer);
    closeAt = Date.now() + ms;
    closeTimer = window.setTimeout(close, ms);
  }

  function removeFrame(): void {
    window.clearTimeout(closeTimer);
    closeTimer = undefined;
    closeAt = 0;
    window.removeEventListener('resize', place);
    frame?.remove();
    frame = null;
  }

  function rememberFocus(): PageFocus {
    const element = document.activeElement;
    const selection = window.getSelection();
    const range = selection && selection.rangeCount > 0 ? selection.getRangeAt(0).cloneRange() : null;
    let input: PageFocus['input'] = null;
    if ((element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) && element.selectionStart !== null && element.selectionEnd !== null) {
      input = { start: element.selectionStart, end: element.selectionEnd, direction: element.selectionDirection ?? 'none' };
    }
    return { element, range, input };
  }

  function restoreFocus(): void {
    frame?.blur();
    if (!pageFocus) return;
    // Kept until close(): after Undo is clicked, focus comes back once more.
    const { element, range, input } = pageFocus;
    if (element instanceof HTMLElement && element.isConnected && element !== document.body) {
      element.focus({ preventScroll: true });
    }
    if (input && (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)) {
      element.setSelectionRange(input.start, input.end, input.direction);
    } else if (range) {
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    }
  }
}
