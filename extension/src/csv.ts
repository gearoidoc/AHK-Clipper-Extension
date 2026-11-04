// CSV as RFC 4180 describes it, plus what Excel needs: a UTF-8 BOM so
// accents show correctly, and a guard against cells being read as formulas.

const BOM = '\uFEFF';

/**
 * Cells starting with one of these can run as a formula when the file is
 * opened in a spreadsheet, so export puts an apostrophe in front, which
 * spreadsheets show as plain text, and import takes it off again.
 */
const FORMULA_START = /^['=+\-@\t\r]/;
const GUARDED = /^'['=+\-@\t\r]/;

export function guardCell(value: string): string {
  return FORMULA_START.test(value) ? `'${value}` : value;
}

export function unguardCell(value: string): string {
  return GUARDED.test(value) ? value.slice(1) : value;
}

/** A whole file: BOM, CRLF line endings, every cell guarded and quoted where needed. */
export function toCsv(rows: string[][]): string {
  const quote = (cell: string) => (/[",\r\n]|^\s|\s$/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell);
  return BOM + rows.map((row) => row.map((cell) => quote(guardCell(cell))).join(',')).join('\r\n') + '\r\n';
}

/**
 * Parses CSV text into rows of cells. Quoted cells may hold commas, quotes
 * ("") and line breaks. The separator is a comma, or a semicolon when the
 * first line has semicolons but no commas (as some Excel versions save).
 * Blank lines are dropped; cells are returned as written (see unguardCell).
 */
export function parseCsv(text: string): string[][] {
  if (text.startsWith(BOM)) text = text.slice(1);
  const firstLine = text.slice(0, text.search(/\r?\n|$/));
  const separator = firstLine.includes(';') && !firstLine.includes(',') ? ';' : ',';
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') {
        quoted = false;
      } else {
        cell += c;
      }
    } else if (c === '"' && cell === '') {
      quoted = true;
    } else if (c === separator) {
      row.push(cell);
      cell = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else {
      cell += c;
    }
  }
  if (cell !== '' || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}
