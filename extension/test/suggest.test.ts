import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { findConflicts, sameTrigger } from '../src/conflicts.ts';
import { NO_OPTIONS } from '../src/hotstring.ts';
import type { ScannedHotstring } from '../src/protocol.ts';
import { pasteHint, suggestTrigger } from '../src/suggest.ts';

const existing = (trigger: string, more: Partial<ScannedHotstring> = {}): ScannedHotstring => ({
  file: 'General.ahk', line: 1, trigger, caseSensitive: false, instant: false, options: 'T', kind: 'text',
  text: 'x', editable: true, multiline: false, id: '', hash: '0', ...more,
});
const instant = { ...NO_OPTIONS, immediate: true };

describe('suggestTrigger', () => {
  const cases: [name: string, text: string, prefix: string, hotstrings: ScannedHotstring[], isInstant: boolean, expected: string][] = [
    ['initials of the words', 'be right back', ';', [], false, ';brb'],
    ['at most four initials', 'by the way, thanks again', ';', [], false, ';btwt'],
    ['a single word gives its first letters', 'Thanks!', ';', [], false, ';tha'],
    ['line breaks and punctuation are skipped', 'Best regards,\nJane', ';', [], false, ';brj'],
    ['the prefix can be empty', 'be right back', '', [], false, 'brb'],
    ['letters beyond ASCII work', '\u00C9t\u00E9 chaud', ';', [], false, ';\u00E9c'],
    ['digits count as words', '2 factor auth', ';', [], false, ';2fa'],
    ['nothing to go on', ' \u2014 ! ', ';', [], false, ''],
    ['a taken trigger gets a number', 'be right back', ';', [existing(';brb')], false, ';brb2'],
    ['case-insensitive clashes count', 'be right back', ';', [existing(';BRB')], false, ';brb2'],
    ['numbers keep counting', 'be right back', ';', [existing(';brb'), existing(';brb2')], false, ';brb3'],
    ['an Instant ;brb swallows ;brb2, so a longer start is used', 'be right back', ';', [existing(';brb', { instant: true })], false, ';berb'],
    ['an Instant suggestion must not be the start of an existing trigger', 'be right back', ';', [existing(';brbx')], true, ';brb2'],
    ['a single word falls back to its consonants', 'thanks', ';', [existing(';tha', { instant: true })], false, ';thn'],
  ];
  for (const [name, text, prefix, hotstrings, isInstant, expected] of cases) {
    test(name, () => assert.equal(suggestTrigger(text, prefix, hotstrings, isInstant), expected));
  }

  test('falls back to the first candidate when nothing is free', () => {
    const blocking = [existing(';b', { instant: true })];
    assert.equal(suggestTrigger('be right back', ';', blocking, false), ';brb');
  });
});

describe('findConflicts', () => {
  test('an existing trigger is a duplicate, ignoring case', () =>
    assert.equal(findConflicts(';BRB', NO_OPTIONS, [existing(';brb')]).duplicate?.trigger, ';brb'));
  test('a case-sensitive trigger on either side only matches exactly', () => {
    assert.equal(findConflicts(';BRB', { ...NO_OPTIONS, caseSensitive: true }, [existing(';brb')]).duplicate, null);
    assert.equal(findConflicts(';BRB', NO_OPTIONS, [existing(';brb', { caseSensitive: true })]).duplicate, null);
    assert.ok(sameTrigger(';brb', true, ';brb', false));
  });
  test('a new Instant trigger shadows the triggers it starts', () => {
    const { shadows, shadowedBy } = findConflicts(';br', instant, [existing(';brb'), existing(';x')]);
    assert.deepEqual(shadows.map((h) => h.trigger), [';brb']);
    assert.deepEqual(shadowedBy, []);
  });
  test('without Instant there is no shadowing', () =>
    assert.deepEqual(findConflicts(';br', NO_OPTIONS, [existing(';brb')]).shadows, []));
  test('an existing Instant trigger that starts the new one shadows it', () =>
    assert.deepEqual(findConflicts(';brb', NO_OPTIONS, [existing(';br', { instant: true })]).shadowedBy.map((h) => h.trigger), [';br']));
  test('an empty trigger conflicts with nothing', () =>
    assert.deepEqual(findConflicts('', instant, [existing(';brb')]), { duplicate: null, shadows: [], shadowedBy: [] }));
});

describe('pasteHint', () => {
  test('Google Docs gets the copy-and-paste explanation', () =>
    assert.match(pasteHint('https://docs.google.com/document/d/abc/edit'), /Google Docs hides selected text/));
  test('other pages get the general hint', () => {
    assert.match(pasteHint('https://mail.google.com/mail/u/0/'), /No selected text came through/);
    assert.match(pasteHint('not a url'), /No selected text came through/);
  });
});
