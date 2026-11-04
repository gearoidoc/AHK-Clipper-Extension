// Trigger suggestions and the paste hint for the dialog.
import { findConflicts } from './conflicts.ts';
import { MAX_TRIGGER_LENGTH, NO_OPTIONS, normalizeText } from './hotstring.ts';
import type { ScannedHotstring } from './protocol.ts';

const MAX_INITIALS = 4;

/**
 * Suggests a trigger: the prefix plus the initials of the first few words
 * ("be right back" -> ";brb"), or the start of a single word ("thanks" ->
 * ";tha"). If that clashes with an existing hotstring, a number is added
 * (";brb2"); if an Instant ";brb" would swallow every numbered form, other
 * starts are tried (";berb", or for one word its consonants: ";thn"). Returns '' when the text has no letters or
 * digits, and the first candidate when nothing is free.
 */
export function suggestTrigger(text: string, prefix: string, hotstrings: readonly ScannedHotstring[], instant: boolean): string {
  const words = normalizeText(text).toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  if (words.length === 0) return '';
  const options = { ...NO_OPTIONS, immediate: instant };
  const all = candidates(words, prefix).filter((c) => c.length <= MAX_TRIGGER_LENGTH);
  const free = all.find((c) => {
    const { duplicate, shadows, shadowedBy } = findConflicts(c, options, hotstrings);
    return !duplicate && shadows.length === 0 && shadowedBy.length === 0;
  });
  return free ?? all[0] ?? '';
}

function candidates(words: string[], prefix: string): string[] {
  const head = (word: string, n: number) => [...word].slice(0, n).join('');
  const initials = (ws: string[]) => ws.map((w) => head(w, 1)).join('');
  const [first = '', ...rest] = words;
  // A word's consonants ("thanks" -> "thnks") give a single word a second start.
  const consonants = head(first, 1) + [...first].slice(1).filter((c) => !'aeiou'.includes(c)).join('');
  const bases = words.length === 1
    ? [head(first, 3), head(consonants, 3), head(first, 4), head(first, 5)]
    : [initials(words.slice(0, MAX_INITIALS)), head(first, 2) + initials(rest.slice(0, 3)), head(first, 3) + initials(rest.slice(0, 3))];
  return [...new Set(bases)].flatMap((base) => [prefix + base, ...[2, 3, 4, 5, 6, 7, 8, 9].map((n) => `${prefix}${base}${n}`)]);
}

/**
 * What to tell someone whose selection didn't come through. Google Docs draws
 * text on a canvas, so extensions can't see what's selected there.
 */
export function pasteHint(url: string): string {
  let host = '';
  try {
    host = new URL(url).hostname;
  } catch {
    // Not a URL; use the general hint.
  }
  return host === 'docs.google.com'
    ? 'Google Docs hides selected text from extensions. Press Ctrl+V to paste what you copied.'
    : 'No selected text came through. Type or paste the replacement here.';
}
