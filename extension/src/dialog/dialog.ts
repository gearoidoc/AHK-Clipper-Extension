// The capture dialog, running in an extension-origin iframe on the web page.
// The selected text arrives from the service worker, never via postMessage.
import { normalizeText, toHotstring, validateTrigger } from '../hotstring.ts';
import { SETTINGS_ERRORS, type DialogInit, type ErrorReply, type ExtensionMessage, type HostErrorCode, type SaveReply } from '../protocol.ts';

const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const card = byId<HTMLElement>('card');
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
const count = byId<HTMLSpanElement>('count');
const done = byId<HTMLParagraphElement>('done');

let ready = false;
let busy = false;
let showTriggerErrors = false;

const send = <T>(message: ExtensionMessage): Promise<T> => chrome.runtime.sendMessage(message);
const close = () => void send({ type: 'dialog.close' });

// Report the card's height so the iframe fits it.
new ResizeObserver(() => void send({ type: 'dialog.resize', height: card.getBoundingClientRect().height })).observe(card);

byId<HTMLButtonElement>('close').addEventListener('click', close);
openSettings.addEventListener('click', () => void send({ type: 'dialog.openSettings' }));
trigger.addEventListener('input', () => {
  showTriggerErrors = true;
  update();
});
text.addEventListener('input', update);
form.addEventListener('submit', (event) => {
  event.preventDefault();
  void submit();
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    event.preventDefault();
    close();
  } else if (event.key === 'Enter' && !event.isComposing && !event.shiftKey && !event.altKey) {
    // In the textarea Enter makes a new line and Ctrl+Enter saves; elsewhere Enter saves.
    if (event.target === text && !event.ctrlKey && !event.metaKey) return;
    if (event.target instanceof HTMLButtonElement && event.target !== save) return;
    event.preventDefault();
    void submit();
  }
});

// The page focuses the iframe once it loads; put the caret in the trigger then.
window.addEventListener('focus', () => {
  if (document.activeElement === document.body) trigger.focus();
});

void init();

async function init(): Promise<void> {
  const reply = await send<DialogInit>({ type: 'dialog.init' });
  text.value = reply.text;
  if (reply.ok) {
    file.replaceChildren(...reply.files.map((name) => new Option(name, name, name === reply.file, name === reply.file)));
    ready = true;
  } else {
    showError(reply.error.code, reply.error.message);
  }
  update();
  trigger.focus();
}

function update(): void {
  const normalized = normalizeText(text.value);
  const lines = normalized === '' ? 0 : normalized.split('\n').length;
  count.textContent = `${lines} ${lines === 1 ? 'line' : 'lines'}, ${normalized.length.toLocaleString('en')} ${normalized.length === 1 ? 'character' : 'characters'}`;

  const check = validateTrigger(trigger.value);
  const result = toHotstring(trigger.value, text.value);
  const triggerError = showTriggerErrors ? check.errors[0] : undefined;
  setHint(triggerHint, triggerError ?? check.warnings[0], triggerError ? 'error' : 'warning');
  const textError = result.ok ? undefined : result.errors.find((e) => !check.errors.includes(e));
  setHint(textHint, textError, 'error');
  save.disabled = !ready || busy;
}

async function submit(): Promise<void> {
  if (!ready || busy) return;
  showTriggerErrors = true;
  update();
  if (!toHotstring(trigger.value, text.value).ok) {
    (triggerHint.dataset.kind === 'error' ? trigger : text).focus();
    return;
  }
  busy = true;
  update();
  hideBanner();
  save.textContent = 'Saving…';
  const reply = await send<SaveReply | ErrorReply>({ type: 'dialog.save', trigger: trigger.value, text: text.value, file: file.value });
  busy = false;
  save.textContent = 'Save';
  if (reply.ok) {
    showDone(reply);
  } else {
    showError(reply.error.code, reply.error.message);
    update();
    trigger.focus();
  }
}

function showDone(reply: SaveReply): void {
  const savedTrigger = document.createElement('code');
  savedTrigger.textContent = trigger.value;
  const parts: (Node | string)[] = ['Saved ', savedTrigger, ` to ${reply.file}, reloaded.`];
  if (reply.includeAdded) parts.push(` ${reply.entry} now includes ${reply.file}.`);
  done.replaceChildren(...parts);
  form.hidden = true;
  done.hidden = false;
}

function showError(code: HostErrorCode, message: string): void {
  bannerText.textContent = message;
  openSettings.hidden = !SETTINGS_ERRORS.has(code);
  banner.hidden = false;
}

function hideBanner(): void {
  banner.hidden = true;
}

function setHint(hint: HTMLElement, message: string | undefined, kind: 'error' | 'warning'): void {
  hint.textContent = message ?? '';
  hint.dataset.kind = kind;
}
