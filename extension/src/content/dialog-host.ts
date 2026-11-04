// Content script, injected on demand into the top frame. It shows the dialog
// as an extension-origin iframe, so the page can neither style it nor read
// what's typed into it, and gives focus back to the page afterwards. It only
// takes orders from the service worker; the page can't message it.
import { placeDialog } from '../position.ts';
import type { FrameMessage, Rect } from '../protocol.ts';

const WIDTH = 360;
const INITIAL_HEIGHT = 330;
const SAVED_CLOSE_DELAY = 2500;

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
  let closeTimer: number | undefined;

  chrome.runtime.onMessage.addListener((message: FrameMessage, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id || sender.tab) return false;
    switch (message.type) {
      case 'frame.open':
        open(message.rect);
        break;
      case 'frame.resize':
        height = Math.max(80, Math.min(Math.ceil(message.height), window.innerHeight - 24));
        place();
        break;
      case 'frame.close':
        close();
        break;
      case 'frame.saved':
        restoreFocus();
        closeTimer = window.setTimeout(close, SAVED_CLOSE_DELAY);
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
    document.documentElement.append(opened);
    window.addEventListener('resize', place);
  }

  function place(): void {
    if (!frame) return;
    const { top, left } = placeDialog(anchor, { width: window.innerWidth, height: window.innerHeight }, { width: WIDTH, height });
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

  function removeFrame(): void {
    window.clearTimeout(closeTimer);
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
    const { element, range, input } = pageFocus;
    pageFocus = null;
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
