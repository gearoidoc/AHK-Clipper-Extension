// The dialog end to end, run against the e2e build in .e2e/dist with the Linux
// host and a fake AutoHotkey64.exe that logs its arguments:
//   - Settings sets up the folder (Main.ahk + General.ahk) and holds the
//     defaults; the dialog's option chips start from them
//   - select text, open the dialog, take the suggested trigger, Enter: the
//     line is written, AutoHotkey validates and restarts Main.ahk, focus
//     returns, and a toast with Undo shows in the corner
//   - a failed validation leaves the file untouched and keeps what was typed
//   - duplicates offer Replace and Rename; Instant prefix clashes are warned
//   - New file…, the source comment and its preview, Undo
//   - a missing folder, an empty selection, a contenteditable editor
//   - the page can't read the dialog, gets no messages, and the dialog still
//     loads under a strict page CSP
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { check, FAKE_AHK, id, launch, makeProfile, root, serviceWorker, sleep, startServer, waitFor } from './lib.mjs';

const PAGE = `<!doctype html><html><head><title>Test page</title></head><body>
<p id="phrase">be right back</p>
<p><input id="field" value="hello world"></p>
</body></html>`;

const EDITABLE = `<!doctype html><html><head><title>Editor</title></head><body>
<div id="editor" contenteditable="true">Kind regards, Sam</div>
</body></html>`;

const DIALOG = 'iframe[title="Add AHK hotstring"]';

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
  const lastLines = (name, n) => read(name).trimEnd().split('\r\n').slice(-n);

  const { base, hits, close } = await startServer({
    '/page': { body: PAGE },
    '/editable': { body: EDITABLE },
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
    const triggerDefaults = await options.evaluate(() => [document.querySelector('#suggest').checked, document.querySelector('#trigger-prefix').value, document.querySelector('#source-comment').checked]);
    check('suggestions are on, the prefix is ";" and the source comment is off by default', JSON.stringify(triggerDefaults) === '[true,";",false]', JSON.stringify(triggerDefaults));

    // The pages under test, each with a listener for any postMessage traffic.
    const openPage = async (path) => {
      const p = await browser.newPage();
      p.on('request', (r) => {
        if (r.frame()?.url().startsWith('chrome-extension://')) extensionRequests.push(r.url());
      });
      await p.goto(`${base}${path}`);
      await p.evaluate(() => {
        window.messages = 0;
        window.addEventListener('message', () => window.messages++, true);
      });
      const tab = await sw.evaluate(async (url) => (await chrome.tabs.query({})).filter((t) => t.url === url).pop()?.id, `${base}${path}`);
      return { p, tab };
    };
    const { p: page, tab: tabId } = await openPage('/page');

    const selectPhrase = (target = page) => target.evaluate(() => {
      const range = document.createRange();
      range.selectNodeContents(document.querySelector('#phrase'));
      getSelection().removeAllRanges();
      getSelection().addRange(range);
    });
    let frame;
    async function openDialog(target = page, tab = tabId) {
      await sw.evaluate((t) => globalThis.__ahkClipperTest.openDialog(t), tab);
      await target.waitForSelector(DIALOG, { timeout: 5000 });
      frame = await target.waitForFrame((f) => f.url().endsWith('/dialog.html'), { timeout: 5000 });
      await frame.waitForFunction(() => document.querySelector('#file').options.length > 0 || !document.querySelector('#banner').hidden, { timeout: 5000 });
      // Wait until the iframe has grown to fit the dialog, so clicks land where they aim.
      await waitFor(async () => {
        const card = await frame.$eval('#card', (el) => el.getBoundingClientRect().height);
        const box = await target.$eval(DIALOG, (el) => el.getBoundingClientRect().height);
        return Math.abs(card - box) < 2;
      }, 3000);
      return frame;
    }
    const dialogGone = (target = page, timeout = 4500) => waitFor(() => target.$(DIALOG).then((el) => el === null), timeout);
    const toastText = () => waitFor(() => frame.$eval('#toast', (el) => (el.hidden ? '' : el.querySelector('#toast-text').textContent)).catch(() => ''), 3000);
    const closeToast = async (target = page) => {
      try {
        await frame.click('#toast-close');
      } catch {
        // The toast already closed itself.
      }
      await dialogGone(target);
    };
    const chips = () => frame.$$eval('#options input', (els) => els.filter((i) => i.checked).map((i) => i.name).join());
    const conflict = () => frame.$eval('#conflict', (el) => (el.hidden ? '' : `${el.dataset.kind}: ${el.querySelector('#conflict-text').textContent}`));
    const value = (selector) => frame.$eval(selector, (el) => el.value);
    const retype = async (selector, text) => {
      await frame.$eval(selector, (el) => el.select());
      await frame.type(selector, text);
    };

    // 1. Select a phrase, open the dialog, take the suggested ;brb.
    await selectPhrase();
    await openDialog();
    const box = await page.$eval(DIALOG, (el) => el.getBoundingClientRect().toJSON());
    const phrase = await page.$eval('#phrase', (el) => el.getBoundingClientRect().toJSON());
    // Aligned with the selection, but never closer than 12 px to the viewport edge.
    check('the dialog opens just below the selection', box.top >= phrase.bottom && box.top - phrase.bottom < 20 && Math.abs(box.left - Math.max(phrase.left, 12)) < 1,
      `dialog at ${box.left},${box.top}; selection at ${phrase.left},${phrase.bottom}`);
    check('the selection is prefilled as the replacement', (await value('#text')) === 'be right back');
    const fileOptions = await frame.$$eval('#file option', (els) => els.map((o) => o.value).join());
    check('General.ahk is offered, not Main.ahk, plus New file…', fileOptions === 'General.ahk,*new*', fileOptions);
    const suggestion = await waitFor(() => frame.evaluate(() => {
      const t = document.querySelector('#trigger');
      return document.hasFocus() && document.activeElement === t && t.selectionStart === 0 && t.selectionEnd === t.value.length && t.value;
    }), 2000);
    check('the trigger field has focus, with the suggestion ;brb selected', suggestion === ';brb', suggestion);
    check('the option chips start from the Settings defaults', (await chips()) === 'immediate', await chips());
    for (let i = 0; i < 3; i++) await page.keyboard.press('Tab');
    const tabbed = await frame.evaluate(() => document.activeElement?.getAttribute('name') ?? document.activeElement?.id);
    check('Tab goes trigger, replacement, file, then the options', tabbed === 'immediate', tabbed);
    check('the source comment is unticked by default', !(await frame.$eval('#with-comment', (el) => el.checked)));
    const preview = await frame.$eval('#preview', (el) => el.textContent);
    check('the preview shows the exact line', preview === ':*T:;brb::be right back ; hsc:\u2026\u2026', preview);
    check('the page can\'t read inside the dialog', await page.evaluate(() => document.querySelector('iframe').contentDocument === null));
    const src = await page.$eval(DIALOG, (el) => el.src);
    check('the dialog URL is per-session, not the extension ID', src.startsWith('chrome-extension://') && !src.includes(id), src);

    await frame.focus('#trigger');
    await page.keyboard.press('Enter');
    const general = await waitFor(() => /;brb::/.test(read('General.ahk')) && read('General.ahk'));
    check('Enter writes the line to General.ahk, expanding instantly (*)', /\r\n:\*T:;brb::be right back ; hsc:[a-z2-9]{6}\r\n$/.test(general || ''), JSON.stringify((general || '').slice(-60)));
    const log = calls();
    check('AutoHotkey validates, then restarts Main.ahk', log.length === 2 && /^\/ErrorStdOut=UTF-8 \/Validate .*\/Main\.ahk$/.test(log[0]) && /^\/ErrorStdOut=UTF-8 \/restart .*\/Main\.ahk$/.test(log[1]), log.join(' | '));
    check('a toast confirms the save', (await toastText()) === 'Saved ;brb to General.ahk, reloaded.', await toastText());
    await sleep(200);
    const toastBox = await page.$eval(DIALOG, (el) => el.getBoundingClientRect().toJSON());
    const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
    check('the toast sits in the bottom-right corner', Math.abs(viewport.width - toastBox.right - 16) < 2 && Math.abs(viewport.height - toastBox.bottom - 16) < 2,
      `toast ${toastBox.right},${toastBox.bottom} in ${viewport.width}x${viewport.height}`);
    check('focus and selection go back to the page', await page.evaluate(() => !document.querySelector('iframe')?.matches(':focus') && getSelection().toString() === 'be right back'));
    check('the toast closes itself', await dialogGone());

    // 2. Text selected in an input; AutoHotkey rejects the script; Esc.
    await page.evaluate(() => {
      const field = document.querySelector('#field');
      field.focus();
      field.setSelectionRange(0, 5);
    });
    await openDialog();
    check('text selected in an input is captured', (await value('#text')) === 'hello');
    writeFileSync(join(ahkDir, 'fail-validate'), '');
    const before = read('General.ahk');
    await retype('#trigger', ';hel');
    await page.keyboard.press('Enter');
    const banner = await waitFor(() => frame.$eval('#banner', (el) => (el.hidden ? '' : el.textContent)), 4000);
    check('a failed validation shows AutoHotkey\'s message', /can't load Main\.ahk, so nothing was saved[\s\S]*does not contain a recognized action/.test(banner || ''), banner);
    check('a script error doesn\'t offer Settings as the fix', await frame.$eval('#open-settings', (el) => el.hidden));
    check('the file is left exactly as it was', read('General.ahk') === before);
    check('the dialog stays open with the trigger kept', (await value('#trigger')) === ';hel');
    check('AutoHotkey isn\'t restarted after a failed validation', calls().filter((c) => c.includes('/restart')).length === 1);
    rmSync(join(ahkDir, 'fail-validate'));
    await page.keyboard.press('Escape');
    check('Esc closes the dialog', await dialogGone());
    check('focus and the selection go back to the input', await page.evaluate(() => {
      const field = document.querySelector('#field');
      return document.activeElement === field && field.selectionStart === 0 && field.selectionEnd === 5;
    }));

    // 3. A category Main.ahk doesn't include yet; Instant unticked for one hotstring.
    writeFileSync(join(folder, 'Email.ahk'), '; Email hotstrings\r\n');
    await selectPhrase();
    await openDialog();
    const avoided = await value('#trigger');
    check('the suggestion steers clear of the Instant ;brb', avoided === ';berb', avoided);
    await frame.select('#file', 'Email.ahk');
    await frame.click('label.chip:has(input[name="immediate"])');
    check('clicking the Instant chip unticks it', (await chips()) === '', await chips());
    await retype('#trigger', ';ty');
    await page.keyboard.press('Enter');
    await waitFor(() => read('Email.ahk').includes(';ty::'));
    check('saving to a new category adds its #Include to Main.ahk', read('Main.ahk').includes('#Include "Email.ahk"'));
    check('unticking Instant for one hotstring writes a plain :T: line', read('Email.ahk').includes('\r\n:T:;ty::be right back ; hsc:'), JSON.stringify(read('Email.ahk').slice(-50)));
    check('the toast mentions the new #Include', /Main\.ahk now includes Email\.ahk/.test(await toastText()), await toastText());
    await closeToast();

    // 4. New defaults in Settings reach the dialog.
    await options.bringToFront();
    await options.click('#default-options input[name="immediate"]');
    await options.click('#default-options input[name="caseSensitive"]');
    await waitFor(() => sw.evaluate(async () => (await chrome.storage.local.get('settings')).settings?.defaultOptions?.caseSensitive === true));
    await page.bringToFront();
    await selectPhrase();
    await openDialog();
    check('changed defaults in Settings are pre-ticked in the dialog', (await chips()) === 'caseSensitive', await chips());

    // 5. A duplicate: Enter refuses, Rename selects the trigger, Replace swaps the line.
    await retype('#trigger', ';brb');
    const duplicate = await conflict();
    check('an existing trigger shows the duplicate notice', duplicate === 'duplicate: ;brb is already in General.ahk: be right back', duplicate);
    const generalBefore = read('General.ahk');
    await page.keyboard.press('Enter');
    await sleep(400);
    check('Enter doesn\'t save a duplicate', read('General.ahk') === generalBefore && (await frame.$eval('#toast', (el) => el.hidden)));
    await frame.click('#rename');
    check('Rename selects the trigger', await frame.evaluate(() => {
      const t = document.querySelector('#trigger');
      return document.activeElement === t && t.selectionStart === 0 && t.selectionEnd === t.value.length;
    }));
    await frame.click('#replace');
    await waitFor(() => read('General.ahk') !== generalBefore);
    const replaced = read('General.ahk');
    check('Replace swaps the line in place', (replaced.match(/;brb::/g) ?? []).length === 1 && /\r\n:CT:;brb::be right back ; hsc:[a-z2-9]{6}\r\n$/.test(replaced), JSON.stringify(replaced.slice(-60)));
    check('the toast says it replaced the old one', /It replaced the old one\./.test(await toastText()), await toastText());

    // 6. Undo puts the replaced line back exactly.
    const restartsBeforeUndo = calls().filter((c) => c.includes('/restart')).length;
    await frame.click('#undo');
    await waitFor(() => read('General.ahk') === generalBefore);
    check('Undo restores the file byte for byte', read('General.ahk') === generalBefore);
    const undone = await waitFor(() => frame.$eval('#toast-text', (el) => (/Undone/.test(el.textContent) ? el.textContent : '')).catch(() => ''));
    check('the toast confirms the undo', undone === 'Undone. General.ahk is back as it was.', undone);
    check('Undo reloads AutoHotkey too', calls().filter((c) => c.includes('/restart')).length === restartsBeforeUndo + 1);
    check('the toast closes itself after Undo', await dialogGone());

    // 7. An Instant trigger that is the start of an existing one is warned about.
    await selectPhrase();
    await openDialog();
    await frame.click('label.chip:has(input[name="immediate"])');
    await retype('#trigger', ';br');
    const shadow = await conflict();
    check('an Instant prefix clash is a warning, without Replace', shadow === 'warning: Instant ;br would fire before ;brb (General.ahk) could be typed.' && (await frame.$eval('#replace', (el) => el.hidden)), shadow);
    await page.keyboard.press('Escape');
    await dialogGone();

    // 8. New file…, then save into it.
    await selectPhrase();
    await openDialog();
    await frame.select('#file', '*new*');
    const nameFocused = await waitFor(() => frame.evaluate(() => !document.querySelector('#new-file').hidden && document.activeElement?.id === 'new-file-name'), 1000);
    check('New file… asks for a name', nameFocused);
    await frame.type('#new-file-name', 'Support');
    await page.keyboard.press('Enter');
    await waitFor(() => frame.$eval('#file', (el) => el.value === 'Support.ahk'));
    check('New file… creates the file with a header and includes it in Main.ahk',
      read('Support.ahk').startsWith('#Requires AutoHotkey v2.0') && read('Main.ahk').includes('#Include "Support.ahk"') && (await value('#file')) === 'Support.ahk',
      await frame.$eval('#file-hint', (el) => el.textContent));
    await retype('#trigger', ';sup');
    await page.keyboard.press('Enter');
    check('a hotstring saves into the new file', Boolean(await waitFor(() => read('Support.ahk').includes(';sup::be right back'))));
    await closeToast();

    // 9. The source comment, and the preview matching the file exactly.
    await selectPhrase();
    await openDialog();
    check('the dialog remembers the last file used', (await value('#file')) === 'Support.ahk');
    await frame.select('#file', 'General.ahk');
    await frame.click('#with-comment');
    await retype('#trigger', ';src');
    const previewLines = (await frame.$eval('#preview', (el) => el.textContent)).split('\n');
    await page.keyboard.press('Enter');
    await waitFor(() => read('General.ahk').includes(';src::'));
    const written = lastLines('General.ahk', 2);
    check('the source comment names the page', /^; from Test page, http:\/\/127\.0\.0\.1:\d+\/page, \d{4}-\d{2}-\d{2}$/.test(written[0]), written[0]);
    check('the preview is exactly what was written', previewLines.length === 2 && previewLines[0] === written[0] && written[1].startsWith(previewLines[1].replace(' ; hsc:\u2026\u2026', ' ; hsc:')),
      JSON.stringify({ previewLines, written }));
    await closeToast();

    // 10. No selection: the paste hint, with the caret in the replacement.
    await page.evaluate(() => {
      getSelection().removeAllRanges();
      document.activeElement?.blur();
    });
    await openDialog();
    const hint = await frame.$eval('#text-hint', (el) => el.textContent);
    check('an empty selection gets the paste hint', hint === 'No selected text came through. Type or paste the replacement here.', hint);
    check('the caret goes to the replacement', Boolean(await waitFor(() => frame.evaluate(() => document.activeElement?.id === 'text'), 1500)));
    await page.keyboard.press('Escape');
    await dialogGone();

    // 11. A contenteditable editor, as in Gmail or Notion.
    const { p: editable, tab: editableTab } = await openPage('/editable');
    await editable.evaluate(() => {
      const editor = document.querySelector('#editor');
      editor.focus();
      const range = document.createRange();
      range.setStart(editor.firstChild, 0);
      range.setEnd(editor.firstChild, 12);
      getSelection().removeAllRanges();
      getSelection().addRange(range);
    });
    await openDialog(editable, editableTab);
    check('text selected in a contenteditable editor is captured', (await value('#text')) === 'Kind regards');
    await frame.focus('#trigger');
    await editable.keyboard.press('Enter');
    check('it saves with the suggested trigger', Boolean(await waitFor(() => read('General.ahk').includes(':CT:;kr::Kind regards'))));
    check('focus and the selection go back to the editor', Boolean(await waitFor(() => editable.evaluate(() =>
      document.activeElement === document.querySelector('#editor') && getSelection().toString() === 'Kind regards'), 2000)));
    await closeToast(editable);
    check('the editor page received no postMessage traffic', (await editable.evaluate(() => window.messages)) === 0);
    await editable.close();

    // 12. A folder that no longer exists.
    await page.bringToFront();
    await sw.evaluate(async (missing) => {
      const { settings } = await chrome.storage.local.get('settings');
      await chrome.storage.local.set({ settings: { ...settings, folder: missing } });
    }, join(work, 'gone'));
    await selectPhrase();
    await openDialog();
    const missing = await frame.$eval('#banner', (el) => el.textContent);
    check('a missing folder is explained, with a way to Settings', /doesn't exist/.test(missing) && (await frame.$eval('#open-settings', (el) => !el.hidden)), missing);
    check('the selection is still shown', (await value('#text')) === 'be right back');
    await page.keyboard.press('Escape');
    await dialogGone();
    await sw.evaluate(async (f) => {
      const { settings } = await chrome.storage.local.get('settings');
      await chrome.storage.local.set({ settings: { ...settings, folder: f } });
    }, folder);

    // 13. A page with a strict Content Security Policy.
    const { p: strict, tab: strictTab } = await openPage('/strict');
    await selectPhrase(strict);
    const strictFrame = await openDialog(strict, strictTab).catch(() => null);
    check('the dialog loads on a page with a strict CSP', strictFrame !== null && (await value('#text')) === 'be right back');
    await strict.close();

    // Privacy across all of the above.
    check('the page received no postMessage traffic', (await page.evaluate(() => window.messages)) === 0);
    const remote = extensionRequests.filter((url) => !url.startsWith('chrome-extension://'));
    check('the extension made no http(s) or ws requests', remote.length === 0, remote.join(', '));
    const strays = hits.filter((h) => !['/page', '/editable', '/strict', '/favicon.ico'].includes(h));
    check('the server saw only the test pages', strays.length === 0, strays.join(', '));
  } finally {
    await browser.close();
    close();
    profile.cleanup();
    await sleep(100);
    rmSync(work, { recursive: true, force: true });
  }
}
