// Service worker: opens the capture dialog, and is the only part of the
// extension that talks to the native host.
import { captureSelection, type Capture } from './capture.ts';
import { isoDate, sourceComment, toHotstring, toOptions, type HotstringOptions } from './hotstring.ts';
import { sendToHost } from './native.ts';
import type {
  CreateFileReply,
  DialogInit,
  ErrorReply,
  ExtensionMessage,
  FrameMessage,
  ReplaceTarget,
  SaveReply,
  SetupFolderReply,
  UndoReply,
  UndoToken,
} from './protocol.ts';
import { getSettings, reloadScript, updateSettings } from './settings.ts';

declare const __E2E__: boolean;

const MENU_ID = 'add-hotstring';
const COMMAND = 'open-dialog';
const FIRST_CATEGORY = 'General.ahk';
const captureKey = (tabId: number) => `capture:${tabId}`;
const undoKey = (tabId: number) => `undo:${tabId}`;

chrome.runtime.onInstalled.addListener(({ reason }) => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: MENU_ID, title: 'Add as AHK hotstring', contexts: ['selection'] });
  });
  if (reason === chrome.runtime.OnInstalledReason.INSTALL) void chrome.runtime.openOptionsPage();
});

chrome.commands.onCommand.addListener((command, tab) => {
  if (command === COMMAND && tab?.id !== undefined) void openDialog(tab.id);
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === MENU_ID && tab?.id !== undefined) void openDialog(tab.id, info.selectionText ?? '');
});

chrome.tabs.onRemoved.addListener((tabId) => void chrome.storage.session.remove([captureKey(tabId), undoKey(tabId)]));

chrome.runtime.onMessage.addListener((message: ExtensionMessage, sender, sendResponse) => {
  // Only this extension's own pages (Settings and the dialog frame) may send
  // these. Content scripts send from the web page's URL.
  if (sender.id !== chrome.runtime.id || !sender.url?.startsWith('chrome-extension://')) return false;
  const reply = route(message, sender.tab?.id);
  if (!reply) return false;
  void reply.then(sendResponse);
  return true; // Reply asynchronously.
});

function route(message: ExtensionMessage, tabId: number | undefined): Promise<unknown> | undefined {
  switch (message?.type) {
    case 'host.ping':
      return sendToHost({ type: 'ping', echo: String(message.echo) });
    case 'settings.listFiles':
      return sendToHost({ type: 'listFiles', folder: String(message.folder) });
    case 'settings.setupFolder':
      return setupFolder(String(message.folder));
  }
  // The rest come from the dialog frame, which lives in a tab.
  if (tabId === undefined) return undefined;
  switch (message?.type) {
    case 'dialog.init':
      return initDialog(tabId);
    case 'dialog.save':
      return save(tabId, {
        trigger: String(message.trigger),
        text: String(message.text),
        file: String(message.file),
        options: toOptions(message.options),
        withComment: message.withComment === true,
        replace: toReplaceTarget(message.replace),
      });
    case 'dialog.undo':
      return undo(tabId);
    case 'dialog.createFile':
      return createCategory(String(message.name));
    case 'dialog.resize':
      return sendToFrame(tabId, { type: 'frame.resize', height: Number(message.height) });
    case 'dialog.close':
      return closeDialog(tabId);
    case 'dialog.openSettings':
      return chrome.runtime.openOptionsPage().then(() => closeDialog(tabId));
  }
  return undefined;
}

/**
 * Captures the selection in the tab's top frame and shows the dialog next to
 * it. `fallbackText`, the context menu's copy of the selection, covers text
 * selected inside an iframe, which v1 doesn't inject into.
 */
async function openDialog(tabId: number, fallbackText = ''): Promise<void> {
  try {
    const [frame] = await chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, func: captureSelection });
    let capture: Capture = frame?.result ?? { text: '', title: '', url: '', rect: null };
    if (!capture.text.trim()) capture = { ...capture, text: fallbackText };
    // storage.session is in memory and can't be read by content scripts.
    await chrome.storage.session.set({ [captureKey(tabId)]: capture });
    await chrome.storage.session.remove(undoKey(tabId));
    await chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, files: ['dialog-host.js'] });
    await sendToFrame(tabId, { type: 'frame.open', rect: capture.rect });
  } catch (e) {
    // chrome:// pages, the Chrome Web Store and the PDF viewer don't allow scripts.
    console.warn(`Can't show the hotstring dialog on this page: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function getCapture(tabId: number): Promise<Capture | undefined> {
  return (await chrome.storage.session.get(captureKey(tabId)))[captureKey(tabId)] as Capture | undefined;
}

/** The source comment for a capture, or '' when there's no page to name. */
function commentFor(capture: Capture | undefined): string {
  return capture?.url ? sourceComment({ title: capture.title, url: capture.url, date: isoDate(new Date()) }) : '';
}

async function initDialog(tabId: number): Promise<DialogInit> {
  const capture = await getCapture(tabId);
  const text = (capture?.text ?? '').trim();
  const settings = await getSettings();
  const scan = await sendToHost({ type: 'scan', folder: settings.folder });
  if (!scan.ok) return { ...scan, text };
  const main = settings.mainScript.toLowerCase();
  const files = settings.reloadMode === 'main' ? scan.files.filter((f) => f.toLowerCase() !== main) : scan.files;
  if (files.length === 0) {
    const message = settings.reloadMode === 'main'
      ? `There are no category files in ${scan.folder} yet. Use Set up this folder in Settings.`
      : `There are no .ahk files in ${scan.folder} yet.`;
    return { ok: false, error: { code: 'no_files', message }, text };
  }
  return {
    ok: true,
    text,
    url: capture?.url ?? '',
    files,
    file: files.includes(settings.lastFile) ? settings.lastFile : files[0]!,
    hotstrings: scan.hotstrings,
    options: settings.defaultOptions,
    triggerPrefix: settings.triggerPrefix,
    suggest: settings.suggest,
    comment: commentFor(capture),
    withComment: settings.sourceComment,
  };
}

interface SaveInput {
  trigger: string;
  text: string;
  file: string;
  options: HotstringOptions;
  withComment: boolean;
  replace: ReplaceTarget | null;
}

async function save(tabId: number, input: SaveInput): Promise<SaveReply | ErrorReply> {
  const result = toHotstring(input.trigger, input.text, input.options);
  if (!result.ok) return { ok: false, error: { code: 'invalid', message: result.errors.join(' ') } };
  const settings = await getSettings();
  const reply = await sendToHost({
    type: 'save',
    folder: settings.folder,
    ahkPath: settings.ahkPath,
    file: input.file,
    line: result.line,
    comment: input.withComment ? commentFor(await getCapture(tabId)) : '',
    reload: reloadScript(settings),
    replace: input.replace,
  });
  if (reply.ok) {
    await updateSettings({ lastFile: reply.file });
    await chrome.storage.session.set({ [undoKey(tabId)]: reply.undo });
    await sendToFrame(tabId, { type: 'frame.toast' });
  }
  return reply;
}

/** Undoes the save the toast in this tab is showing. */
async function undo(tabId: number): Promise<UndoReply | ErrorReply> {
  const token = (await chrome.storage.session.get(undoKey(tabId)))[undoKey(tabId)] as UndoToken | undefined;
  await chrome.storage.session.remove(undoKey(tabId));
  const settings = await getSettings();
  const reply: UndoReply | ErrorReply = token
    ? await sendToHost({ type: 'undo', folder: settings.folder, ahkPath: settings.ahkPath, reload: reloadScript(settings), ...token })
    : { ok: false, error: { code: 'invalid', message: 'There is nothing to undo.' } };
  await sendToFrame(tabId, { type: 'frame.toastDone' });
  return reply;
}

/** New file… in the dialog: a category, included by the main script when there is one. */
async function createCategory(name: string): Promise<CreateFileReply | ErrorReply> {
  const settings = await getSettings();
  const file = /\.ahk$/i.test(name.trim()) ? name.trim() : `${name.trim()}.ahk`;
  return sendToHost({
    type: 'createFile',
    folder: settings.folder,
    name: file,
    kind: 'category',
    includeIn: settings.reloadMode === 'main' ? settings.mainScript : '',
  });
}

async function closeDialog(tabId: number): Promise<{ ok: true }> {
  await chrome.storage.session.remove([captureKey(tabId), undoKey(tabId)]);
  await sendToFrame(tabId, { type: 'frame.close' });
  return { ok: true };
}

/** Creates the main script and a first category that it #Includes. */
async function setupFolder(folder: string): Promise<SetupFolderReply | ErrorReply> {
  const settings = await getSettings();
  const main = await sendToHost({ type: 'createFile', folder, name: settings.mainScript, kind: 'main', includeIn: '' });
  if (!main.ok) return main;
  const category = await sendToHost({ type: 'createFile', folder, name: FIRST_CATEGORY, kind: 'category', includeIn: main.file });
  // An existing General.ahk is fine: its #Include is added on the first save to it.
  if (!category.ok && category.error.code !== 'file_exists') return category;
  await updateSettings({ reloadMode: 'main' });
  return { ok: true, created: category.ok ? [main.file, category.file] : [main.file] };
}

function toReplaceTarget(value: unknown): ReplaceTarget | null {
  if (typeof value !== 'object' || value === null) return null;
  const { file, line, hash } = value as Record<string, unknown>;
  return typeof file === 'string' && typeof line === 'number' && typeof hash === 'string' ? { file, line, hash } : null;
}

/** Sends to the dialog host in the tab's top frame; a closed tab is not an error. */
async function sendToFrame(tabId: number, message: FrameMessage): Promise<void> {
  try {
    await chrome.tabs.sendMessage(tabId, message, { frameId: 0 });
  } catch {
    // The tab navigated away or closed.
  }
}

if (__E2E__) {
  // Tests can't press browser shortcuts, so the e2e build exposes the same entry point.
  (globalThis as { __ahkClipperTest?: unknown }).__ahkClipperTest = { openDialog };
}
