// Message shapes between extension pages, the content script, the service
// worker and the native host. host/handlers.go and host/errors.go are the
// other side of the host messages.

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
  /** Main script to validate and restart, or '' to restart `file` itself. */
  reload: string;
}

export interface SaveReply {
  ok: true;
  id: string;
  file: string;
  entry: string;
  includeAdded: boolean;
}

export interface HostReplies {
  ping: PingReply;
  listFiles: ListFilesReply;
  createFile: CreateFileReply;
  save: SaveReply;
}

export type HostRequest = PingRequest | ListFilesRequest | CreateFileRequest | SaveRequest;

// Extension pages → service worker.

export interface SetupFolderReply {
  ok: true;
  created: string[];
}

export interface DialogInitReply {
  ok: true;
  text: string;
  files: string[];
  file: string;
}

/** On failure the dialog still shows the captured text, so nothing is lost. */
export type DialogInit = DialogInitReply | (ErrorReply & { text: string });

export type ExtensionMessage =
  | { type: 'host.ping'; echo: string }
  | { type: 'settings.listFiles'; folder: string }
  | { type: 'settings.setupFolder'; folder: string }
  | { type: 'dialog.init' }
  | { type: 'dialog.save'; trigger: string; text: string; file: string }
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
  /** Give focus back to the page now and close the dialog after the success message. */
  | { type: 'frame.saved' };
