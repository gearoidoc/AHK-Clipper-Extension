// The capture dialog, running in an extension-origin iframe on the web page.
// The selected text arrives from the service worker, never via postMessage.
import { createOptionChips } from '../chips.ts';
import { findConflicts } from '../conflicts.ts';
import { normalizeText, toHotstring, validateTrigger, type HotstringOptions } from '../hotstring.ts';
import { previewText } from '../preview.ts';
import {
  SETTINGS_ERRORS,
  type CreateFileReply,
  type DialogInit,
  type ErrorReply,
  type ExtensionMessage,
  type HostErrorCode,
  type SaveReply,
  type ScannedHotstring,
  type UndoReply,
} from '../protocol.ts';
import { pasteHint, suggestTrigger } from '../suggest.ts';

/** The "New file…" entry in the file list; `*` can't appear in a file name. */
const NEW_FILE = '*new*';
const ID_PLACEHOLDER = ' ; hsc:……';

const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const card = byId<HTMLElement>('card');
const editor = byId<HTMLElement>('editor');
const form = byId<HTMLFormElement>('form');
const trigger = byId<HTMLInputElement>('trigger');
const text = byId<HTMLTextAreaElement>('text');
const file = byId<HTMLSelectElement>('file');
const save = byId<HTMLButtonElement>('save');
const banner = byId<HTMLDivElement>('banner');
const bannerText = byId<HTMLParagraphElement>('banner-text');
const openSettings = byId<HTMLButtonElement>('open-settings');
const triggerHint = byId<HTMLParagraphElement>('trigger-hint');
const textHint = byId<HTMLParagraphElement>('text-hint');
const fileHint = byId<HTMLParagraphElement>('file-hint');
const count = byId<HTMLSpanElement>('count');
const conflict = byId<HTMLDivElement>('conflict');
const conflictText = byId<HTMLParagraphElement>('conflict-text');
const replaceButton = byId<HTMLButtonElement>('replace');
const renameButton = byId<HTMLButtonElement>('rename');
const newFile = byId<HTMLDivElement>('new-file');
const newFileName = byId<HTMLInputElement>('new-file-name');
const withComment = byId<HTMLInputElement>('with-comment');
const preview = byId<HTMLPreElement>('preview');
const toast = byId<HTMLElement>('toast');
const toastText = byId<HTMLParagraphElement>('toast-text');
const undoButton = byId<HTMLButtonElement>('undo');
const optionsBox = byId<HTMLFieldSetElement>('options');

const chips = createOptionChips(optionsBox, update);

let ready = false;
let busy = false;
let showTriggerErrors = false;
let showTextErrors = false;
let hotstrings: ScannedHotstring[] = [];
let duplicate: ScannedHotstring | null = null;
let pageUrl = '';
let comment = '';
let previousFile = '';

const send = <T>(message: ExtensionMessage): Promise<T> => chrome.runtime.sendMessage(message);
const close = () => void send({ type: 'dialog.close' });

// Report the card's height so the iframe fits it.
new ResizeObserver(() => void send({ type: 'dialog.resize', height: card.getBoundingClientRect().height })).observe(card);

byId<HTMLButtonElement>('close').addEventListener('click', close);
byId<HTMLButtonElement>('toast-close').addEventListener('click', close);
openSettings.addEventListener('click', () => void send({ type: 'dialog.openSettings' }));
trigger.addEventListener('input', () => {
  showTriggerErrors = true;
  update();
});
text.addEventListener('input', () => {
  showTextErrors = true;
  update();
});
withComment.addEventListener('change', update);
replaceButton.addEventListener('click', () => void submit(true));
renameButton.addEventListener('click', () => {
  trigger.focus();
  trigger.select();
});
undoButton.addEventListener('click', () => void undo());
file.addEventListener('change', () => {
  if (file.value === NEW_FILE) {
    newFile.hidden = false;
    setHint(fileHint, undefined, 'info');
    newFileName.focus();
  } else {
    previousFile = file.value;
    newFile.hidden = true;
  }
});
byId<HTMLButtonElement>('create-file').addEventListener('click', () => void createFile());
newFileName.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    event.stopPropagation();
    void createFile();
  } else if (event.key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    cancelNewFile();
  }
});
form.addEventListener('submit', (event) => {
  event.preventDefault();
  void submit(false);
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    event.preventDefault();
    close();
  } else if (event.key === 'Enter' && !event.isComposing && !event.shiftKey && !event.altKey && toast.hidden) {
    // In the textarea Enter makes a new line and Ctrl+Enter saves; buttons
    // keep their own Enter; elsewhere Enter saves.
    if (event.target === text && !event.ctrlKey && !event.metaKey) return;
    if (event.target instanceof HTMLButtonElement && event.target !== save) return;
    event.preventDefault();
    void submit(false);
  }
});

// The page focuses the iframe once it loads; put the caret in place then.
window.addEventListener('focus', () => {
  if (document.activeElement === document.body && toast.hidden) (text.value ? trigger : text).focus();
});

void init();

async function init(): Promise<void> {
  const reply = await send<DialogInit>({ type: 'dialog.init' });
  text.value = reply.text;
  if (reply.ok) {
    hotstrings = reply.hotstrings;
    pageUrl = reply.url;
    comment = reply.comment;
    renderFiles(reply.files, reply.file);
    chips.set(reply.options);
    withComment.checked = reply.withComment && comment !== '';
    withComment.disabled = comment === '';
    if (reply.suggest && reply.text) {
      trigger.value = suggestTrigger(reply.text, reply.triggerPrefix, hotstrings, reply.options.immediate);
    }
    ready = true;
  } else {
    showError(reply.error.code, reply.error.message);
  }
  update();
  if (text.value) {
    trigger.focus();
    trigger.select(); // Typing replaces the suggestion.
  } else {
    text.focus();
  }
}

function renderFiles(files: string[], selected: string): void {
  file.replaceChildren(
    ...files.map((name) => new Option(name, name, name === selected, name === selected)),
    new Option('New file…', NEW_FILE),
  );
  previousFile = selected;
}

function update(): void {
  const normalized = normalizeText(text.value);
  const lines = normalized === '' ? 0 : normalized.split('\n').length;
  count.textContent = `${lines} ${lines === 1 ? 'line' : 'lines'}, ${normalized.length.toLocaleString('en')} ${normalized.length === 1 ? 'character' : 'characters'}`;

  const options = chips.read();
  const check = validateTrigger(trigger.value);
  const result = toHotstring(trigger.value, text.value, options);
  const triggerError = showTriggerErrors ? check.errors[0] : undefined;
  setHint(triggerHint, triggerError ?? check.warnings[0], triggerError ? 'error' : 'warning');
  const textError = result.ok ? undefined : result.errors.find((e) => !check.errors.includes(e));
  if (!text.value && !showTextErrors) setHint(textHint, pasteHint(pageUrl), 'info');
  else setHint(textHint, textError, 'error');

  showConflicts(options);
  preview.textContent = result.ok ? [withComment.checked ? comment : '', result.line + ID_PLACEHOLDER].filter(Boolean).join('\n') : '';
  save.disabled = !ready || busy;
}

/** Duplicates need Replace or a new trigger; Instant prefix clashes are only warned about. */
function showConflicts(options: HotstringOptions): void {
  const { duplicate: found, shadows, shadowedBy } = findConflicts(trigger.value, options, hotstrings);
  duplicate = found;
  let message = '';
  if (found) {
    message = `${found.trigger} is already in ${found.file}: ${found.kind === 'code' ? '(runs code)' : previewText(found.text)}`;
  } else if (shadows.length > 0) {
    const first = shadows[0]!;
    message = `Instant ${trigger.value} would fire before ${first.trigger} (${first.file})${shadows.length > 1 ? ` and ${shadows.length - 1} more` : ''} could be typed.`;
  } else if (shadowedBy.length > 0) {
    const first = shadowedBy[0]!;
    message = `${first.trigger} (${first.file}) is Instant, so it fires before ${trigger.value} can be finished.`;
  }
  conflictText.textContent = message;
  conflict.hidden = message === '';
  conflict.dataset.kind = found ? 'duplicate' : 'warning';
  // A hotstring that runs code isn't swapped for text from a web page.
  replaceButton.hidden = !found || found.kind === 'code';
}

async function submit(replace: boolean): Promise<void> {
  if (!ready || busy) return;
  showTriggerErrors = showTextErrors = true;
  update();
  const options = chips.read();
  if (!toHotstring(trigger.value, text.value, options).ok) {
    (triggerHint.dataset.kind === 'error' ? trigger : text).focus();
    return;
  }
  if (file.value === NEW_FILE) {
    newFileName.focus();
    return;
  }
  // A duplicate is only saved through Replace.
  if (duplicate && !replace) {
    conflict.classList.remove('flash');
    void conflict.offsetWidth; // Restart the animation.
    conflict.classList.add('flash');
    trigger.focus();
    return;
  }
  const target = replace ? duplicate : null;
  busy = true;
  update();
  hideBanner();
  save.textContent = 'Saving…';
  const reply = await send<SaveReply | ErrorReply>({
    type: 'dialog.save',
    trigger: trigger.value,
    text: text.value,
    file: target ? target.file : file.value,
    options,
    withComment: withComment.checked,
    replace: target ? { file: target.file, line: target.line, hash: target.hash } : null,
  });
  busy = false;
  save.textContent = 'Save';
  if (reply.ok) {
    showToast(reply);
  } else {
    showError(reply.error.code, reply.error.message);
    update();
    trigger.focus();
  }
}

async function createFile(): Promise<void> {
  const name = newFileName.value.trim();
  if (!name) {
    setHint(fileHint, 'Enter a name for the new file.', 'error');
    newFileName.focus();
    return;
  }
  const reply = await send<CreateFileReply | ErrorReply>({ type: 'dialog.createFile', name });
  if (!reply.ok) {
    setHint(fileHint, reply.error.message, 'error');
    newFileName.focus();
    return;
  }
  const files = [...file.options].map((o) => o.value).filter((v) => v !== NEW_FILE);
  renderFiles([...files, reply.file].sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' })), reply.file);
  newFile.hidden = true;
  newFileName.value = '';
  setHint(fileHint, `Created ${reply.file}${reply.includeAdded ? '; the main script now includes it' : ''}.`, 'info');
  trigger.focus();
}

function cancelNewFile(): void {
  newFile.hidden = true;
  newFileName.value = '';
  file.value = previousFile;
  setHint(fileHint, undefined, 'info');
  file.focus();
}

function showToast(reply: SaveReply): void {
  const savedTrigger = document.createElement('code');
  savedTrigger.textContent = trigger.value;
  const parts: (Node | string)[] = ['Saved ', savedTrigger, ` to ${reply.file}, reloaded.`];
  if (reply.replaced) parts.push(' It replaced the old one.');
  if (reply.includeAdded) parts.push(` ${reply.entry} now includes ${reply.file}.`);
  toastText.replaceChildren(...parts);
  editor.hidden = true;
  toast.hidden = false;
}

async function undo(): Promise<void> {
  undoButton.disabled = true;
  undoButton.textContent = 'Undoing…';
  const reply = await send<UndoReply | ErrorReply>({ type: 'dialog.undo' });
  undoButton.hidden = true;
  toastText.textContent = !reply.ok
    ? reply.error.message
    : reply.exact
      ? `Undone. ${reply.file} is back as it was.`
      : `Undone. ${trigger.value} was removed from ${reply.file}; later changes to it were kept.`;
  toast.dataset.state = reply.ok ? 'ok' : 'error';
}

function showError(code: HostErrorCode, message: string): void {
  bannerText.textContent = message;
  openSettings.hidden = !SETTINGS_ERRORS.has(code);
  banner.hidden = false;
}

function hideBanner(): void {
  banner.hidden = true;
}

function setHint(hint: HTMLElement, message: string | undefined, kind: 'error' | 'warning' | 'info'): void {
  hint.textContent = message ?? '';
  hint.dataset.kind = kind;
}
