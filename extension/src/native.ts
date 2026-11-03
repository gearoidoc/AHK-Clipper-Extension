import { HOST_NAME, type ErrorReply, type HostError, type HostErrorCode, type HostReplies, type HostRequest } from './protocol.ts';

// Chrome reports native messaging failures only as lastError strings.
const CHROME_ERRORS: [pattern: RegExp, code: HostErrorCode, message: string][] = [
  [/not found/i, 'host_missing', "The native host isn't installed. Run install.ps1 from the release folder, then test again."],
  [/forbidden/i, 'host_forbidden', 'The native host is registered for a different extension ID. Run install.ps1 again.'],
  [/exited/i, 'host_exited', 'The native host stopped before it replied.'],
  [/communicating/i, 'host_protocol', "Chrome couldn't read the native host's reply."],
];

/**
 * Sends one request to the native host. Chrome starts a fresh host process
 * for each call. Never throws: failures come back as an ErrorReply.
 */
export async function sendToHost<R extends HostRequest>(request: R): Promise<HostReplies[R['type']] | ErrorReply> {
  let reply: unknown;
  try {
    reply = await chrome.runtime.sendNativeMessage(HOST_NAME, request);
  } catch (e) {
    return { ok: false, error: describeChromeError(e) };
  }
  if (typeof reply !== 'object' || reply === null || typeof (reply as { ok?: unknown }).ok !== 'boolean') {
    return { ok: false, error: { code: 'host_protocol', message: 'The native host sent a reply in an unexpected format.' } };
  }
  return reply as HostReplies[R['type']] | ErrorReply;
}

function describeChromeError(e: unknown): HostError {
  const detail = e instanceof Error ? e.message : String(e);
  for (const [pattern, code, message] of CHROME_ERRORS) {
    if (pattern.test(detail)) return { code, message };
  }
  return { code: 'host_error', message: detail };
}
