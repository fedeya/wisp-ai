import type { Row } from './csv.ts';

// Typed reads of DB2 columns, so a renamed or missing column fails the
// generation instead of quietly writing NaN or "undefined".
function cell(row: Row, column: string): string {
  const value = row[column];
  if (value === undefined) {
    throw new Error(`Column ${column} is missing (row ${row.ID ?? '?'})`);
  }
  return value;
}

export function num(row: Row, column: string): number {
  const value = Number(cell(row, column));
  if (!Number.isFinite(value)) {
    throw new Error(`Column ${column} is not a number (row ${row.ID ?? '?'}): ${row[column]}`);
  }
  return value;
}

export function str(row: Row, column: string): string {
  return cell(row, column);
}

export function byId(rows: Row[]): Map<number, Row> {
  return new Map(rows.map((row) => [num(row, 'ID'), row]));
}
