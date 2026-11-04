// Phase 1 checks, run against the e2e build in .e2e/dist with the Linux host
// and a fake AutoHotkey64.exe that logs its arguments:
//   - Settings sets up the folder (Main.ahk + General.ahk) and holds the
//     default options; the dialog's option chips start from them
//   - select text, open the dialog, type a trigger, Enter: the line is written,
//     AutoHotkey validates and restarts Main.ahk, and focus returns
//   - a failed validation leaves the file untouched and keeps what was typed
//   - a new category gets its #Include; a missing folder is explained
//   - the page can't read the dialog, gets no messages, and the dialog still
//     loads under a strict page CSP
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { check, id, launch, makeProfile, root, serviceWorker, sleep, startServer, waitFor } from './lib.mjs';

const FAKE_AHK = `#!/bin/sh
# Stands in for AutoHotkey64.exe: logs its arguments, fails /Validate while a
# fail-validate file sits next to it, and stays up briefly after /restart like
# a running script.
dir=$(dirname "$0")
printf '%s\\n' "$*" >> "$dir/calls.log"
case " $* " in
  *" /Validate "*)
    if [ -e "$dir/fail-validate" ]; then
      echo "General.ahk (7) : ==> This line does not contain a recognized action." >&2
      exit 2
    fi ;;
  *" /restart "*)
    sleep 2 ;;
esac
exit 0
`;

const PAGE = `<!doctype html><html><head><title>Test page</title></head><body>
<p id="phrase">be right back</p>
<p><input id="field" value="hello world"></p>
</body></html>`;

export async function dialogSuite() {
  console.log('\nCapture dialog (.e2e/dist)');
  const work = realpathSync(mkdtempSync(join(tmpdir(), 'ahk-clipper-files-')));
  const folder = join(work, 'Hotstrings');
  const ahkDir = join(work, 'ahk');
  mkdirSync(folder);
  mkdirSync(ahkDir);
  const ahkPath = join(ahkDir, 'AutoHotkey64.exe');
  writeFileSync(ahkPath, FAKE_AHK, { mode: 0o755 });
  const calls = () => (existsSync(join(ahkDir, 'calls.log')) ? readFileSync(join(ahkDir, 'calls.log'), 'utf8').trim().split('\n') : []);
  const read = (name) => (existsSync(join(folder, name)) ? readFileSync(join(folder, name), 'utf8') : '');

  const { base, hits, close } = await startServer({
    '/page': { body: PAGE },
    '/strict': { body: PAGE, headers: { 'content-security-policy': "default-src 'none'; frame-src 'none'; style-src 'none'" } },
  });
  const profile = makeProfile();
  profile.registerHost();
  const browser = await launch(root('.e2e/dist'), profile.dir);

  try {
    const worker = await serviceWorker(browser);
    const sw = await worker.worker();
    const extensionRequests = [];
    const workerSession = await worker.createCDPSession();
    await workerSession.send('Network.enable');
    workerSession.on('Network.requestWillBeSent', (e) => extensionRequests.push(e.request.url));

    // Settings: point at the folder and the fake AutoHotkey, then set the folder up.
    const options = await browser.newPage();
    await options.goto(`chrome-extension://${id}/options.html`);
    const setField = (selector, value) =>
      options.$eval(selector, (el, v) => {
        el.value = v;
        el.dispatchEvent(new Event('change'));
      }, value);
    await setField('#ahk-path', ahkPath);
    await setField('#folder', folder);
    await options.waitForSelector('#setup:not([hidden])', { timeout: 5000 });
    await options.click('#setup-folder');
    await options.waitForFunction(() => /Created/.test(document.querySelector('#folder-result')?.textContent ?? ''), { timeout: 5000 });
    check('Set up this folder creates Main.ahk and General.ahk', read('Main.ahk').includes('#Include "General.ahk"') && read('General.ahk').includes('; --- Added by Hotstring Clipper ---'),
      await options.$eval('#folder-result', (el) => el.textContent));
    const defaults = await options.$$eval('#default-options input', (els) => els.filter((i) => i.checked).map((i) => i.name).join());
    check('Instant (*) is the only default option', defaults === 'immediate', defaults);

    // The page under test, with a listener for any postMessage traffic.
    const page = await browser.newPage();
    page.on('request', (r) => {
      if (r.frame()?.url().startsWith('chrome-extension://')) extensionRequests.push(r.url());
    });
    await page.goto(`${base}/page`);
    await page.evaluate(() => {
      window.messages = 0;
      window.addEventListener('message', () => window.messages++, true);
    });
    const tabId = await sw.evaluate(async (url) => (await chrome.tabs.query({})).find((t) => t.url === url)?.id, `${base}/page`);

    const selectPhrase = () => page.evaluate(() => {
      const range = document.createRange();
      range.selectNodeContents(document.querySelector('#phrase'));
      getSelection().removeAllRanges();
      getSelection().addRange(range);
    });
    async function openDialog(target = page, tab = tabId) {
      await sw.evaluate((t) => globalThis.__ahkClipperTest.openDialog(t), tab);
      await target.waitForSelector('iframe[title="Add AHK hotstring"]', { timeout: 5000 });
      const frame = await target.waitForFrame((f) => f.url().endsWith('/dialog.html'), { timeout: 5000 });
      await frame.waitForFunction(() => document.querySelector('#file').options.length > 0 || !document.querySelector('#banner').hidden, { timeout: 5000 });
      // Wait until the iframe has grown to fit the dialog, so clicks land where they aim.
      await waitFor(async () => {
        const card = await frame.$eval('#card', (el) => el.getBoundingClientRect().height);
        const box = await target.$eval('iframe[title="Add AHK hotstring"]', (el) => el.getBoundingClientRect().height);
        return Math.abs(card - box) < 2;
      }, 3000);
      return frame;
    }
    const dialogGone = (target = page) => waitFor(() => target.$('iframe[title="Add AHK hotstring"]').then((el) => el === null), 4000);

    // 1. Select a phrase, open the dialog, save ;brb.
    await selectPhrase();
    let frame = await openDialog();
    const box = await page.$eval('iframe', (el) => el.getBoundingClientRect().toJSON());
    const phrase = await page.$eval('#phrase', (el) => el.getBoundingClientRect().toJSON());
    // Aligned with the selection, but never closer than 12 px to the viewport edge.
    check('the dialog opens just below the selection', box.top >= phrase.bottom && box.top - phrase.bottom < 20 && Math.abs(box.left - Math.max(phrase.left, 12)) < 1,
      `dialog at ${box.left},${box.top}; selection at ${phrase.left},${phrase.bottom}`);
    check('the selection is prefilled as the replacement', (await frame.$eval('#text', (el) => el.value)) === 'be right back');
    check('General.ahk is offered, not Main.ahk', (await frame.$$eval('#file option', (els) => els.map((o) => o.value)).then((v) => v.join())) === 'General.ahk');
    const focused = await waitFor(() => frame.evaluate(() => document.hasFocus() && document.activeElement?.id === 'trigger'), 2000);
    check('the trigger field has focus', focused);
    const chips = () => frame.$$eval('#options input', (els) => els.filter((i) => i.checked).map((i) => i.name).join());
    check('the option chips start from the Settings defaults', (await chips()) === 'immediate', await chips());
    for (let i = 0; i < 3; i++) await page.keyboard.press('Tab');
    const tabbed = await frame.evaluate(() => document.activeElement?.getAttribute('name') ?? document.activeElement?.id);
    check('Tab goes trigger, replacement, file, then the options', tabbed === 'immediate', tabbed);
    check('the page can\'t read inside the dialog', await page.evaluate(() => document.querySelector('iframe').contentDocument === null));
    const src = await page.$eval('iframe', (el) => el.src);
    check('the dialog URL is per-session, not the extension ID', src.startsWith('chrome-extension://') && !src.includes(id), src);

    await frame.type('#trigger', ';brb');
    await page.keyboard.press('Enter');
    const general = await waitFor(() => /;brb::/.test(read('General.ahk')) && read('General.ahk'));
    check('Enter writes the line to General.ahk, expanding instantly (*)', /\r\n:\*T:;brb::be right back ; hsc:[a-z2-9]{6}\r\n$/.test(general || ''), JSON.stringify((general || '').slice(-60)));
    const log = calls();
    check('AutoHotkey validates, then restarts Main.ahk', log.length === 2 && /^\/ErrorStdOut=UTF-8 \/Validate .*\/Main\.ahk$/.test(log[0]) && /^\/ErrorStdOut=UTF-8 \/restart .*\/Main\.ahk$/.test(log[1]), log.join(' | '));
    const done = await waitFor(() => frame.$eval('#done', (el) => (el.hidden ? '' : el.textContent)).catch(() => ''), 2000);
    check('the dialog confirms the save', done === 'Saved ;brb to General.ahk, reloaded.', done);
    check('focus and selection go back to the page', await page.evaluate(() => !document.querySelector('iframe')?.matches(':focus') && getSelection().toString() === 'be right back'));
    check('the dialog closes itself after the confirmation', await dialogGone());

    // 2. Text selected in an input; AutoHotkey rejects the script; Esc.
    await page.evaluate(() => {
      const field = document.querySelector('#field');
      field.focus();
      field.setSelectionRange(0, 5);
    });
    frame = await openDialog();
    check('text selected in an input is captured', (await frame.$eval('#text', (el) => el.value)) === 'hello');
    writeFileSync(join(ahkDir, 'fail-validate'), '');
    const before = read('General.ahk');
    await frame.type('#trigger', ';hel');
    await page.keyboard.press('Enter');
    const banner = await waitFor(() => frame.$eval('#banner', (el) => (el.hidden ? '' : el.textContent)), 4000);
    check('a failed validation shows AutoHotkey\'s message', /can't load Main\.ahk, so nothing was saved[\s\S]*does not contain a recognized action/.test(banner || ''), banner);
    check('a script error doesn\'t offer Settings as the fix', await frame.$eval('#open-settings', (el) => el.hidden));
    check('the file is left exactly as it was', read('General.ahk') === before);
    check('the dialog stays open with the trigger kept', (await frame.$eval('#trigger', (el) => el.value)) === ';hel');
    check('AutoHotkey isn\'t restarted after a failed validation', calls().filter((c) => c.includes('/restart')).length === 1);
    rmSync(join(ahkDir, 'fail-validate'));
    await page.keyboard.press('Escape');
    check('Esc closes the dialog', await dialogGone());
    check('focus and the selection go back to the input', await page.evaluate(() => {
      const field = document.querySelector('#field');
      return document.activeElement === field && field.selectionStart === 0 && field.selectionEnd === 5;
    }));

    // 3. A category Main.ahk doesn't include yet.
    writeFileSync(join(folder, 'Email.ahk'), '; Email hotstrings\r\n');
    await selectPhrase();
    frame = await openDialog();
    await frame.select('#file', 'Email.ahk');
    await frame.click('label.chip:has(input[name="immediate"])');
    check('clicking the Instant chip unticks it', (await chips()) === '', await chips());
    await frame.type('#trigger', ';ty');
    await page.keyboard.press('Enter');
    await waitFor(() => read('Email.ahk').includes(';ty::'));
    check('saving to a new category adds its #Include to Main.ahk', read('Main.ahk').includes('#Include "Email.ahk"'));
    check('unticking Instant for one hotstring writes a plain :T: line', read('Email.ahk').includes('\r\n:T:;ty::be right back ; hsc:'), JSON.stringify(read('Email.ahk').slice(-50)));
    const doneEmail = await waitFor(() => frame.$eval('#done', (el) => (el.hidden ? '' : el.textContent)).catch(() => ''), 2000);
    check('the confirmation mentions the new #Include', /Main\.ahk now includes Email\.ahk/.test(doneEmail || ''), doneEmail);
    await dialogGone();

    // 4. New defaults in Settings reach the dialog.
    await options.bringToFront();
    await options.click('#default-options input[name="immediate"]');
    await options.click('#default-options input[name="caseSensitive"]');
    await waitFor(() => sw.evaluate(async () => (await chrome.storage.local.get('settings')).settings?.defaultOptions?.caseSensitive === true));
    await page.bringToFront();
    await selectPhrase();
    frame = await openDialog();
    check('changed defaults in Settings are pre-ticked in the dialog', (await chips()) === 'caseSensitive', await chips());
    await page.keyboard.press('Escape');
    await dialogGone();

    // 5. A folder that no longer exists.
    await sw.evaluate(async (missing) => {
      const { settings } = await chrome.storage.local.get('settings');
      await chrome.storage.local.set({ settings: { ...settings, folder: missing } });
    }, join(work, 'gone'));
    await selectPhrase();
    frame = await openDialog();
    const missing = await frame.$eval('#banner', (el) => el.textContent);
    check('a missing folder is explained, with a way to Settings', /doesn't exist/.test(missing) && (await frame.$eval('#open-settings', (el) => !el.hidden)), missing);
    check('the selection is still shown', (await frame.$eval('#text', (el) => el.value)) === 'be right back');
    await page.keyboard.press('Escape');
    await dialogGone();
    await sw.evaluate(async (f) => {
      const { settings } = await chrome.storage.local.get('settings');
      await chrome.storage.local.set({ settings: { ...settings, folder: f } });
    }, folder);

    // 6. A page with a strict Content Security Policy.
    const strict = await browser.newPage();
    await strict.goto(`${base}/strict`);
    const strictTab = await sw.evaluate(async (url) => (await chrome.tabs.query({})).find((t) => t.url === url)?.id, `${base}/strict`);
    await strict.evaluate(() => {
      const range = document.createRange();
      range.selectNodeContents(document.querySelector('#phrase'));
      getSelection().addRange(range);
    });
    const strictFrame = await openDialog(strict, strictTab).catch(() => null);
    check('the dialog loads on a page with a strict CSP', strictFrame !== null && (await strictFrame.$eval('#text', (el) => el.value)) === 'be right back');
    await strict.close();

    // Privacy across all of the above.
    check('the page received no postMessage traffic', (await page.evaluate(() => window.messages)) === 0);
    const remote = extensionRequests.filter((url) => !url.startsWith('chrome-extension://'));
    check('the extension made no http(s) or ws requests', remote.length === 0, remote.join(', '));
    const strays = hits.filter((h) => !['/page', '/strict', '/favicon.ico'].includes(h));
    check('the server saw only the test pages', strays.length === 0, strays.join(', '));
  } finally {
    await browser.close();
    close();
    profile.cleanup();
    await sleep(100);
    rmSync(work, { recursive: true, force: true });
  }
}
