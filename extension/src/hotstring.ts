// AutoHotkey v2 hotstring generation. Pure functions only (no DOM, no chrome.*),
// so the same code drives the dialog preview and runs under node:test.
//
// Every rule here was checked against the AutoHotkey v2.0 docs and source
// (script.cpp, hook.cpp, hotkey.cpp, keyboard_mouse.cpp); README.md
// "AutoHotkey output rules" explains each one.

export interface HotstringOptions {
  /** `*`: fire without waiting for an ending character. */
  immediate: boolean;
  /** `?`: fire inside words. */
  insideWord: boolean;
  /** `C`: the trigger is case-sensitive. */
  caseSensitive: boolean;
  /** `B0`: leave the typed trigger in place instead of backspacing it. */
  keepTrigger: boolean;
  /** `O`: drop the ending character (Space, Enter, ...) that fired the hotstring. */
  omitEndChar: boolean;
}

export const NO_OPTIONS: Readonly<HotstringOptions> = Object.freeze({
  immediate: false,
  insideWord: false,
  caseSensitive: false,
  keepTrigger: false,
  omitEndChar: false,
});

/** How the dialog and Settings present each option, in AutoHotkey's order. */
export const OPTION_INFO: readonly { key: keyof HotstringOptions; letter: string; label: string; help: string }[] = [
  { key: 'immediate', letter: '*', label: 'Instant', help: 'Expand as soon as the trigger is typed, without Space or Enter after it.' },
  { key: 'insideWord', letter: '?', label: 'Inside words', help: 'Also expand when the trigger is typed in the middle of a word.' },
  { key: 'caseSensitive', letter: 'C', label: 'Match case', help: 'Only expand when the trigger is typed with exactly this capitalisation.' },
  { key: 'keepTrigger', letter: 'B0', label: 'Keep trigger', help: 'Leave the typed trigger in place instead of erasing it.' },
  { key: 'omitEndChar', letter: 'O', label: 'No end key', help: "Don't type the Space or Enter that ended the trigger." },
];

/**
 * Reads AutoHotkey option letters, as written in a hotstring or a CSV
 * Options column, into the five options. Returns null when there's an option
 * the extension can't represent (R, SI, C1, ...). T and X are accepted and
 * ignored: toHotstring picks the form itself.
 */
export function parseOptionLetters(letters: string): HotstringOptions | null {
  const tokens = letters.match(/[*?CBOTX]0?/gi) ?? [];
  if (tokens.join('') !== letters) return null;
  const options = { ...NO_OPTIONS };
  for (const token of tokens) {
    const on = !token.endsWith('0');
    switch (token[0]!.toUpperCase()) {
      case '*':
        options.immediate = on;
        break;
      case '?':
        options.insideWord = on;
        break;
      case 'C':
        options.caseSensitive = on;
        break;
      case 'B':
        // B0 keeps the trigger; a plain B turns backspacing back on.
        options.keepTrigger = !on;
        break;
      case 'O':
        options.omitEndChar = on;
        break;
    }
  }
  return options;
}

/** Reads options from untrusted input (a message or stored settings): only `true` turns one on. */
export function toOptions(value: unknown): HotstringOptions {
  const source = typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
  return {
    immediate: source.immediate === true,
    insideWord: source.insideWord === true,
    caseSensitive: source.caseSensitive === true,
    keepTrigger: source.keepTrigger === true,
    omitEndChar: source.omitEndChar === true,
  };
}

/** AutoHotkey's MAX_HOTSTRING_LENGTH, counted in UTF-16 code units like JS `length`. */
export const MAX_TRIGGER_LENGTH = 40;

/**
 * SendInput silently drops keystrokes beyond roughly 5,000 characters, and both
 * `:T:` and SendText use it. The margin leaves room for backspacing a
 * 40-character trigger and the ending character. Capping here also keeps an
 * escaped `:X:` line under AutoHotkey's 16,384-character line limit.
 */
export const MAX_REPLACEMENT_LENGTH = 4800;

/** `T`: single-line text sent literally. `X`: a SendText() call holding a string literal. */
export type HotstringMode = 'T' | 'X';

export type HotstringResult =
  | { ok: true; line: string; mode: HotstringMode; warnings: string[] }
  | { ok: false; errors: string[]; warnings: string[] };

export interface TriggerCheck {
  errors: string[];
  warnings: string[];
}

export interface SourceInfo {
  title: string;
  url: string;
  /** Local date as YYYY-MM-DD; see isoDate(). */
  date: string;
}

const MAX_COMMENT_TITLE = 200;
const MAX_COMMENT_URL = 500;

/**
 * Cleans text copied from a web page: line endings become `\n`, smart quotes
 * become ASCII quotes, non-breaking spaces become spaces, and invisible
 * characters that would end up typed (zero-width space, word joiner, BOM, soft
 * hyphen, control characters other than `\n` and `\t`) are removed. Zero-width
 * joiners stay because emoji sequences need them.
 */
export function normalizeText(text: string): string {
  return text
    .toWellFormed()
    .replace(/\r\n?|[\u0085\u2028\u2029]/g, '\n')
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    .replace(/[\u00A0\u2007\u202F]/g, ' ')
    .replace(/[\u00AD\u200B\u2060\uFEFF]/g, '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, '');
}

export function validateTrigger(trigger: string): TriggerCheck {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (trigger === '') {
    errors.push('Enter a trigger.');
    return { errors, warnings };
  }
  if (trigger.length > MAX_TRIGGER_LENGTH) {
    errors.push(`A trigger can be at most ${MAX_TRIGGER_LENGTH} characters; this one is ${trigger.length}.`);
  }
  if (trigger.includes('::')) {
    errors.push('A trigger can\'t contain "::".');
  }
  if (/[\n\r\u0085\u2028\u2029]/.test(trigger)) {
    errors.push("A trigger can't contain line breaks.");
  } else if (/[\u0000-\u001F\u007F-\u009F]/.test(trigger)) {
    errors.push("A trigger can't contain tabs or other control characters.");
  }
  if (trigger.includes(' ')) {
    warnings.push('The trigger contains a space. Space is also an ending character, so a shorter hotstring may fire first.');
  }
  return { errors, warnings };
}

/**
 * Builds the single hotstring line for `trigger` → `text`.
 *
 * Single-line text without leading/trailing whitespace or tabs uses text
 * mode, e.g. `:T:;brb::be right back`. Everything else uses execute mode with
 * one string literal, e.g. `:X:;sig::SendText("Best regards,`nJane" A_EndChar)`.
 */
export function toHotstring(trigger: string, text: string, options: HotstringOptions = NO_OPTIONS): HotstringResult {
  const { errors, warnings } = validateTrigger(trigger);
  const replacement = normalizeText(text);
  if (replacement === '') {
    errors.push('The replacement text is empty.');
  } else if (replacement.length > MAX_REPLACEMENT_LENGTH) {
    errors.push(
      `The replacement is ${replacement.length.toLocaleString('en')} characters; the limit is ` +
        `${MAX_REPLACEMENT_LENGTH.toLocaleString('en')} because AutoHotkey drops keystrokes past about 5,000.`,
    );
  }
  if (errors.length > 0) return { ok: false, errors, warnings };

  const mode: HotstringMode = needsExecuteMode(replacement) ? 'X' : 'T';
  const head = `:${optionLetters(options)}${mode}:${escapeTrigger(trigger)}::`;
  const line =
    mode === 'T'
      ? head + escapeCommentSemicolons(replacement.replace(/`/g, '``'))
      : head + `SendText("${escapeStringLiteral(replacement)}"${appendsEndChar(options) ? ' A_EndChar' : ''})`;
  return { ok: true, line, mode, warnings };
}

/** `; from <title>, <url>, <date>` on one line, for the line above a hotstring. */
export function sourceComment({ title, url, date }: SourceInfo): string {
  const parts = [
    truncate(collapseWhitespace(title), MAX_COMMENT_TITLE),
    truncate(collapseWhitespace(url), MAX_COMMENT_URL),
    date,
  ].filter((part) => part !== '');
  return `; from ${parts.join(', ')}`;
}

/** YYYY-MM-DD in local time. */
export function isoDate(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

// Text mode trims leading and trailing spaces and tabs, so anything that
// depends on whitespace (or spans lines) goes through a string literal instead.
function needsExecuteMode(text: string): boolean {
  return /[\n\t]/.test(text) || /^ | $/.test(text);
}

/** The option letters toHotstring writes, in order: `*?CB0O`. */
export function optionLetters(o: HotstringOptions): string {
  return (o.immediate ? '*' : '') + (o.insideWord ? '?' : '') + (o.caseSensitive ? 'C' : '') +
    (o.keepTrigger ? 'B0' : '') + (o.omitEndChar ? 'O' : '');
}

// v2 ends the trigger at the first unescaped "::", so a trailing ":" would end
// it early; escaping every colon (`:) is valid anywhere in a trigger.
function escapeTrigger(trigger: string): string {
  return escapeCommentSemicolons(trigger.replace(/[`:]/g, '`$&'));
}

// A semicolon with a space or tab on its left starts a comment, even mid-line.
function escapeCommentSemicolons(s: string): string {
  return s.replace(/(?<=[ \t]);/g, '`;');
}

function escapeStringLiteral(text: string): string {
  const escaped = text.replace(/[`"\n\t]/g, (c) => ({ '`': '``', '"': '`"', '\n': '`n', '\t': '`t' })[c]!);
  return escapeCommentSemicolons(escaped);
}

// An `:X:` hotstring backspaces the trigger but, unlike auto-replace, never
// re-sends the ending character the hook swallowed (Hotstring::DoReplace), so
// it has to be appended to match `:T:`. With `O` it should be dropped anyway;
// with `B0` the hook lets it through where it was typed; with `*` there is none.
function appendsEndChar(o: HotstringOptions): boolean {
  return !o.immediate && !o.keepTrigger && !o.omitEndChar;
}

function collapseWhitespace(s: string): string {
  return normalizeText(s).replace(/\s+/g, ' ').trim();
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1).trimEnd() + '\u2026';
}
