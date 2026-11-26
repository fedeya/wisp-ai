import { setTimeout as sleep } from 'node:timers/promises';

// The addon asks the client to load uncached items and answers "loading" at
// once. Retrying here costs one addon round trip instead of a model step.
const RETRY_DELAYS_MS = [400, 800, 1600];

function loading(value: unknown): boolean {
  if (!value || typeof value !== 'object') {
    return false;
  }
  if (Array.isArray(value)) {
    return value.some(loading);
  }
  const record = value as Record<string, unknown>;
  if (record.status === 'loading') {
    return true;
  }
  return ['data', 'candidates', 'item', 'comparisons', 'equipped'].some((key) =>
    loading(record[key]),
  );
}

export function retriesItemLoading(inspection: { kind: string; args?: unknown }) {
  return (
    inspection.kind === 'compare_items' ||
    inspection.kind === 'gear_candidates' ||
    (inspection.kind === 'reference' &&
      (inspection.args as { kind?: unknown } | undefined)?.kind === 'item')
  );
}

export async function readLoadedItems(
  read: () => Promise<unknown>,
  signal?: AbortSignal,
  delays = RETRY_DELAYS_MS,
) {
  let result = await read();
  for (const delay of delays) {
    if (!loading(result)) {
      break;
    }
    await sleep(delay, undefined, { signal });
    result = await read();
  }
  return result;
}
