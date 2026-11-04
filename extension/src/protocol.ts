// Message shapes between extension pages, the service worker and the native
// host. host/handlers.go is the other side of the host messages.

export const HOST_NAME = 'com.gearoid.ahk_clipper';

export type HostErrorCode =
  // Sent by the host.
  | 'bad_request'
  | 'unknown_type'
  | 'not_implemented'
  | 'forbidden_origin'
  | 'too_large'
  // Set by native.ts when Chrome can't reach the host.
  | 'host_missing'
  | 'host_forbidden'
  | 'host_exited'
  | 'host_protocol'
  | 'host_error';

export interface HostError {
  code: HostErrorCode;
  message: string;
}

export interface ErrorReply {
  ok: false;
  error: HostError;
}

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

export interface HostReplies {
  ping: PingReply;
}

export type HostRequest = PingRequest;

// Extension page → service worker.

export interface PingHostMessage {
  type: 'host.ping';
  echo: string;
}

export type ExtensionMessage = PingHostMessage;
