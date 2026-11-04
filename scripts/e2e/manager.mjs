// The Hotstrings tab end to end, against the e2e build with the Linux host
// and the fake AutoHotkey: the list, search and filter, duplicate badges,
// edit (keeping the source comment), moving between files, delete, CSV export
// and import, an export → import round trip, and the toolbar icon.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { check, FAKE_AHK, id, launch, makeProfile, root, serviceWorker, sleep, waitFor } from './lib.mjs';

const GENERAL = [
  '#Requires AutoHotkey v2.0',
  '',
  '; --- Added by Hotstring Clipper ---',
  '; from Page, https://example.com, 2026-11-01',
  ':*T:;brb::be right back ; hsc:aaaaaa',
  ':T:;ty::thank you ; hsc:bbbbbb',
  '::btw::by the way',
  ':X:;run::Run("notepad")',
  ':X:;sig::SendText("Best regards,`nJane" A_EndChar) ; hsc:cccccc',
  '',
].join('\r\n');

export async function managerSuite() {
  console.log('\nHotstring list (.e2e/dist)');
  const work = realpathSync(mkdtempSync(join(tmpdir(), 'ahk-clipper-list-')));
  const folder = join(work, 'Hotstrings');
  const ahkDir = join(work, 'ahk');
  const downloads = join(work, 'downloads');
  for (const dir of [folder, ahkDir, downloads]) mkdirSync(dir);
  const ahkPath = join(ahkDir, 'AutoHotkey64.exe');
  writeFileSync(ahkPath, FAKE_AHK, { mode: 0o755 });
  writeFileSync(join(folder, 'Main.ahk'), '#Requires AutoHotkey v2.0\r\n#Include "General.ahk"\r\n#Include "Email.ahk"\r\n');
  writeFileSync(join(folder, 'General.ahk'), GENERAL);
  writeFileSync(join(folder, 'Email.ahk'), ':T:;TY::Thanks again ; hsc:dddddd\r\n');
  writeFileSync(join(folder, 'Chat.ahk'), '; Chat\r\n');
  const read = (name, dir = folder) => (existsSync(join(dir, name)) ? readFileSync(join(dir, name), 'utf8') : '');
  const calls = () => (existsSync(join(ahkDir, 'calls.log')) ? readFileSync(join(ahkDir, 'calls.log'), 'utf8').trim().split('\n') : []);

  const profile = makeProfile();
  profile.registerHost();
  const browser = await launch(root('.e2e/dist'), profile.dir);
  try {
    const worker = await serviceWorker(browser);
    const sw = await worker.worker();
    const remote = [];
    const workerSession = await worker.createCDPSession();
    await workerSession.send('Network.enable');
    workerSession.on('Network.requestWillBeSent', (e) => remote.push(e.request.url));
    const useFolder = (f) => sw.evaluate(async (folderPath, exe) => {
      await chrome.storage.local.set({ settings: { folder: folderPath, ahkPath: exe, reloadMode: 'main', mainScript: 'Main.ahk', lastFile: '' } });
    }, f, ahkPath);
    await useFolder(folder);

    const page = await browser.newPage();
    page.on('request', (r) => remote.push(r.url()));
    const browserSession = await browser.target().createCDPSession();
    await browserSession.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads });
    await page.goto(`chrome-extension://${id}/options.html`);

    const status = () => page.$eval('#list-status', (el) => el.textContent);
    const listed = () => page.$$eval('#hotstring-rows tr', (trs) => trs.map((tr) => tr.querySelector('td.trigger code')?.textContent ?? '(editor)'));
    const rowFor = (trigger) => page.evaluateHandle((t) => [...document.querySelectorAll('#hotstring-rows tr')].find((tr) => tr.querySelector('td.trigger code')?.textContent === t), trigger);
    const clickIn = async (trigger, label) => {
      const tr = await rowFor(trigger);
      const buttons = await tr.$$('button');
      for (const b of buttons) {
        if ((await b.evaluate((el) => el.textContent)) === label) return b.click();
      }
      throw new Error(`no ${label} button for ${trigger}`);
    };
    const waitStatus = (pattern) => waitFor(async () => pattern.test(await status()), 5000);
    // Every text hotstring as file|trigger|text|options, for comparing collections.
    const snapshot = async () => (await page.evaluate(() => chrome.runtime.sendMessage({ type: 'manager.scan' }))).hotstrings
      .filter((h) => h.kind === 'text')
      .map((h) => `${h.file}|${h.trigger}|${h.text}|${[...h.options.replace(/[TtXx]/g, '')].sort().join('')}`)
      .sort();

    // The list.
    check('the list opens on its own once a folder is set up', Boolean(await waitFor(() => page.$eval('#tab-hotstrings', (el) => el.getAttribute('aria-selected') === 'true'))));
    await waitStatus(/hotstrings? in/);
    // Files in name order, hotstrings in file order.
    check('every hotstring in every file is listed', (await listed()).join(' ') === ';TY ;brb ;ty btw ;run ;sig', (await listed()).join(' '));
    check('the count and the duplicate note', /6 hotstrings in 2 files\.\n2 share a trigger/.test(await status()), await status());
    const badges = await page.$$eval('.badge', (els) => els.map((el) => el.closest('tr').querySelector('code').textContent).join(' '));
    check('both copies of a duplicate trigger are badged', badges === ';TY ;ty', badges);
    const sigText = await page.evaluate(() => [...document.querySelectorAll('#hotstring-rows tr')].find((tr) => tr.textContent.includes(';sig')).querySelector('td.text').textContent);
    check('multi-line text shows on one line', sigText === 'Best regards, \u21b5 Jane', sigText);
    const runButtons = await (await rowFor(';run')).$$eval('button', (bs) => bs.map((b) => b.textContent).join(','));
    check('a hotstring that runs code offers Delete only', runButtons === 'Delete', runButtons);

    await page.type('#search', 'regards');
    check('search finds text', (await listed()).join(' ') === ';sig');
    await page.$eval('#search', (el) => { el.value = ''; el.dispatchEvent(new Event('input')); });
    await page.select('#file-filter', 'Email.ahk');
    check('the file filter shows one file', (await listed()).join(' ') === ';TY', (await listed()).join(' '));
    await page.select('#file-filter', '');

    // Edit, keeping the source comment.
    await clickIn(';brb', 'Edit');
    await page.waitForSelector('.editor textarea');
    await page.$eval('.editor textarea', (el) => { el.select(); });
    await page.type('.editor textarea', 'back in five');
    const editorPreview = await page.$eval('.editor-preview', (el) => el.textContent);
    check('the editor previews the line', editorPreview === ':*T:;brb::back in five', editorPreview);
    await page.keyboard.down('Control');
    await page.keyboard.press('Enter');
    await page.keyboard.up('Control');
    await waitStatus(/Saved ;brb\./);
    check('Edit replaces the line in place and keeps its source comment',
      /; from Page, https:\/\/example\.com, 2026-11-01\r\n:\*T:;brb::back in five ; hsc:[a-z2-9]{6}\r\n:T:;ty::thank you/.test(read('General.ahk')), JSON.stringify(read('General.ahk').slice(60, 220)));

    // Editing to an existing trigger is refused.
    await clickIn('btw', 'Edit');
    await page.waitForSelector('.editor input[type="text"]');
    await page.$eval('.editor input[type="text"]', (el) => el.select());
    await page.type('.editor input[type="text"]', ';brb');
    await page.keyboard.press('Enter');
    const editError = await waitFor(() => page.$eval('.editor-error', (el) => el.textContent), 4000);
    check('an edit to an existing trigger is refused', /;brb is already in General\.ahk/.test(editError || ''), editError);
    await page.keyboard.press('Escape');

    // Moving to a file Main.ahk doesn't include yet.
    await clickIn(';sig', 'Edit');
    await page.waitForSelector('.editor select');
    await page.select('.editor select', 'Chat.ahk');
    await page.click('.editor-actions .primary');
    await waitStatus(/Moved ;sig to Chat\.ahk\./);
    check('moving takes the hotstring out of one file and into another', !read('General.ahk').includes(';sig') && /:X:;sig::SendText\("Best regards,`nJane" A_EndChar\) ; hsc:/.test(read('Chat.ahk')));
    check('moving adds the new file\'s #Include', read('Main.ahk').includes('#Include "Chat.ahk"'));

    // Delete.
    const before = calls().length;
    await clickIn(';run', 'Delete');
    await clickIn(';run', 'Delete');
    await waitStatus(/Deleted ;run from General\.ahk\./);
    check('Delete removes the hotstring', !read('General.ahk').includes(';run'));
    check('Delete validates and restarts AutoHotkey', calls().slice(before).join(' | ').match(/\/Validate .*Main\.ahk \| .*\/restart .*Main\.ahk/) !== null, calls().slice(before).join(' | '));

    // Export.
    await page.click('#export');
    const exported = await waitFor(() => readdirSync(downloads).find((f) => /^hotstrings-\d{4}-\d{2}-\d{2}\.csv$/.test(f)), 5000);
    const csv = exported ? read(exported, downloads) : '';
    check('Export downloads hotstrings-<date>.csv', Boolean(exported), readdirSync(downloads).join(', '));
    check('the CSV has a BOM and the expected columns', csv.startsWith('\uFEFFFile,Trigger,Replacement,Options,Type\r\n'), JSON.stringify(csv.slice(0, 50)));
    // Inside a quoted cell a line break is a plain LF, as Excel writes them.
    check('a multi-line replacement is quoted in the CSV', csv.includes('Chat.ahk,;sig,"Best regards,\nJane",,text\r\n'), JSON.stringify(csv));
    const exportedHotstrings = await snapshot();

    // Import.
    const importCsv = join(work, 'import.csv');
    writeFileSync(importCsv, [
      'Trigger,Replacement,File,Options',
      ';new1,first new one,,*',
      ';brb,already here,,',
      ';sup,support reply,Support,',
      ';bad,bad options,,R',
    ].join('\r\n'));
    const importStart = calls().length;
    const fileInput = await page.$('#import-file');
    await fileInput.uploadFile(importCsv);
    await page.waitForSelector('#import-panel:not([hidden])', { timeout: 5000 });
    check('rows without a file default to General.ahk', (await page.$eval('#import-default', (el) => el.value)) === 'General.ahk');
    const summary = await page.$eval('#import-summary', (el) => el.textContent);
    check('the import preview summarises the rows', summary === "2 to add; 1 skipped because the trigger already exists or the row runs code; 1 can't be imported; new file: Support.ahk.", summary);
    const results = await page.$$eval('#import-rows tr', (trs) => trs.map((tr) => tr.lastElementChild.textContent));
    check('each row says what will happen', results[0] === 'Add' && results[1] === 'Skip: Already in General.ahk.' && results[2] === 'Add' && /^Can't import: Options "R"/.test(results[3]), results.join(' | '));
    await page.click('#import-run');
    await waitStatus(/Imported 2 hotstrings\./);
    check('import adds the new rows and creates the new file', /:\*T:;new1::first new one ; hsc:/.test(read('General.ahk')) && /:T:;sup::support reply ; hsc:/.test(read('Support.ahk')) && read('Main.ahk').includes('#Include "Support.ahk"'));
    check('import skips existing triggers', (read('General.ahk').match(/;brb::/g) ?? []).length === 1);
    check('an import restarts AutoHotkey once', calls().slice(importStart).filter((c) => c.includes('/restart')).length === 1, calls().slice(importStart).join(' | '));

    // Export → import into an empty folder gives the same hotstrings.
    const second = join(work, 'Second');
    mkdirSync(second);
    writeFileSync(join(second, 'Main.ahk'), '#Requires AutoHotkey v2.0\r\n');
    writeFileSync(join(second, 'General.ahk'), '');
    await useFolder(second);
    await page.click('#refresh');
    await waitStatus(/No hotstrings/);
    await (await page.$('#import-file')).uploadFile(join(downloads, exported));
    await page.waitForSelector('#import-panel:not([hidden])', { timeout: 5000 });
    await page.click('#import-run');
    await waitStatus(/Imported \d+ hotstrings/);
    const copy = await snapshot();
    // The seeded duplicate pair (;TY and ;ty) comes back once: the import skips
    // the second, since AutoHotkey could only ever use one of them.
    const expected = exportedHotstrings.filter((s) => !s.startsWith('General.ahk|;ty|'));
    check('exporting and importing into an empty folder gives the same hotstrings, minus the duplicate', JSON.stringify(copy) === JSON.stringify(expected),
      JSON.stringify({ copy, expected }));

    // The toolbar icon.
    await page.close();
    await sw.evaluate(() => globalThis.__ahkClipperTest.openList());
    const opened = await waitFor(async () => {
      for (const p of await browser.pages()) {
        if (p.url().startsWith(`chrome-extension://${id}/options.html`) && (await p.$eval('#tab-hotstrings', (el) => el.getAttribute('aria-selected') === 'true').catch(() => false))) return true;
      }
      return false;
    }, 5000);
    check('the toolbar icon opens the hotstring list', Boolean(opened));

    const offsite = remote.filter((url) => !url.startsWith('chrome-extension://') && !url.startsWith('blob:chrome-extension://'));
    check('the list made no http(s) or ws requests', offsite.length === 0, offsite.join(', '));
  } finally {
    await browser.close();
    profile.cleanup();
    await sleep(100);
    rmSync(work, { recursive: true, force: true });
  }
}
