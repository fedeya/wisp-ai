/**
 * A UUID version 7 (RFC 9562): a 48-bit Unix timestamp in milliseconds, then
 * random bits. IDs made later sort after earlier ones (to the millisecond, as
 * far as the clock is right), so they suit identifiers that other records
 * point to. Order that must be exact, such as a history's, belongs in its own
 * column rather than in these IDs.
 */
export function uuidv7(now: number = Date.now()): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  let time = Math.max(0, Math.floor(now));
  for (let index = 5; index >= 0; index--) {
    bytes[index] = time % 256;
    time = Math.floor(time / 256);
  }
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** The creation time, in milliseconds, that a UUID version 7 carries. */
export function uuidv7Time(id: string): number {
  return parseInt(id.replace(/-/g, '').slice(0, 12), 16);
}
