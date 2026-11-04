// Settings live in chrome.storage.local, never the sync storage area, which
// would upload them to the Google account.
import { NO_OPTIONS, toOptions, type HotstringOptions } from './hotstring.ts';

export interface Settings {
  /** Full path of the folder holding the .ahk files. */
  folder: string;
  /** Full path of AutoHotkey64.exe, or '' to let the host find it. */
  ahkPath: string;
  /** 'main': restart `mainScript`, which #Includes the others. 'written': restart the file just written. */
  reloadMode: 'main' | 'written';
  mainScript: string;
  lastFile: string;
  /** Pre-ticked in the dialog for each new hotstring. */
  defaultOptions: HotstringOptions;
  /** Put in front of suggested triggers; '' is allowed. */
  triggerPrefix: string;
  /** Prefill the trigger with a suggestion made from the text. */
  suggest: boolean;
  /** Tick "Source comment" in the dialog by default. */
  sourceComment: boolean;
}

export const DEFAULT_SETTINGS: Readonly<Settings> = Object.freeze({
  folder: '',
  ahkPath: '',
  reloadMode: 'main',
  mainScript: 'Main.ahk',
  lastFile: '',
  // Expanding as soon as the trigger is typed suits ;-prefixed triggers.
  defaultOptions: Object.freeze({ ...NO_OPTIONS, immediate: true }),
  triggerPrefix: ';',
  suggest: true,
  // Off: shared files stay one line per hotstring and carry no page URLs.
  sourceComment: false,
});

const KEY = 'settings';

export async function getSettings(): Promise<Settings> {
  const stored = (await chrome.storage.local.get(KEY))[KEY] as Partial<Settings> | undefined;
  return {
    ...DEFAULT_SETTINGS,
    ...stored,
    defaultOptions: stored?.defaultOptions ? toOptions(stored.defaultOptions) : { ...DEFAULT_SETTINGS.defaultOptions },
  };
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
