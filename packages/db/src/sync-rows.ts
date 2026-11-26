import { isDeepStrictEqual } from 'node:util';

/** Writes only the rows that changed between two snapshots of a table, keyed by identity. */
export function syncRows<T>(
  before: T[],
  after: T[],
  key: (row: T) => string,
  save: (row: T) => void,
  remove: (row: T) => void,
) {
  const old = new Map(before.map((row) => [key(row), row]));
  const next = new Map(after.map((row) => [key(row), row]));
  if (next.size !== after.length) {
    throw Error('Duplicate persisted record identity');
  }
  for (const row of before) {
    if (!next.has(key(row))) {
      remove(row);
    }
  }
  for (const row of after) {
    if (!isDeepStrictEqual(old.get(key(row)), row)) {
      save(row);
    }
  }
}
