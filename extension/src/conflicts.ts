// Duplicate and shadowing checks against the hotstrings already in the
// folder, as the host's scan reports them. The host repeats the duplicate
// check under its lock; these drive the dialog's banner and warnings.
import type { HotstringOptions } from './hotstring.ts';
import type { ScannedHotstring } from './protocol.ts';

export interface Conflicts {
  /** A hotstring with the same trigger: saving needs Replace or a new trigger. */
  duplicate: ScannedHotstring | null;
  /** Hotstrings the new Instant trigger would fire in front of (it's their prefix). */
  shadows: ScannedHotstring[];
  /** Existing Instant hotstrings that would fire before the new trigger is complete. */
  shadowedBy: ScannedHotstring[];
}

/** AutoHotkey matches exactly when either hotstring is case-sensitive, otherwise ignoring case. */
export function sameTrigger(a: string, aCase: boolean, b: string, bCase: boolean): boolean {
  return aCase || bCase ? a === b : fold(a) === fold(b);
}

export function findConflicts(trigger: string, options: HotstringOptions, hotstrings: readonly ScannedHotstring[]): Conflicts {
  const conflicts: Conflicts = { duplicate: null, shadows: [], shadowedBy: [] };
  if (trigger === '') return conflicts;
  for (const h of hotstrings) {
    if (sameTrigger(h.trigger, h.caseSensitive, trigger, options.caseSensitive)) {
      conflicts.duplicate ??= h;
    } else if (options.immediate && startsWith(h.trigger, trigger, h.caseSensitive || options.caseSensitive)) {
      conflicts.shadows.push(h);
    } else if (h.instant && startsWith(trigger, h.trigger, h.caseSensitive || options.caseSensitive)) {
      conflicts.shadowedBy.push(h);
    }
  }
  return conflicts;
}

function startsWith(text: string, prefix: string, caseSensitive: boolean): boolean {
  return caseSensitive ? text.startsWith(prefix) : fold(text).startsWith(fold(prefix));
}

function fold(s: string): string {
  return s.toLowerCase();
}
