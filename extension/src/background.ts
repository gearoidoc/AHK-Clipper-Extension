// Service worker: the only part of the extension that talks to the native host.
import { sendToHost } from './native.ts';
import type { ExtensionMessage } from './protocol.ts';

chrome.runtime.onMessage.addListener((message: ExtensionMessage, sender, sendResponse) => {
  // runtime.onMessage only carries this extension's own messages, but content
  // scripts (later phases) send from the web page's URL and must not reach these.
  if (sender.id !== chrome.runtime.id || !sender.url?.startsWith(chrome.runtime.getURL(''))) return false;

  switch (message?.type) {
    case 'host.ping':
      if (typeof message.echo !== 'string') return false;
      void sendToHost({ type: 'ping', echo: message.echo }).then(sendResponse);
      return true; // Reply asynchronously.
    default:
      return false;
  }
});
