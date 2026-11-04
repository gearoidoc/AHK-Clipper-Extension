// Settings live in chrome.storage.local, never the sync storage area, which
// would upload them to the Google account.

export interface Settings {
  /** Full path of the folder holding the .ahk files. */
  folder: string;
  /** Full path of AutoHotkey64.exe, or '' to let the host find it. */
  ahkPath: string;
  /** 'main': restart `mainScript`, which #Includes the others. 'written': restart the file just written. */
  reloadMode: 'main' | 'written';
  mainScript: string;
  lastFile: string;
}

export const DEFAULT_SETTINGS: Readonly<Settings> = Object.freeze({
  folder: '',
  ahkPath: '',
  reloadMode: 'main',
  mainScript: 'Main.ahk',
  lastFile: '',
});

const KEY = 'settings';

export async function getSettings(): Promise<Settings> {
  const stored = (await chrome.storage.local.get(KEY))[KEY] as Partial<Settings> | undefined;
  return { ...DEFAULT_SETTINGS, ...stored };
}

export async function updateSettings(patch: Partial<Settings>): Promise<Settings> {
  const next = { ...(await getSettings()), ...patch };
  await chrome.storage.local.set({ [KEY]: next });
  return next;
}

/** The `reload` field of a save request. */
export function reloadScript(settings: Settings): string {
  return settings.reloadMode === 'main' ? settings.mainScript : '';
}
