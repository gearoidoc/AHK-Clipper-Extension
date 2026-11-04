// Service worker: opens the capture dialog, and is the only part of the
// extension that talks to the native host.
import { captureSelection, type Capture } from './capture.ts';
import { toHotstring, toOptions, type HotstringOptions } from './hotstring.ts';
import { sendToHost } from './native.ts';
import type { DialogInit, ErrorReply, ExtensionMessage, FrameMessage, SaveReply, SetupFolderReply } from './protocol.ts';
import { getSettings, reloadScript, updateSettings } from './settings.ts';

declare const __E2E__: boolean;

const MENU_ID = 'add-hotstring';
const COMMAND = 'open-dialog';
const FIRST_CATEGORY = 'General.ahk';
const captureKey = (tabId: number) => `capture:${tabId}`;

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

chrome.tabs.onRemoved.addListener((tabId) => void chrome.storage.session.remove(captureKey(tabId)));

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
      return save(tabId, String(message.trigger), String(message.text), String(message.file), toOptions(message.options));
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
    await chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, files: ['dialog-host.js'] });
    await sendToFrame(tabId, { type: 'frame.open', rect: capture.rect });
  } catch (e) {
    // chrome:// pages, the Chrome Web Store and the PDF viewer don't allow scripts.
    console.warn(`Can't show the hotstring dialog on this page: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function initDialog(tabId: number): Promise<DialogInit> {
  const stored = await chrome.storage.session.get(captureKey(tabId));
  const text = ((stored[captureKey(tabId)] as Capture | undefined)?.text ?? '').trim();
  const settings = await getSettings();
  const list = await sendToHost({ type: 'listFiles', folder: settings.folder });
  if (!list.ok) return { ...list, text };
  const main = settings.mainScript.toLowerCase();
  const files = settings.reloadMode === 'main' ? list.files.filter((f) => f.toLowerCase() !== main) : list.files;
  if (files.length === 0) {
    const message = settings.reloadMode === 'main'
      ? `There are no category files in ${list.folder} yet. Use Set up this folder in Settings.`
      : `There are no .ahk files in ${list.folder} yet.`;
    return { ok: false, error: { code: 'no_files', message }, text };
  }
  return { ok: true, text, files, file: files.includes(settings.lastFile) ? settings.lastFile : files[0]!, options: settings.defaultOptions };
}

async function save(tabId: number, trigger: string, text: string, file: string, options: HotstringOptions): Promise<SaveReply | ErrorReply> {
  const result = toHotstring(trigger, text, options);
  if (!result.ok) return { ok: false, error: { code: 'invalid', message: result.errors.join(' ') } };
  const settings = await getSettings();
  const reply = await sendToHost({
    type: 'save',
    folder: settings.folder,
    ahkPath: settings.ahkPath,
    file,
    line: result.line,
    reload: reloadScript(settings),
  });
  if (reply.ok) {
    await updateSettings({ lastFile: reply.file });
    await chrome.storage.session.remove(captureKey(tabId));
    await sendToFrame(tabId, { type: 'frame.saved' });
  }
  return reply;
}

async function closeDialog(tabId: number): Promise<{ ok: true }> {
  await chrome.storage.session.remove(captureKey(tabId));
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
