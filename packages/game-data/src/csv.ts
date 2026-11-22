export type Row = Record<string, string>;

// Parses wago.tools' DB2 CSV exports: a header row, comma-separated cells,
// cells quoted when they hold commas, quotes ("" inside quotes) or newlines.
export function parseCsv(text: string): Row[] {
  const records: string[][] = [];
  let record: string[] = [];
  let cell = '';
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        cell += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      record.push(cell);
      cell = '';
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[index + 1] === '\n') {
        index += 1;
      }
      record.push(cell);
      records.push(record);
      record = [];
      cell = '';
    } else {
      cell += char;
    }
  }
  if (cell !== '' || record.length) {
    record.push(cell);
    records.push(record);
  }
  const [header, ...rows] = records.filter((row) => row.length > 1 || row[0] !== '');
  if (!header) {
    return [];
  }
  return rows.map((row) => Object.fromEntries(header.map((key, i) => [key, row[i] ?? ''])));
}
