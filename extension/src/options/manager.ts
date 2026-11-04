// The Hotstrings tab: every hotstring in the folder, with search, a file
// filter, edit, delete and CSV export and import. All file work goes through
// the service worker to the native host; nothing here touches the network.
import { createOptionChips } from '../chips.ts';
import { sameTrigger } from '../conflicts.ts';
import { toCsv } from '../csv.ts';
import { isoDate, optionLetters, parseOptionLetters, toHotstring } from '../hotstring.ts';
import { exportRows, planImport, type ImportPlan } from '../importer.ts';
import { previewText } from '../preview.ts';
import type { DeleteReply, ErrorReply, ExtensionMessage, ImportReply, ManagerScanReply, SaveReply, ScannedHotstring } from '../protocol.ts';

const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const search = byId<HTMLInputElement>('search');
const fileFilter = byId<HTMLSelectElement>('file-filter');
const status = byId<HTMLParagraphElement>('list-status');
const rows = byId<HTMLTableSectionElement>('hotstring-rows');
const table = byId<HTMLTableElement>('hotstrings');
const importFile = byId<HTMLInputElement>('import-file');
const importPanel = byId<HTMLElement>('import-panel');
const importName = byId<HTMLElement>('import-name');
const importSummary = byId<HTMLParagraphElement>('import-summary');
const importDefault = byId<HTMLSelectElement>('import-default');
const importRows = byId<HTMLTableSectionElement>('import-rows');
const importRun = byId<HTMLButtonElement>('import-run');

const send = <T>(message: ExtensionMessage): Promise<T> => chrome.runtime.sendMessage(message);

let data: ManagerScanReply | null = null;
let duplicates = new Set<ScannedHotstring>();
let importText = '';
let importPlan: ImportPlan | null = null;

search.addEventListener('input', render);
fileFilter.addEventListener('change', render);
byId('refresh').addEventListener('click', () => void load());
byId('export').addEventListener('click', exportCsv);
byId('import').addEventListener('click', () => importFile.click());
importFile.addEventListener('change', () => void readImport());
importDefault.addEventListener('change', planCurrentImport);
importRun.addEventListener('click', () => void runImport());
byId('import-cancel').addEventListener('click', closeImport);

/** Reloads the list whenever its tab is shown, so Settings changes show up. */
export function showHotstrings(): void {
  void load();
}

async function load(message = ''): Promise<void> {
  setStatus('Loading…');
  const reply = await send<ManagerScanReply | ErrorReply>({ type: 'manager.scan' });
  if (!reply.ok) {
    data = null;
    rows.replaceChildren();
    table.hidden = true;
    setStatus(reply.error.message, 'error');
    return;
  }
  data = reply;
  duplicates = findDuplicates(reply.hotstrings);
  const selected = fileFilter.value;
  fileFilter.replaceChildren(new Option('All files', ''), ...reply.files.map((f) => new Option(f, f)));
  fileFilter.value = reply.files.includes(selected) ? selected : '';
  render(message);
}

/** Triggers that appear more than once, as AutoHotkey would match them. */
function findDuplicates(hotstrings: ScannedHotstring[]): Set<ScannedHotstring> {
  const groups = new Map<string, ScannedHotstring[]>();
  for (const h of hotstrings) groups.set(h.trigger.toLowerCase(), [...(groups.get(h.trigger.toLowerCase()) ?? []), h]);
  const found = new Set<ScannedHotstring>();
  for (const group of groups.values()) {
    for (const a of group) {
      if (group.some((b) => b !== a && sameTrigger(a.trigger, a.caseSensitive, b.trigger, b.caseSensitive))) found.add(a);
    }
  }
  return found;
}

function render(message: unknown = ''): void {
  if (!data) return;
  const query = search.value.trim().toLowerCase();
  const file = fileFilter.value;
  const shown = data.hotstrings.filter((h) =>
    (!file || h.file === file) && (!query || `${h.trigger}\n${h.text}\n${h.file}`.toLowerCase().includes(query)));
  rows.replaceChildren(...shown.map(row));
  table.hidden = data.hotstrings.length === 0;

  const total = data.hotstrings.length;
  const fileCount = new Set(data.hotstrings.map((h) => h.file)).size;
  const lines = [
    typeof message === 'string' && message ? message : '',
    total === 0
      ? `No hotstrings in ${data.folder} yet. Add one by selecting text on a page and pressing the shortcut.`
      : `${shown.length === total ? '' : `Showing ${shown.length} of `}${total} hotstring${total === 1 ? '' : 's'} in ${fileCount} file${fileCount === 1 ? '' : 's'}.`,
    duplicates.size > 0 ? `${duplicates.size} share a trigger with another hotstring; only one of each can work.` : '',
    data.skipped.length > 0 ? `Not read (not UTF-8): ${data.skipped.join(', ')}.` : '',
  ];
  setStatus(lines.filter(Boolean).join('\n'));
}

function row(h: ScannedHotstring): HTMLTableRowElement {
  const tr = document.createElement('tr');
  tr.dataset.key = keyOf(h);
  const trigger = cell('trigger');
  const code = document.createElement('code');
  code.textContent = h.trigger;
  trigger.append(code);
  if (duplicates.has(h)) {
    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.textContent = 'duplicate';
    badge.title = 'Another hotstring has the same trigger.';
    trigger.append(badge);
  }
  const text = cell(h.kind === 'code' ? 'text code' : 'text');
  text.textContent = h.kind === 'code' ? `runs code: ${previewText(h.text, 80)}` : previewText(h.text, 90);
  text.title = h.text;
  const options = parseOptionLetters(h.options);
  const optionsCell = cell('options');
  optionsCell.textContent = options ? optionLetters(options) : h.options;
  const fileCell = cell('file');
  fileCell.textContent = h.file;
  const actions = cell('actions');
  if (h.editable) actions.append(button('Edit', () => edit(h)));
  actions.append(button('Delete', () => confirmDelete(h)));
  tr.append(trigger, text, optionsCell, fileCell, actions);
  return tr;
}

const keyOf = (h: ScannedHotstring) => `${h.file}:${h.line}`;

/** Re-renders to close any open editor or confirmation, then finds the hotstring's row again. */
function freshRow(h: ScannedHotstring): HTMLTableRowElement | null {
  if (rows.querySelector('.editor, .confirm')) render();
  return rows.querySelector<HTMLTableRowElement>(`tr[data-key="${CSS.escape(keyOf(h))}"]`);
}

function cell(className: string): HTMLTableCellElement {
  const td = document.createElement('td');
  td.className = className;
  return td;
}

function button(label: string, onClick: () => void, className = ''): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = label;
  if (className) b.className = className;
  b.addEventListener('click', onClick);
  return b;
}

function confirmDelete(h: ScannedHotstring): void {
  const tr = freshRow(h);
  if (!tr) return;
  const actions = tr.querySelector<HTMLTableCellElement>('td.actions')!;
  const confirm = document.createElement('span');
  confirm.className = 'confirm';
  confirm.textContent = 'Delete it?';
  const yes = button('Delete', async () => {
    yes.disabled = true;
    const reply = await send<DeleteReply | ErrorReply>({ type: 'manager.delete', target: { file: h.file, line: h.line, hash: h.hash } });
    if (reply.ok) await load(`Deleted ${h.trigger} from ${h.file}.`);
    else setStatus(reply.error.message, 'error');
  }, 'danger');
  const no = button('Cancel', () => render());
  confirm.append(yes, no);
  actions.replaceChildren(confirm);
  no.focus();
}

/** Turns a row into an editor. Saving replaces the hotstring in place, or moves it to another file. */
function edit(h: ScannedHotstring): void {
  const tr = freshRow(h);
  if (!tr) return;
  const td = document.createElement('td');
  td.colSpan = 5;
  const form = document.createElement('div');
  form.className = 'editor';

  const trigger = input('text', h.trigger);
  const text = document.createElement('textarea');
  text.value = h.text;
  const file = document.createElement('select');
  const targets = data!.files.filter((f) => f.toLowerCase() !== data!.mainScript.toLowerCase() || f === h.file);
  file.replaceChildren(...targets.map((f) => new Option(f, f, f === h.file, f === h.file)));
  const chipsBox = document.createElement('div');
  chipsBox.className = 'chips';
  const preview = document.createElement('pre');
  preview.className = 'editor-preview';
  const error = document.createElement('p');
  error.className = 'editor-error';
  error.setAttribute('role', 'alert');
  const update = () => {
    const result = toHotstring(trigger.value, text.value, chips.read());
    preview.textContent = result.ok ? result.line : '';
    error.textContent = result.ok ? '' : result.errors.join(' ');
  };
  const chips = createOptionChips(chipsBox, update);
  chips.set(parseOptionLetters(h.options) ?? { immediate: h.instant, insideWord: false, caseSensitive: h.caseSensitive, keepTrigger: false, omitEndChar: false });
  trigger.addEventListener('input', update);
  text.addEventListener('input', update);

  const save = button('Save', async () => {
    save.disabled = true;
    const reply = await send<SaveReply | ErrorReply>({
      type: 'manager.save',
      trigger: trigger.value,
      text: text.value,
      file: file.value,
      options: chips.read(),
      replace: { file: h.file, line: h.line, hash: h.hash },
    });
    save.disabled = false;
    if (reply.ok) await load(file.value === h.file ? `Saved ${trigger.value}.` : `Moved ${trigger.value} to ${file.value}.`);
    else error.textContent = reply.error.message;
  }, 'primary');
  const cancel = button('Cancel', () => render());
  const actions = document.createElement('div');
  actions.className = 'editor-actions';
  actions.append(save, cancel);

  form.append(
    label('Trigger', trigger), trigger,
    label('Replacement', text), text,
    label('File', file), file,
    label('Options', chipsBox), chipsBox,
    preview, error, actions,
  );
  form.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      render();
    } else if (event.key === 'Enter' && (event.target !== text || event.ctrlKey || event.metaKey) && !(event.target instanceof HTMLButtonElement)) {
      event.preventDefault();
      save.click();
    }
  });
  td.append(form);
  tr.replaceChildren(td);
  update();
  trigger.focus();
}

function input(type: string, value: string): HTMLInputElement {
  const i = document.createElement('input');
  i.type = type;
  i.value = value;
  i.spellcheck = false;
  i.autocomplete = 'off';
  return i;
}

let labelCount = 0;
function label(text: string, control: HTMLElement): HTMLLabelElement {
  control.id ||= `editor-field-${++labelCount}`;
  const l = document.createElement('label');
  l.htmlFor = control.id;
  l.textContent = text;
  return l;
}

function exportCsv(): void {
  if (!data || data.hotstrings.length === 0) {
    setStatus('There are no hotstrings to export yet.');
    return;
  }
  const blob = new Blob([toCsv(exportRows(data.hotstrings))], { type: 'text/csv;charset=utf-8' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = `hotstrings-${isoDate(new Date())}.csv`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 10_000);
  setStatus(`Exported ${data.hotstrings.length} hotstrings to ${link.download}.`);
}

async function readImport(): Promise<void> {
  const chosen = importFile.files?.[0];
  importFile.value = '';
  if (!chosen || !data) return;
  importText = await chosen.text();
  importName.textContent = chosen.name;
  const targets = data.files.filter((f) => f.toLowerCase() !== data!.mainScript.toLowerCase());
  // The file last saved to, else General.ahk, else the first.
  const preferred = [data.lastFile, 'General.ahk'].find((f) => targets.includes(f)) ?? targets[0];
  importDefault.replaceChildren(...targets.map((f) => new Option(f, f, f === preferred, f === preferred)));
  importPanel.hidden = false;
  planCurrentImport();
}

const STATUS_TEXT = { new: 'Add', exists: 'Skip', repeat: 'Skip', invalid: "Can't import", code: 'Skip' } as const;

function planCurrentImport(): void {
  if (!data) return;
  importPlan = planImport(importText, { defaultFile: importDefault.value, files: data.files, hotstrings: data.hotstrings });
  if (importPlan.error) {
    importSummary.textContent = importPlan.error;
    importRows.replaceChildren();
    importRun.hidden = true;
    return;
  }
  const count = (s: string) => importPlan!.rows.filter((r) => r.status === s).length;
  const adding = count('new');
  const skipping = count('exists') + count('repeat') + count('code');
  importSummary.textContent = [
    `${adding} to add`,
    skipping ? `${skipping} skipped because the trigger already exists or the row runs code` : '',
    count('invalid') ? `${count('invalid')} can't be imported` : '',
    importPlan.newFiles.length ? `new file${importPlan.newFiles.length === 1 ? '' : 's'}: ${importPlan.newFiles.join(', ')}` : '',
  ].filter(Boolean).join('; ') + '.';
  importRows.replaceChildren(...importPlan.rows.map((r) => {
    const tr = document.createElement('tr');
    const result = cell('');
    result.dataset.status = r.status;
    result.textContent = r.detail ? `${STATUS_TEXT[r.status]}: ${r.detail}` : STATUS_TEXT[r.status];
    const [n, t, f] = [cell(''), cell(''), cell('')];
    n.textContent = String(r.row);
    t.textContent = r.trigger;
    f.textContent = r.file;
    tr.append(n, t, f, result);
    return tr;
  }));
  importRun.hidden = false;
  importRun.disabled = adding === 0;
  importRun.textContent = `Import ${adding} hotstring${adding === 1 ? '' : 's'}`;
}

async function runImport(): Promise<void> {
  if (!importPlan) return;
  const toAdd = importPlan.rows.filter((r) => r.status === 'new');
  importRun.disabled = true;
  if (importPlan.newFiles.length > 0) {
    const created = await send<{ ok: true } | ErrorReply>({ type: 'manager.createFiles', names: importPlan.newFiles });
    if (!created.ok) {
      importSummary.textContent = created.error.message;
      importRun.disabled = false;
      return;
    }
  }
  const reply = await send<ImportReply | ErrorReply>({ type: 'manager.import', entries: toAdd.map((r) => ({ file: r.file, line: r.line })) });
  if (!reply.ok) {
    importSummary.textContent = reply.error.message;
    importRun.disabled = false;
    return;
  }
  closeImport();
  const skipped = reply.skipped.map((s) => `${toAdd[s.index]?.trigger}: ${s.reason}`);
  await load(`Imported ${reply.added} hotstring${reply.added === 1 ? '' : 's'}.${skipped.length ? ` Skipped at save time: ${skipped.join('; ')}.` : ''}`);
}

function closeImport(): void {
  importPanel.hidden = true;
  importPlan = null;
  importText = '';
}

function setStatus(text: string, state: 'ok' | 'error' = 'ok'): void {
  status.textContent = text;
  status.dataset.state = state;
}
