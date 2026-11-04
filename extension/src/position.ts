import type { Rect } from './protocol.ts';

export interface Size {
  width: number;
  height: number;
}

const GAP = 8;
const MARGIN = 12;

/**
 * Where to put the dialog (viewport coordinates): just below the selection,
 * or above it when there's no room below, always inside the viewport. With
 * no selection it sits near the top centre.
 */
export function placeDialog(selection: Rect | null, viewport: Size, dialog: Size): { top: number; left: number } {
  const maxLeft = Math.max(MARGIN, viewport.width - dialog.width - MARGIN);
  const maxTop = Math.max(MARGIN, viewport.height - dialog.height - MARGIN);
  if (!selection) {
    return { top: Math.min(maxTop, Math.round(viewport.height * 0.15)), left: clamp(Math.round((viewport.width - dialog.width) / 2), MARGIN, maxLeft) };
  }
  const below = selection.bottom + GAP;
  const above = selection.top - GAP - dialog.height;
  const top = below <= maxTop ? below : above >= MARGIN ? above : clamp(below, MARGIN, maxTop);
  return { top: Math.round(top), left: Math.round(clamp(selection.left, MARGIN, maxLeft)) };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
