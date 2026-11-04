/** One line for lists and notices: line breaks become a return arrow and long text is cut short. */
export function previewText(text: string, max = 120): string {
  const line = text.replace(/\r\n?/g, '\n').replace(/\n/g, ' \u21B5 ').replace(/\t/g, ' ');
  const chars = [...line];
  return chars.length <= max ? line : `${chars.slice(0, max - 1).join('')}\u2026`;
}
