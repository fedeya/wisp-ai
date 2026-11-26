import { randomUUID } from 'node:crypto';

interface Snapshot {
  content: string;
  contentType: string;
  url: string;
  requestedUrl: string;
  format: string;
  owner: string;
  expires: number;
  bytes: number;
  offsets: Set<number>;
}

// Cursors read the same downloaded snapshot, scoped to the conversation.
// Expired/evicted snapshots must be fetched again; never silently mix versions.
export class WebFetchPages {
  private snapshots = new Map<string, Snapshot>();
  private readonly ttlMs: number;
  private readonly maxBytes: number;
  constructor(ttlMs = 10 * 60 * 1000, maxBytes = 32 * 1024 * 1024) {
    this.ttlMs = ttlMs;
    this.maxBytes = maxBytes;
  }

  private prune() {
    for (const [id, snapshot] of this.snapshots) {
      if (snapshot.expires <= Date.now()) {
        this.snapshots.delete(id);
      }
    }
  }

  private page(id: string, snapshot: Snapshot, offset: number) {
    let end = offset,
      bytes = 0,
      lines = 0;
    for (const character of snapshot.content.slice(offset)) {
      const size = Buffer.byteLength(character);
      if (bytes + size > 50 * 1024 || lines >= 2000) {
        break;
      }
      bytes += size;
      end += character.length;
      if (character === '\n') {
        lines++;
      }
    }
    const truncated = end < snapshot.content.length;
    if (truncated) {
      snapshot.offsets.add(end);
    }
    return {
      content: snapshot.content.slice(offset, end),
      contentType: snapshot.contentType,
      url: snapshot.url,
      truncated,
      startOffset: offset,
      endOffset: end,
      totalCharacters: snapshot.content.length,
      ...(truncated ? { nextCursor: `${id}:${end}` } : {}),
    };
  }

  first(input: Omit<Snapshot, 'expires' | 'bytes' | 'offsets'>) {
    this.prune();
    const snapshot: Snapshot = {
      ...input,
      expires: Date.now() + this.ttlMs,
      bytes: Buffer.byteLength(input.content),
      offsets: new Set(),
    };
    const id = randomUUID();
    const result = this.page(id, snapshot, 0);
    if (result.truncated) {
      if (snapshot.bytes > this.maxBytes) {
        throw new Error('Converted page is too large to retain for continued reading.');
      }
      let total = [...this.snapshots.values()].reduce((sum, entry) => sum + entry.bytes, 0);
      for (const [key, entry] of this.snapshots) {
        if (this.snapshots.size < 32 && total + snapshot.bytes <= this.maxBytes) {
          break;
        }
        this.snapshots.delete(key);
        total -= entry.bytes;
      }
      this.snapshots.set(id, snapshot);
    }
    return result;
  }

  next(cursor: string, url: string, owner: string, format?: string) {
    this.prune();
    const [id, position, extra] = cursor.split(':');
    const snapshot = this.snapshots.get(id!);
    const offset = Number(position);
    if (
      !snapshot ||
      extra !== undefined ||
      !Number.isSafeInteger(offset) ||
      !snapshot.offsets.has(offset) ||
      snapshot.owner !== owner ||
      ![snapshot.url, snapshot.requestedUrl].includes(url) ||
      (format !== undefined && format !== snapshot.format)
    ) {
      throw new Error(
        'Invalid or expired web_fetch cursor, or URL/format/conversation mismatch. Fetch the URL again without cursor to restart.',
      );
    }
    return this.page(id!, snapshot, offset);
  }
}
