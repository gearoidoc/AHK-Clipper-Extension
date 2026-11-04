import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { guardCell, parseCsv, toCsv, unguardCell } from '../src/csv.ts';
import { NO_OPTIONS, optionLetters, parseOptionLetters } from '../src/hotstring.ts';
import { exportRows, planImport } from '../src/importer.ts';
import { previewText } from '../src/preview.ts';
import type { ScannedHotstring } from '../src/protocol.ts';

const existing = (trigger: string, more: Partial<ScannedHotstring> = {}): ScannedHotstring => ({
  file: 'General.ahk', line: 1, trigger, caseSensitive: false, instant: false, options: 'T', kind: 'text',
  text: 'x', editable: true, id: '', hash: '0', ...more,
});

describe('CSV', () => {
  test('quotes commas, quotes, line breaks and edge spaces', () => {
    const csv = toCsv([['a', 'b,c', 'say "hi"', 'two\r\nlines', ' pad']]);
    assert.equal(csv, '\uFEFFa,"b,c","say ""hi""","two\r\nlines"," pad"\r\n');
    assert.deepEqual(parseCsv(csv), [['a', 'b,c', 'say "hi"', 'two\r\nlines', ' pad']]);
  });
  test('LF line endings, a missing final newline and blank lines', () =>
    assert.deepEqual(parseCsv('x,y\n\n1,2'), [['x', 'y'], ['1', '2']]));
  test('empty cells are kept', () => assert.deepEqual(parseCsv('a,,c\r\n'), [['a', '', 'c']]));
  test('semicolons when the header has no commas', () =>
    assert.deepEqual(parseCsv('Trigger;Replacement\r\n;x;"a;b"'), [['Trigger', 'Replacement'], ['', 'x', 'a;b']]));
  test('cells that could run as spreadsheet formulas are guarded, and come back unchanged', () => {
    for (const value of ['=SUM(A1)', '+1 555 0100', '-5', '@cmd', "'quoted", "''", 'plain', '']) {
      assert.equal(unguardCell(guardCell(value)), value, value);
      assert.equal(parseCsv(toCsv([[value, 'x']])).map((r) => r.map(unguardCell))[0]![0], value, value);
    }
    assert.equal(guardCell('=1+1'), "'=1+1");
  });
});

describe('option letters', () => {
  test('read into options and written back in order', () => {
    assert.deepEqual(parseOptionLetters('*C'), { ...NO_OPTIONS, immediate: true, caseSensitive: true });
    assert.deepEqual(parseOptionLetters('OB0?*T'), { immediate: true, insideWord: true, caseSensitive: false, keepTrigger: true, omitEndChar: true });
    assert.equal(optionLetters(parseOptionLetters('OB0?*T')!), '*?B0O');
    assert.deepEqual(parseOptionLetters(''), NO_OPTIONS);
    assert.deepEqual(parseOptionLetters('*0c0'), NO_OPTIONS);
  });
  test('options the extension can\'t write are refused', () => {
    for (const letters of ['R', 'SI', 'C1', 'K10', 'Z', '*x2']) assert.equal(parseOptionLetters(letters), null, letters);
  });
});

describe('previewText', () => {
  test('one line, cut at the limit', () => {
    assert.equal(previewText('a\r\nb\tc'), 'a \u21B5 b c');
    const long = previewText('\u00E9'.repeat(200), 50);
    assert.equal([...long].length, 50);
    assert.ok(long.endsWith('\u2026'));
  });
});

describe('planImport', () => {
  const context = { defaultFile: 'General.ahk', files: ['General.ahk', 'Main.ahk'], hotstrings: [existing(';brb'), existing('Sig', { caseSensitive: true })] };

  test('marks each row and lists files to create', () => {
    const csv = toCsv([
      ['Trigger', 'Replacement', 'File', 'Options'],
      [';ty', 'thank you', '', '*'],
      [';BRB', 'clash', 'Chat.ahk', ''],
      [';lol', 'laughing', 'Chat', '*'],
      [';ty', 'again', 'Chat.ahk', ''],
      ['sig', 'case differs', '', 'C'],
      ['', 'no trigger', '', ''],
      [';r', 'raw', '', 'R'],
      [';f', 'bad file', 'a/b.ahk', ''],
      [';sig', 'Best regards,\nJane', '', ''],
    ]);
    const plan = planImport(csv, context);
    assert.equal(plan.error, '');
    assert.deepEqual(plan.rows.map((r) => `${r.row} ${r.status}`), [
      '2 new', '3 exists', '4 new', '5 repeat', '6 new', '7 invalid', '8 invalid', '9 invalid', '10 new',
    ]);
    assert.equal(plan.rows[0]!.line, ':*T:;ty::thank you');
    assert.equal(plan.rows[0]!.file, 'General.ahk');
    assert.equal(plan.rows[2]!.file, 'Chat.ahk');
    assert.equal(plan.rows[1]!.detail, 'Already in General.ahk.');
    assert.equal(plan.rows[3]!.detail, 'Same trigger as row 2.');
    assert.equal(plan.rows[8]!.line, ':X:;sig::SendText("Best regards,`nJane" A_EndChar)');
    assert.deepEqual(plan.newFiles, ['Chat.ahk']);
  });

  test('column order comes from the header, and code rows are skipped', () => {
    const plan = planImport('Replacement,Type,Trigger\r\nhello,text,;hi\r\nRun("x"),code,;run\r\n', context);
    assert.deepEqual(plan.rows.map((r) => `${r.trigger} ${r.status}`), [';hi new', ';run code']);
  });

  test('a file without the needed columns is refused', () => {
    assert.match(planImport('Name,Text\r\na,b\r\n', context).error, /Trigger and Replacement/);
    assert.equal(planImport('', context).error, 'The file is empty.');
  });

  test('an export imports back as the same hotstrings', () => {
    const scanned = [
      existing(';brb', { text: 'be right back', options: '*T' }),
      existing(';sig', { file: 'Email.ahk', text: 'Best regards,\nJane', options: 'X' }),
      existing('=x', { text: '=SUM(1)', options: 'CT', caseSensitive: true }),
      existing(';run', { kind: 'code', text: 'Run("notepad")', options: 'X', editable: false }),
    ];
    const plan = planImport(toCsv(exportRows(scanned)), { defaultFile: 'General.ahk', files: [], hotstrings: [] });
    assert.deepEqual(plan.rows.map((r) => [r.file, r.trigger, r.text, optionLetters(r.options), r.status]), [
      ['General.ahk', ';brb', 'be right back', '*', 'new'],
      ['Email.ahk', ';sig', 'Best regards,\nJane', '', 'new'],
      ['General.ahk', '=x', '=SUM(1)', 'C', 'new'],
      ['General.ahk', ';run', 'Run("notepad")', '', 'code'],
    ]);
  });
});
