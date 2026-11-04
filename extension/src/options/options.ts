import type { ErrorReply, ExtensionMessage, ListFilesReply, PingReply, SetupFolderReply } from '../protocol.ts';
import { getSettings, updateSettings, type Settings } from '../settings.ts';

const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const folder = byId<HTMLInputElement>('folder');
const folderResult = byId<HTMLElement>('folder-result');
const setup = byId<HTMLElement>('setup');
const setupMain = byId<HTMLElement>('setup-main');
const setupButton = byId<HTMLButtonElement>('setup-folder');
const mainScript = byId<HTMLInputElement>('main-script');
const ahkPath = byId<HTMLInputElement>('ahk-path');
const testButton = byId<HTMLButtonElement>('test-connection');
const connectionResult = byId<HTMLElement>('connection-result');
const saved = byId<HTMLElement>('saved');
const reloadChoices = [...document.querySelectorAll<HTMLInputElement>('input[name="reload"]')];

const send = <T>(message: ExtensionMessage): Promise<T> => chrome.runtime.sendMessage(message);
let savedTimer: number | undefined;

void init();

async function init(): Promise<void> {
  const settings = await getSettings();
  folder.value = settings.folder;
  mainScript.value = settings.mainScript;
  ahkPath.value = settings.ahkPath;
  for (const choice of reloadChoices) choice.checked = choice.value === settings.reloadMode;

  folder.addEventListener('change', () => void save({ folder: folder.value.trim() }).then(checkFolder));
  mainScript.addEventListener('change', () => void save({ mainScript: mainScript.value.trim() || 'Main.ahk' }).then(checkFolder));
  ahkPath.addEventListener('change', () => void save({ ahkPath: ahkPath.value.trim() }));
  for (const choice of reloadChoices) {
    choice.addEventListener('change', () => void save({ reloadMode: choice.value as Settings['reloadMode'] }).then(checkFolder));
  }
  byId('check-folder').addEventListener('click', () => void checkFolder());
  setupButton.addEventListener('click', () => void setupFolder());
  testButton.addEventListener('click', () => void testConnection());
  byId('change-shortcut').addEventListener('click', () => void chrome.tabs.create({ url: 'chrome://extensions/shortcuts' }));

  const command = (await chrome.commands.getAll()).find((c) => c.name === 'open-dialog');
  byId('shortcut').textContent = command?.shortcut || 'not set';

  if (settings.folder) await checkFolder();
}

async function save(patch: Partial<Settings>): Promise<void> {
  const settings = await updateSettings(patch);
  folder.value = settings.folder;
  mainScript.value = settings.mainScript;
  saved.textContent = 'Saved';
  window.clearTimeout(savedTimer);
  savedTimer = window.setTimeout(() => (saved.textContent = ''), 1500);
}

async function checkFolder(): Promise<void> {
  setup.hidden = true;
  const settings = await getSettings();
  if (!settings.folder) {
    show(folderResult, 'error', 'Enter the full path of the folder for your .ahk files.');
    return;
  }
  show(folderResult, 'pending', 'Checking…');
  const reply = await send<ListFilesReply | ErrorReply>({ type: 'settings.listFiles', folder: settings.folder });
  if (!reply.ok) {
    show(folderResult, 'error', reply.error.message, reply.error.code);
    return;
  }
  const { files } = reply;
  const listed = files.length <= 12 ? files.join(', ') : `${files.slice(0, 12).join(', ')} and ${files.length - 12} more`;
  show(folderResult, 'ok', files.length === 0 ? 'The folder is empty.' : `Found ${files.length} .ahk ${files.length === 1 ? 'file' : 'files'}: ${listed}`);
  const hasMain = files.some((f) => f.toLowerCase() === settings.mainScript.toLowerCase());
  setupMain.textContent = settings.mainScript;
  setup.hidden = settings.reloadMode !== 'main' || hasMain;
}

async function setupFolder(): Promise<void> {
  setupButton.disabled = true;
  try {
    const reply = await send<SetupFolderReply | ErrorReply>({ type: 'settings.setupFolder', folder: folder.value.trim() });
    if (!reply.ok) {
      show(folderResult, 'error', reply.error.message, reply.error.code);
      return;
    }
    for (const choice of reloadChoices) choice.checked = choice.value === 'main';
    await checkFolder();
    const status = folderResult.querySelector('.status');
    if (status) status.textContent += `. Created ${reply.created.join(' and ')}: double-click ${reply.created[0]} to start it.`;
  } finally {
    setupButton.disabled = false;
  }
}

async function testConnection(): Promise<void> {
  testButton.disabled = true;
  show(connectionResult, 'pending', 'Testing…');
  const echo = crypto.randomUUID();
  try {
    const reply = await send<PingReply | ErrorReply | undefined>({ type: 'host.ping', echo });
    if (!reply) {
      show(connectionResult, 'error', 'The extension service worker did not answer.', 'no_reply');
    } else if (!reply.ok) {
      show(connectionResult, 'error', reply.error.message, reply.error.code);
    } else if (reply.echo !== echo) {
      show(connectionResult, 'error', 'The host answered, but echoed the wrong message.', 'bad_echo');
    } else {
      if (reply.ahkPath) ahkPath.placeholder = reply.ahkPath;
      show(connectionResult, 'ok', `Connected to host ${reply.version} (${reply.os}).`, undefined, [
        ['AutoHotkey', reply.ahkPath || 'AutoHotkey v2 not found in its default install folders'],
        ['Echo', 'matched'],
      ]);
    }
  } finally {
    testButton.disabled = false;
  }
}

function show(target: HTMLElement, state: 'pending' | 'ok' | 'error', status: string, code?: string, details: [string, string][] = []): void {
  target.dataset.state = state;
  if (code) target.dataset.code = code;
  else delete target.dataset.code;

  const statusLine = document.createElement('p');
  statusLine.className = 'status';
  statusLine.textContent = status;
  const nodes: HTMLElement[] = [statusLine];

  if (details.length > 0) {
    const list = document.createElement('dl');
    for (const [term, value] of details) {
      const dt = document.createElement('dt');
      dt.textContent = term;
      const dd = document.createElement('dd');
      dd.textContent = value;
      list.append(dt, dd);
    }
    nodes.push(list);
  }
  target.replaceChildren(...nodes);
}
