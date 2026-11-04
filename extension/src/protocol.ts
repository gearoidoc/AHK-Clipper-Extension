// Message shapes between extension pages, the content script, the service
// worker and the native host. host/handlers.go and host/errors.go are the
// other side of the host messages.
import type { HotstringOptions } from './hotstring.ts';

export const HOST_NAME = 'com.gearoid.ahk_clipper';

export type HostErrorCode =
  // Sent by the host.
  | 'bad_request'
  | 'unknown_type'
  | 'not_implemented'
  | 'forbidden_origin'
  | 'too_large'
  | 'folder_missing'
  | 'file_missing'
  | 'file_exists'
  | 'bad_name'
  | 'path_outside'
  | 'ahk_missing'
  | 'ahk_invalid'
  | 'reload_failed'
  | 'encoding'
  | 'file_busy'
  | 'locked'
  | 'bad_line'
  | 'hotstring_x'
  | 'duplicate'
  | 'file_changed'
  | 'io_error'
  // Set by native.ts when Chrome can't reach the host.
  | 'host_missing'
  | 'host_forbidden'
  | 'host_exited'
  | 'host_protocol'
  | 'host_error'
  // Set by the service worker.
  | 'invalid'
  | 'no_files';

export interface HostError {
  code: HostErrorCode;
  message: string;
}

export interface ErrorReply {
  ok: false;
  error: HostError;
}

/** Errors that the Settings page can fix. */
export const SETTINGS_ERRORS: ReadonlySet<HostErrorCode> = new Set(['folder_missing', 'no_files', 'ahk_missing', 'host_missing', 'host_forbidden']);

// Extension → host.

export interface PingRequest {
  type: 'ping';
  echo: string;
}

export interface PingReply {
  ok: true;
  version: string;
  echo: string;
  /** Empty when AutoHotkey v2 isn't installed in a standard place. */
  ahkPath: string;
  os: string;
}

export interface ListFilesRequest {
  type: 'listFiles';
  folder: string;
}

export interface ListFilesReply {
  ok: true;
  /** The folder's canonical path. */
  folder: string;
  files: string[];
}

/** A hotstring found by scan, in any .ahk file in the folder. */
export interface ScannedHotstring {
  file: string;
  /** 1-based line number. */
  line: number;
  trigger: string;
  caseSensitive: boolean;
  instant: boolean;
  /** One-line preview of what it types, or "(runs code)". */
  text: string;
  /** The entry id this extension added, or ''. */
  id: string;
  /** Identifies the line's exact contents, for Replace. */
  hash: string;
}

export interface ScanRequest {
  type: 'scan';
  folder: string;
}

export interface ScanReply {
  ok: true;
  folder: string;
  files: string[];
  hotstrings: ScannedHotstring[];
  /** Files that aren't UTF-8 and so weren't scanned. */
  skipped: string[];
  truncated: boolean;
}

/** An existing hotstring to replace in place, as scan reported it. */
export interface ReplaceTarget {
  file: string;
  line: number;
  hash: string;
}

/** Hands back to the host to undo exactly one save. */
export interface UndoToken {
  file: string;
  id: string;
  sha256: string;
}

export interface CreateFileRequest {
  type: 'createFile';
  folder: string;
  name: string;
  kind: 'main' | 'category';
  /** Main script to add an #Include for the new file to, or ''. */
  includeIn: string;
}

export interface CreateFileReply {
  ok: true;
  file: string;
  includeAdded: boolean;
}

export interface SaveRequest {
  type: 'save';
  folder: string;
  /** '' to let the host find AutoHotkey. */
  ahkPath: string;
  file: string;
  line: string;
  /** A `; from …` source comment line to write above it, or ''. */
  comment: string;
  /** Main script to validate and restart, or '' to restart `file` itself. */
  reload: string;
  replace: ReplaceTarget | null;
}

export interface SaveReply {
  ok: true;
  id: string;
  file: string;
  entry: string;
  includeAdded: boolean;
  replaced: boolean;
  undo: UndoToken;
}

export interface UndoRequest extends UndoToken {
  type: 'undo';
  folder: string;
  ahkPath: string;
  reload: string;
}

export interface UndoReply {
  ok: true;
  file: string;
  /** The file went back byte for byte, which also restores a replaced entry. */
  exact: boolean;
}

export interface HostReplies {
  ping: PingReply;
  listFiles: ListFilesReply;
  scan: ScanReply;
  createFile: CreateFileReply;
  save: SaveReply;
  undo: UndoReply;
}

export type HostRequest = PingRequest | ListFilesRequest | ScanRequest | CreateFileRequest | SaveRequest | UndoRequest;

// Extension pages → service worker.

export interface SetupFolderReply {
  ok: true;
  created: string[];
}

export interface DialogInitReply {
  ok: true;
  text: string;
  /** The page the text came from, for the paste hint. */
  url: string;
  files: string[];
  file: string;
  hotstrings: ScannedHotstring[];
  /** The default options from Settings. */
  options: HotstringOptions;
  triggerPrefix: string;
  suggest: boolean;
  /** The source comment this capture would get, and whether it's ticked by default. */
  comment: string;
  withComment: boolean;
}

/** On failure the dialog still shows the captured text, so nothing is lost. */
export type DialogInit = DialogInitReply | (ErrorReply & { text: string });

export type ExtensionMessage =
  | { type: 'host.ping'; echo: string }
  | { type: 'settings.listFiles'; folder: string }
  | { type: 'settings.setupFolder'; folder: string }
  | { type: 'dialog.init' }
  | { type: 'dialog.save'; trigger: string; text: string; file: string; options: HotstringOptions; withComment: boolean; replace: ReplaceTarget | null }
  | { type: 'dialog.undo' }
  | { type: 'dialog.createFile'; name: string }
  | { type: 'dialog.resize'; height: number }
  | { type: 'dialog.close' }
  | { type: 'dialog.openSettings' };

// Service worker → content script (dialog-host.ts).

export interface Rect {
  top: number;
  left: number;
  bottom: number;
  right: number;
}

export type FrameMessage =
  | { type: 'frame.open'; rect: Rect | null }
  | { type: 'frame.resize'; height: number }
  /** Close the dialog and give focus back to the page. */
  | { type: 'frame.close' }
  /** Give focus back to the page and show the dialog as a toast with Undo in the corner. */
  | { type: 'frame.toast' }
  /** The toast has its final message (Undo is done or failed): close it shortly. */
  | { type: 'frame.toastDone' };
