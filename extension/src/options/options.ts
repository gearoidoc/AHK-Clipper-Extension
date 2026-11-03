import type { ErrorReply, ExtensionMessage, PingReply } from '../protocol.ts';

const button = document.querySelector<HTMLButtonElement>('#test-connection')!;
const result = document.querySelector<HTMLElement>('#connection-result')!;

button.addEventListener('click', () => void testConnection());

async function testConnection(): Promise<void> {
  button.disabled = true;
  show('pending', 'Testing…');
  const echo = crypto.randomUUID();
  try {
    const reply: PingReply | ErrorReply | undefined = await chrome.runtime.sendMessage({ type: 'host.ping', echo } satisfies ExtensionMessage);
    if (!reply) {
      show('error', 'The extension service worker did not answer.', 'no_reply');
    } else if (!reply.ok) {
      show('error', reply.error.message, reply.error.code);
    } else if (reply.echo !== echo) {
      show('error', 'The host answered, but echoed the wrong message.', 'bad_echo');
    } else {
      show('ok', `Connected to host ${reply.version} (${reply.os}).`, undefined, [
        ['AutoHotkey', reply.ahkPath || 'AutoHotkey v2 not found in its default install folders'],
        ['Echo', 'matched'],
      ]);
    }
  } finally {
    button.disabled = false;
  }
}

function show(state: 'pending' | 'ok' | 'error', status: string, code?: string, details: [string, string][] = []): void {
  result.dataset.state = state;
  if (code) result.dataset.code = code;
  else delete result.dataset.code;

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
  result.replaceChildren(...nodes);
}
