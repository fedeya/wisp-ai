import { expect, test } from 'vitest';
import { readLoadedItems, retriesItemLoading } from '../src/addon/item-loading.ts';

const loading = { status: 'available', data: { id: 4314, status: 'loading' } };
const loaded = { status: 'available', data: { id: 4314, status: 'available', name: 'Shoulders' } };

test('only item reads wait for the client item cache', () => {
  expect(retriesItemLoading({ kind: 'reference', args: { kind: 'item', id: 1 } })).toBe(true);
  expect(retriesItemLoading({ kind: 'compare_items', args: { itemIds: [1] } })).toBe(true);
  expect(retriesItemLoading({ kind: 'reference', args: { kind: 'spell', id: 1 } })).toBe(false);
  expect(retriesItemLoading({ kind: 'target', args: {} })).toBe(false);
});

test('an uncached item is read again until it loads', async () => {
  const replies = [loading, loaded];
  let reads = 0;
  const result = await readLoadedItems(async () => replies[reads++], undefined, [0, 0]);
  expect(result).toEqual(loaded);
  expect(reads).toBe(2);
});

test('comparisons retry when a candidate or equipped item is still loading', async () => {
  const pendingCompare = {
    data: { candidates: [{ item: loaded.data, comparisons: [{ equipped: loading.data }] }] },
  };
  let reads = 0;
  const result = await readLoadedItems(
    async () => (reads++ ? { data: { candidates: [] } } : pendingCompare),
    undefined,
    [0],
  );
  expect(reads).toBe(2);
  expect(result).toEqual({ data: { candidates: [] } });
});

test('retries stop after the last delay and return the latest reading', async () => {
  let reads = 0;
  const result = await readLoadedItems(
    async () => {
      reads++;
      return loading;
    },
    undefined,
    [0, 0],
  );
  expect(reads).toBe(3);
  expect(result).toEqual(loading);
});

test('loaded readings are returned without another addon request', async () => {
  let reads = 0;
  await readLoadedItems(async () => {
    reads++;
    return loaded;
  });
  expect(reads).toBe(1);
});

test('gear rankings wait while candidates are still loading', async () => {
  expect(retriesItemLoading({ kind: 'gear_candidates', args: { itemIds: [1] } })).toBe(true);
  const replies = [
    { data: { status: 'loading', items: [], loadingIds: [7] } },
    { data: { status: 'available', items: [{ id: 7 }] } },
  ];
  let reads = 0;
  const result = await readLoadedItems(async () => replies[reads++], undefined, [0, 0]);
  expect(reads).toBe(2);
  expect(result).toEqual(replies[1]);
});
