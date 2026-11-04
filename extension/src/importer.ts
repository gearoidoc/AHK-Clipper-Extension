// Turns an imported CSV into hotstring lines, marking each row as new,
// skipped (its trigger already exists) or invalid before anything is written.
// The host checks duplicates again under its lock.
import { findConflicts, sameTrigger } from './conflicts.ts';
import { parseCsv, unguardCell } from './csv.ts';
import { optionLetters, parseOptionLetters, toHotstring, type HotstringOptions } from './hotstring.ts';
import type { ScannedHotstring } from './protocol.ts';

export const CSV_COLUMNS = ['File', 'Trigger', 'Replacement', 'Options', 'Type'] as const;

export type ImportStatus = 'new' | 'exists' | 'repeat' | 'invalid' | 'code';

export interface ImportRow {
  /** The row's number in the spreadsheet, counting the header as row 1. */
  row: number;
  file: string;
  trigger: string;
  text: string;
  options: HotstringOptions;
  line: string;
  status: ImportStatus;
  /** Why it's skipped or invalid; empty for new rows. */
  detail: string;
}

export interface ImportPlan {
  rows: ImportRow[];
  /** Files that rows to add name but that aren't in the folder yet. */
  newFiles: string[];
  /** Set when the CSV can't be used at all. */
  error: string;
}

export interface ImportContext {
  /** Used for rows without a File. */
  defaultFile: string;
  files: string[];
  hotstrings: readonly ScannedHotstring[];
}

const BAD_CHARS = /[<>:"/\\|?*\x00-\x1f]/;
const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;
const MAX_NAME = 100;

/** Why the host would refuse this .ahk file name (host/paths.go checkName), or ''. */
export function fileNameProblem(name: string): string {
  const stem = name.replace(/\.ahk$/i, '');
  if (!/\.ahk$/i.test(name) || stem === '') return `"${name}" isn't an .ahk file name.`;
  // The host counts bytes of UTF-8, so accented names reach the limit sooner.
  if (new TextEncoder().encode(name).length > MAX_NAME) return `File names can be at most ${MAX_NAME} characters.`;
  if (BAD_CHARS.test(name)) return 'File names can\'t contain \\ / : * ? " < > | or control characters.';
  if (/^[. ]/.test(name) || /[. ]$/.test(stem)) return "File names can't start with a dot or a space, or end with one before .ahk.";
  if (RESERVED.test(stem.split('.')[0]!)) return `"${name}" is a reserved name on Windows.`;
  return '';
}

/** The rows of an export: one per hotstring, with the columns in CSV_COLUMNS. */
export function exportRows(hotstrings: readonly ScannedHotstring[]): string[][] {
  return [
    [...CSV_COLUMNS],
    ...hotstrings.map((h) => {
      const options = parseOptionLetters(h.options);
      return [h.file, h.trigger, h.text, options ? optionLetters(options) : h.options, h.kind];
    }),
  ];
}

export function planImport(csvText: string, context: ImportContext): ImportPlan {
  const plan: ImportPlan = { rows: [], newFiles: [], error: '' };
  const [header, ...data] = parseCsv(csvText);
  if (!header) {
    plan.error = 'The file is empty.';
    return plan;
  }
  const column = (name: string) => header.findIndex((h) => h.trim().toLowerCase() === name.toLowerCase());
  const columns = { file: column('File'), trigger: column('Trigger'), replacement: column('Replacement'), options: column('Options'), type: column('Type') };
  if (columns.trigger < 0 || columns.replacement < 0) {
    plan.error = 'The first row must name the columns: Trigger and Replacement, plus File, Options and Type if you have them.';
    return plan;
  }

  // Windows file names ignore case, so "general" means the existing General.ahk
  // and "Work" and "work" are one new file.
  const byLowerName = new Map(context.files.map((f) => [f.toLowerCase(), f]));
  const known = new Set(byLowerName.keys());
  const accepted: ImportRow[] = [];
  data.forEach((cells, i) => {
    const cell = (index: number) => (index >= 0 ? unguardCell(cells[index] ?? '') : '');
    let file = cell(columns.file).trim() || context.defaultFile;
    if (file && !/\.ahk$/i.test(file)) file += '.ahk';
    file = byLowerName.get(file.toLowerCase()) ?? file;
    const row: ImportRow = {
      row: i + 2,
      file,
      trigger: cell(columns.trigger),
      text: cell(columns.replacement),
      options: { immediate: false, insideWord: false, caseSensitive: false, keepTrigger: false, omitEndChar: false },
      line: '',
      status: 'new',
      detail: '',
    };
    plan.rows.push(row);

    const options = parseOptionLetters(cell(columns.options).trim());
    if (cell(columns.type).trim().toLowerCase() === 'code') {
      row.status = 'code';
      row.detail = 'Runs code, so it can only be added by hand.';
      return;
    }
    const nameProblem = file ? fileNameProblem(file) : 'No file given, and no default file chosen.';
    if (nameProblem) {
      row.status = 'invalid';
      row.detail = nameProblem;
      return;
    }
    if (!options) {
      row.status = 'invalid';
      row.detail = `Options "${cell(columns.options).trim()}" include something other than * ? C B0 O.`;
      return;
    }
    row.options = options;
    const result = toHotstring(row.trigger, row.text, options);
    if (!result.ok) {
      row.status = 'invalid';
      row.detail = result.errors.join(' ');
      return;
    }
    row.line = result.line;
    const existing = findConflicts(row.trigger, options, context.hotstrings).duplicate;
    if (existing) {
      row.status = 'exists';
      row.detail = `Already in ${existing.file}.`;
      return;
    }
    const earlier = accepted.find((a) => sameTrigger(a.trigger, a.options.caseSensitive, row.trigger, options.caseSensitive));
    if (earlier) {
      row.status = 'repeat';
      row.detail = `Same trigger as row ${earlier.row}.`;
      return;
    }
    accepted.push(row);
    if (!known.has(file.toLowerCase())) {
      byLowerName.set(file.toLowerCase(), file);
      known.add(file.toLowerCase());
      plan.newFiles.push(file);
    }
  });
  return plan;
}
