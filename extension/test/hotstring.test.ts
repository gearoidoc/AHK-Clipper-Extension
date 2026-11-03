import assert from 'node:assert/strict';
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

const ALL: HotstringOptions = { immediate: true, insideWord: true, caseSensitive: true, keepTrigger: true, omitEndChar: true };
const opts = (o: Partial<HotstringOptions>): HotstringOptions => ({ ...NO_OPTIONS, ...o });

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

describe('toHotstring: expected lines', () => {
  const cases: [name: string, trigger: string, text: string, options: HotstringOptions, expected: string][] = [
    ['plain text uses text mode', ';brb', 'be right back', NO_OPTIONS, ':T:;brb::be right back'],
    ['backticks are doubled', ';bt', 'use `code`', NO_OPTIONS, ':T:;bt::use ``code``'],
    ['semicolon after a space is escaped', ';sc', 'a ;b', NO_OPTIONS, ':T:;sc::a `;b'],
    ['semicolon after a letter is left alone', ';sc', 'a;b', NO_OPTIONS, ':T:;sc::a;b'],
    ['Send specials stay literal in text mode', ';keys', '{Enter}^c!#+', NO_OPTIONS, ':T:;keys::{Enter}^c!#+'],
    ['a lone brace is safe in text mode', ';br', '{', NO_OPTIONS, ':T:;br::{'],
    ['"::" inside the text is fine', ';dc', 'a::b', NO_OPTIONS, ':T:;dc::a::b'],
    ['double quotes are literal in text mode', ';q', 'say "hi"', NO_OPTIONS, ':T:;q::say "hi"'],
    ['leading space goes to execute mode', ';ls', ' indented', NO_OPTIONS, ':X:;ls::SendText(" indented" A_EndChar)'],
    ['trailing space goes to execute mode', ';ts', 'end ', NO_OPTIONS, ':X:;ts::SendText("end " A_EndChar)'],
    ['whitespace-only text goes to execute mode', ';sp', '   ', NO_OPTIONS, ':X:;sp::SendText("   " A_EndChar)'],
    ['tabs go to execute mode as `t', ';tab', 'a\tb', NO_OPTIONS, ':X:;tab::SendText("a`tb" A_EndChar)'],
    ['multi-line uses `n', ';sig', 'Best regards,\nJane', NO_OPTIONS, ':X:;sig::SendText("Best regards,`nJane" A_EndChar)'],
    ['CRLF and lone CR become `n', ';nl', 'a\r\nb\rc', NO_OPTIONS, ':X:;nl::SendText("a`nb`nc" A_EndChar)'],
    ['quotes are escaped in a literal', ';qq', 'say "hi"\nbye', NO_OPTIONS, ':X:;qq::SendText("say `"hi`"`nbye" A_EndChar)'],
    ['backticks are doubled in a literal', ';bq', 'a`b\nc', NO_OPTIONS, ':X:;bq::SendText("a``b`nc" A_EndChar)'],
    ['comment semicolons are escaped in a literal', ';sl', 'a ;b\nc', NO_OPTIONS, ':X:;sl::SendText("a `;b`nc" A_EndChar)'],
    ['smart quotes become ASCII', ';sq', '\u201Cit\u2019s\u201D', NO_OPTIONS, ':T:;sq::"it\'s"'],
    ['non-breaking spaces become spaces', ';nb', 'a\u00A0b\u202Fc', NO_OPTIONS, ':T:;nb::a b c'],
    ['invisible characters are removed', ';zw', 'a\u200Bb\u00ADc\uFEFF', NO_OPTIONS, ':T:;zw::abc'],
    ['zero-width joiners in emoji survive', ';dev', '\u{1F469}\u200D\u{1F4BB}', NO_OPTIONS, ':T:;dev::\u{1F469}\u200D\u{1F4BB}'],
    ['colons in the trigger are escaped', 'a:b', 'x', NO_OPTIONS, ':T:a`:b::x'],
    ['a trailing colon in the trigger is escaped', 'x:', 'y', NO_OPTIONS, ':T:x`:::y'],
    ['backticks in the trigger are doubled', '`t', 'y', NO_OPTIONS, ':T:``t::y'],
    ['comment semicolons in the trigger are escaped', 'a ;b', 'y', NO_OPTIONS, ':T:a `;b::y'],
    ['all options, text mode', ';x', 'y', ALL, ':*?CB0OT:;x::y'],
    ['all options, execute mode', ';x', 'y\nz', ALL, ':*?CB0OX:;x::SendText("y`nz")'],
    ['execute mode with O drops A_EndChar', ';x', 'y\nz', opts({ omitEndChar: true }), ':OX:;x::SendText("y`nz")'],
    ['execute mode with B0 drops A_EndChar', ';x', 'y\nz', opts({ keepTrigger: true }), ':B0X:;x::SendText("y`nz")'],
    ['execute mode with * drops A_EndChar', ';x', 'y\nz', opts({ immediate: true }), ':*X:;x::SendText("y`nz")'],
    ['? and C keep A_EndChar', ';x', 'y\nz', opts({ insideWord: true, caseSensitive: true }), ':?CX:;x::SendText("y`nz" A_EndChar)'],
  ];
  for (const [name, trigger, text, options, expected] of cases) {
    test(name, () => assert.equal(line(trigger, text, options), expected));
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

  // Deterministic PRNG so failures reproduce.
  let seed = 0x2f6b_1e3d;
  const random = () => ((seed = (Math.imul(seed ^ (seed >>> 15), 0x2c1b3c6d) + 0x6d2b79f5) >>> 0) / 2 ** 32);
  const pick = (chars: string[], max: number) =>
    Array.from({ length: 1 + Math.floor(random() * max) }, () => chars[Math.floor(random() * chars.length)]).join('');

  const textChars = [...'ab ;:`"\'{}^!+#%()\\,.'].concat(['\n', '\t', '\r\n', '\u00A0', '\u2019', '\u{1F600}', '\u00E9', '`n', '`;', ' ;', '::']);
  const triggerChars = [...'ab;:`\'"{}!#%.-\u00E9'].concat([' ;', '`:']);

  test('2,000 random tricky strings', () => {
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
      const decoded = decode(result.line);
      assert.equal(decoded.trigger, trigger, result.line);
      assert.equal(decoded.text, normalizeText(text), result.line);
      assert.equal(decoded.options.endsWith(result.mode), true);
    }
  });
});
