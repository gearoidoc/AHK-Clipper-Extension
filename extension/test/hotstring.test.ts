import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import {
  MAX_REPLACEMENT_LENGTH,
  NO_OPTIONS,
  isoDate,
  normalizeText,
  sourceComment,
  toHotstring,
  validateTrigger,
  type HotstringOptions,
} from '../src/hotstring.ts';

// The same rows are checked by host/hotstring_test.go, which must accept every line.
interface FixtureRow {
  name: string;
  trigger: string;
  text: string;
  options: Partial<HotstringOptions>;
  line: string;
}
const fixture = JSON.parse(readFileSync(new URL('../../host/testdata/hotstrings.json', import.meta.url), 'utf8')) as { lines: FixtureRow[] };

function line(trigger: string, text: string, options: HotstringOptions = NO_OPTIONS): string {
  const result = toHotstring(trigger, text, options);
  assert.ok(result.ok, `expected ok, got ${JSON.stringify(result)}`);
  return result.line;
}

function errors(trigger: string, text: string): string[] {
  const result = toHotstring(trigger, text);
  assert.ok(!result.ok, `expected errors, got ${JSON.stringify(result)}`);
  return result.errors;
}

describe('toHotstring: expected lines (host/testdata/hotstrings.json)', () => {
  for (const row of fixture.lines) {
    test(row.name, () => assert.equal(line(row.trigger, row.text, { ...NO_OPTIONS, ...row.options }), row.line));
  }
});

describe('toHotstring: rejected input', () => {
  test('empty trigger', () => assert.deepEqual(errors('', 'x'), ['Enter a trigger.']));
  test('41-character trigger', () => assert.match(errors('a'.repeat(41), 'x')[0]!, /at most 40/));
  test('40-character trigger is allowed', () => assert.ok(toHotstring('a'.repeat(40), 'x').ok));
  test('"::" in the trigger', () => assert.match(errors('a::b', 'x')[0]!, /"::"/));
  test('line break in the trigger', () => assert.match(errors('a\nb', 'x')[0]!, /line breaks/));
  test('tab in the trigger', () => assert.match(errors('a\tb', 'x')[0]!, /tabs/));
  test('empty text', () => assert.deepEqual(errors(';x', ''), ['The replacement text is empty.']));
  test('text that is only invisible characters', () => assert.deepEqual(errors(';x', '\u200B\uFEFF'), ['The replacement text is empty.']));
  test('text over the limit', () => assert.match(errors(';x', 'a'.repeat(MAX_REPLACEMENT_LENGTH + 1))[0]!, /limit is 4,800/));
  test('text at the limit is allowed', () => assert.ok(toHotstring(';x', 'a'.repeat(MAX_REPLACEMENT_LENGTH)).ok));
  test('trigger and text errors are reported together', () => assert.equal(errors('', '').length, 2));
  test('the longest possible line stays under the 16,384-character line limit', () => {
    const worst = line('`'.repeat(40), '"'.repeat(MAX_REPLACEMENT_LENGTH - 1) + '\n');
    assert.ok(worst.length < 16_384, `line is ${worst.length} characters`);
  });
});

describe('validateTrigger', () => {
  test('warns about spaces', () => {
    const { errors: e, warnings } = validateTrigger('by the way');
    assert.deepEqual(e, []);
    assert.match(warnings[0]!, /space/);
  });
  test('warnings reach the toHotstring result', () => {
    const result = toHotstring('a b', 'x');
    assert.ok(result.ok);
    assert.equal(result.warnings.length, 1);
  });
});

describe('sourceComment', () => {
  test('title, url and date', () =>
    assert.equal(
      sourceComment({ title: 'Example page', url: 'https://example.com', date: '2026-11-03' }),
      '; from Example page, https://example.com, 2026-11-03',
    ));
  test('a multi-line title collapses to one line', () =>
    assert.equal(sourceComment({ title: ' A\n  B\tC\r\n', url: 'u', date: 'd' }), '; from A B C, u, d'));
  test('an empty title is left out', () =>
    assert.equal(sourceComment({ title: '  ', url: 'https://example.com', date: '2026-11-03' }), '; from https://example.com, 2026-11-03'));
  test('a long title is truncated', () => {
    const comment = sourceComment({ title: 'x'.repeat(500), url: 'u', date: 'd' });
    assert.match(comment, /^; from x{199}\u2026, u, d$/);
  });
  test('isoDate uses local time', () => assert.equal(isoDate(new Date(2026, 10, 3, 23, 59)), '2026-11-03'));
});

// A model of how AutoHotkey v2 reads a hotstring line, following the loop in
// script.cpp that finds the first unescaped "::". Every generated line must
// decode back to the trigger and the normalised text.
describe('round trip through a model of the AutoHotkey parser', () => {
  const ESCAPES: Record<string, string> = { a: '\x07', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v', s: ' ' };
  const unescape = (s: string) => s.replace(/`([\s\S])/g, (_, c: string) => ESCAPES[c] ?? c);

  function decode(source: string): { options: string; trigger: string; text: string } {
    // A semicolon with a space or tab on its left would start a comment.
    assert.doesNotMatch(source, /[ \t];/, `comment would cut ${JSON.stringify(source)}`);
    assert.doesNotMatch(source, /[\r\n]/, 'line break in the generated line');
    const optionsEnd = source.indexOf(':', 1);
    const options = source.slice(1, optionsEnd);
    let i = optionsEnd + 1;
    for (; i < source.length; i++) {
      if (source[i] === '`') i++;
      else if (source[i] === ':' && source[i + 1] === ':') break;
    }
    const trigger = unescape(source.slice(optionsEnd + 1, i));
    const rest = source.slice(i + 2);
    if (options.endsWith('T')) return { options, trigger, text: unescape(rest) };
    const call = /^SendText\("((?:`[\s\S]|[^`"])*)"( A_EndChar)?\)$/.exec(rest);
    assert.ok(call, `not a single SendText literal: ${rest}`);
    return { options, trigger, text: unescape(call[1]!) };
  }

  // AutoHotkey drops a comment (a semicolon after a space or tab, to the end of
  // the line) and then trailing spaces and tabs before reading the line.
  const stripComment = (source: string) => source.replace(/[ \t];.*$/, '').replace(/[ \t]+$/, '');

  // Deterministic PRNG so failures reproduce.
  let seed = 0x2f6b_1e3d;
  const random = () => ((seed = (Math.imul(seed ^ (seed >>> 15), 0x2c1b3c6d) + 0x6d2b79f5) >>> 0) / 2 ** 32);
  const pick = (chars: string[], max: number) =>
    Array.from({ length: 1 + Math.floor(random() * max) }, () => chars[Math.floor(random() * chars.length)]).join('');

  const textChars = [...'ab ;:`"\'{}^!+#%()\\,.'].concat(['\n', '\t', '\r\n', '\u00A0', '\u2019', '\u{1F600}', '\u00E9', '`n', '`;', ' ;', '::']);
  const triggerChars = [...'ab;:`\'"{}!#%.-\u00E9'].concat([' ;', '`:']);

  test('2,000 random tricky strings, with and without the trailing entry id', () => {
    for (let n = 0; n < 2000; n++) {
      const trigger = pick(triggerChars, 12);
      const text = pick(textChars, 30);
      const options: HotstringOptions = {
        immediate: random() < 0.3, insideWord: random() < 0.3, caseSensitive: random() < 0.3,
        keepTrigger: random() < 0.3, omitEndChar: random() < 0.3,
      };
      const result = toHotstring(trigger, text, options);
      if (!result.ok) {
        assert.ok(trigger.includes('::') || trigger.length > 40 || normalizeText(text) === '', JSON.stringify(result.errors));
        continue;
      }
      // The host appends the entry id as a trailing comment; it must not change the hotstring.
      assert.equal(stripComment(`${result.line} ; hsc:k3j9x2`), result.line);
      const decoded = decode(result.line);
      assert.equal(decoded.trigger, trigger, result.line);
      assert.equal(decoded.text, normalizeText(text), result.line);
      assert.equal(decoded.options.endsWith(result.mode), true);
    }
  });
});
