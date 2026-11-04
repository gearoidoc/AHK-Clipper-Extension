// Phase 0 checks, run against the production build in dist/:
//   - the unpacked extension gets the fixed ID derived from the manifest key
//   - Test connection reaches the host and gets its echo back
//   - missing or mis-registered hosts produce the friendly errors
//   - the CSP blocks every network API from the service worker and the
//     options page, and a ping makes no http(s)/ws requests
import { rmSync } from 'node:fs';
import { check, id, launch, makeProfile, root, serviceWorker, startServer } from './lib.mjs';

// Runs inside the page or worker under test; every probe targets `${base}/${label}/...`.
async function probeNetwork(base, label) {
  const url = (kind) => `${base}/${label}/${kind}`;
  const settle = (promise) => promise.then(() => 'allowed', (e) => `blocked (${e?.message ?? e})`);
  const event = (start) => new Promise((resolve) => {
    try {
      start(resolve);
    } catch (e) {
      resolve(`blocked (${e.message})`);
    }
    setTimeout(() => resolve('no answer'), 3000);
  });
  const results = {};
  results.fetch = await settle(fetch(url('fetch')));
  results.websocket = await event((done) => {
    const ws = new WebSocket(url('websocket').replace(/^http/, 'ws'));
    ws.onopen = () => done('allowed');
    ws.onerror = () => done('blocked');
  });
  results.import = await settle(import(url('import')));
  if (typeof document !== 'undefined') {
    results.xhr = await event((done) => {
      const xhr = new XMLHttpRequest();
      xhr.open('GET', url('xhr'));
      xhr.onload = () => done('allowed');
      xhr.onerror = () => done('blocked');
      xhr.send();
    });
    results.eventsource = await event((done) => {
      const es = new EventSource(url('eventsource'));
      es.onopen = () => done('allowed');
      es.onerror = () => { es.close(); done('blocked'); };
    });
    results.beacon = navigator.sendBeacon(url('beacon'), 'x') ? 'queued' : 'refused';
    results.image = await event((done) => {
      const img = new Image();
      img.onload = () => done('allowed');
      img.onerror = () => done('blocked');
      img.src = url('image');
    });
    results.stylesheet = await event((done) => {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.onload = () => done('allowed');
      link.onerror = () => done('blocked');
      link.href = url('stylesheet');
      document.head.append(link);
    });
    results.iframe = await event((done) => {
      const frame = document.createElement('iframe');
      frame.onload = () => done('loaded');
      frame.src = url('iframe');
      document.body.append(frame);
    });
  }
  return results;
}

export async function privacySuite() {
  console.log('\nPrivacy and connection (dist/)');
  const { base, hits, close } = await startServer();
  const profile = makeProfile();
  profile.registerHost();
  const browser = await launch(root('dist'), profile.dir);
  try {
    const worker = await serviceWorker(browser);
    const loadedId = new URL(worker.url()).host;
    check('the extension ID is fixed by the manifest key', loadedId === id, loadedId);

    // Record every request the service worker and options page make.
    const requests = [];
    const workerSession = await worker.createCDPSession();
    await workerSession.send('Network.enable');
    workerSession.on('Network.requestWillBeSent', (e) => requests.push(`worker ${e.request.url}`));

    const page = await browser.newPage();
    page.on('request', (r) => requests.push(`options ${r.url()}`));
    await page.goto(`chrome-extension://${id}/options.html`);

    async function testConnection() {
      await page.click('#test-connection');
      await page.waitForSelector('#connection-result:is([data-state="ok"], [data-state="error"])', { timeout: 15_000 });
      return page.$eval('#connection-result', (el) => ({ state: el.dataset.state, code: el.dataset.code, text: el.innerText }));
    }

    requests.length = 0;
    const ping = await testConnection();
    check('Test connection reaches the host', ping.state === 'ok' && /Connected to host 0\.\d+\.\d+/.test(ping.text), ping.text.replace(/\s+/g, ' '));
    check('the host echoes the message back', /Echo\s+matched/.test(ping.text));
    const remote = requests.filter((r) => !/ chrome-extension:\/\//.test(r));
    check('a ping makes no http(s) or ws requests', remote.length === 0, remote.join(', '));

    rmSync(profile.hostManifest);
    const missing = await testConnection();
    check('a missing host gives the install hint', missing.state === 'error' && missing.code === 'host_missing', missing.text);

    profile.registerHost('a'.repeat(32));
    const forbidden = await testConnection();
    check('a host registered for another ID is reported', forbidden.state === 'error' && forbidden.code === 'host_forbidden', forbidden.text);
    profile.registerHost(id);

    // Network probes: an ordinary web page first, to prove each probe reaches the
    // server when nothing blocks it, then the two extension contexts.
    const control = await browser.newPage();
    await control.goto(`${base}/control/page`);
    const controlResults = await control.evaluate(probeNetwork, base, 'control');
    const sw = await worker.worker();
    const workerResults = await sw.evaluate(probeNetwork, base, 'worker');
    const optionsResults = await page.evaluate(probeNetwork, base, 'options');
    await new Promise((resolve) => setTimeout(resolve, 1000));

    for (const kind of Object.keys(optionsResults)) {
      const reached = (label) => hits.some((h) => h.startsWith(`/${label}/${kind}`));
      if (!reached('control')) {
        check(`control: ${kind} reaches the server from a web page`, false, controlResults[kind]);
        continue;
      }
      if (kind in workerResults) {
        check(`${kind} from the service worker never reaches the server`, !reached('worker'), workerResults[kind]);
      }
      check(`${kind} from the options page never reaches the server`, !reached('options'), optionsResults[kind]);
    }
    const strays = hits.filter((h) => !h.startsWith('/control/') && h !== '/favicon.ico');
    check('the server saw no requests from the extension', strays.length === 0, strays.join(', '));
  } finally {
    await browser.close();
    close();
    profile.cleanup();
  }
}
