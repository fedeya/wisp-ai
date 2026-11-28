// @effect-migrated
import { Clock, Context, Duration, Effect, Layer, Ref, Schema } from 'effect';
import { SecureRandom } from 'effect/crypto';

/** One fragment of a downloaded page, as `web_fetch` returns it. */
export const Page = Schema.Struct({
  content: Schema.String,
  contentType: Schema.String,
  url: Schema.String,
  truncated: Schema.Boolean,
  startOffset: Schema.Finite,
  endOffset: Schema.Finite,
  totalCharacters: Schema.Finite,
  nextCursor: Schema.optionalKey(Schema.String),
});
export type Page = typeof Page.Type;

/** A converted page to read in fragments. */
export interface PageSource {
  readonly content: string;
  readonly contentType: string;
  /** Where the page was read from, after redirects. */
  readonly url: string;
  /** The URL the model asked for. */
  readonly requestedUrl: string;
  readonly format: string;
  /** The conversation the page belongs to. */
  readonly owner: string;
}

interface Snapshot extends PageSource {
  readonly expires: number;
  readonly bytes: number;
  /** Where the fragments handed out so far end: the offsets a cursor may name. */
  readonly offsets: ReadonlySet<number>;
}

type Snapshots = ReadonlyMap<string, Snapshot>;

/** A converted page above the store's whole budget. */
export class WebPageTooLarge extends Schema.TaggedError<WebPageTooLarge>()('WebPageTooLarge', {
  message: Schema.String,
}) {}

/** A cursor the store does not hold, or one asked for with another URL, format or conversation. */
export class InvalidWebCursor extends Schema.TaggedError<InvalidWebCursor>()('InvalidWebCursor', {
  message: Schema.String,
}) {}

const fragmentBytes = 50 * 1024;
const fragmentLines = 2000;
const retainedPages = 32;

const unexpired = (snapshots: Snapshots, now: number): Snapshots =>
  new Map([...snapshots].filter(([, snapshot]) => snapshot.expires > now));

/** The fragment of `snapshot` from `offset`, and the offsets known once it is handed out. */
function fragment(id: string, snapshot: Snapshot, offset: number) {
  let end = offset,
    bytes = 0,
    lines = 0;
  for (const character of snapshot.content.slice(offset)) {
    const size = Buffer.byteLength(character);
    if (bytes + size > fragmentBytes || lines >= fragmentLines) {
      break;
    }
    bytes += size;
    end += character.length;
    if (character === '\n') {
      lines++;
    }
  }
  const truncated = end < snapshot.content.length;
  const page: Page = {
    content: snapshot.content.slice(offset, end),
    contentType: snapshot.contentType,
    url: snapshot.url,
    truncated,
    startOffset: offset,
    endOffset: end,
    totalCharacters: snapshot.content.length,
    ...(truncated ? { nextCursor: `${id}:${end}` } : {}),
  };
  const offsets = truncated ? new Set([...snapshot.offsets, end]) : snapshot.offsets;
  return { page, offsets };
}

/** `snapshots` with room for one more of `bytes`: the oldest go first. */
function evicted(snapshots: Snapshots, bytes: number, maxBytes: number): Map<string, Snapshot> {
  const kept = new Map(snapshots);
  let total = [...kept.values()].reduce((sum, entry) => sum + entry.bytes, 0);
  for (const [key, entry] of kept) {
    if (kept.size < retainedPages && total + bytes <= maxBytes) {
      break;
    }
    kept.delete(key);
    total -= entry.bytes;
  }
  return kept;
}

/**
 * Cursors read the same downloaded snapshot, scoped to the conversation.
 * Expired or evicted snapshots must be fetched again; versions never mix.
 */
export class Service extends Context.Service<
  Service,
  {
    /** The first fragment of `source`; the rest stay readable while the snapshot is kept. */
    readonly first: (source: PageSource) => Effect.Effect<Page, WebPageTooLarge>;
    /** The fragment `cursor` names, for the same URL, format and conversation. */
    readonly next: (
      cursor: string,
      url: string,
      owner: string,
      format?: string,
    ) => Effect.Effect<Page, InvalidWebCursor>;
  }
>()('@wisp/agent/WebFetchPages') {}

/** A store that keeps each snapshot for `ttl`, all of them within `maxBytes`. */
export const make = Effect.fnUntraced(function* (options: {
  readonly ttl: Duration.Input;
  readonly maxBytes: number;
}) {
  const random = yield* SecureRandom.SecureRandom;
  const ttl = Duration.toMillis(options.ttl);
  const { maxBytes } = options;
  const snapshots = yield* Ref.make<Snapshots>(new Map());

  const first = Effect.fn('WebFetchPages.first')(function* (source: PageSource) {
    const now = yield* Clock.currentTimeMillis;
    const id = yield* random.uuidV4();
    const snapshot: Snapshot = {
      ...source,
      expires: now + ttl,
      bytes: Buffer.byteLength(source.content),
      offsets: new Set(),
    };
    const { page, offsets } = fragment(id, snapshot, 0);
    const tooLarge = page.truncated && snapshot.bytes > maxBytes;
    yield* Ref.update(snapshots, (current) => {
      const kept = unexpired(current, now);
      if (!page.truncated || tooLarge) {
        return kept;
      }
      return evicted(kept, snapshot.bytes, maxBytes).set(id, { ...snapshot, offsets });
    });
    if (tooLarge) {
      return yield* new WebPageTooLarge({
        message: 'Converted page is too large to retain for continued reading.',
      });
    }
    return page;
  });

  const next = Effect.fn('WebFetchPages.next')(function* (
    cursor: string,
    url: string,
    owner: string,
    format?: string,
  ) {
    const now = yield* Clock.currentTimeMillis;
    const [id = '', position, extra] = cursor.split(':');
    const offset = Number(position);
    const page = yield* Ref.modify(snapshots, (current) => {
      const kept = unexpired(current, now);
      const snapshot = kept.get(id);
      if (
        !snapshot ||
        extra !== undefined ||
        !Number.isSafeInteger(offset) ||
        !snapshot.offsets.has(offset) ||
        snapshot.owner !== owner ||
        ![snapshot.url, snapshot.requestedUrl].includes(url) ||
        (format !== undefined && format !== snapshot.format)
      ) {
        return [undefined, kept] as const;
      }
      const read = fragment(id, snapshot, offset);
      return [read.page, new Map(kept).set(id, { ...snapshot, offsets: read.offsets })] as const;
    });
    if (!page) {
      return yield* new InvalidWebCursor({
        message:
          'Invalid or expired web_fetch cursor, or URL/format/conversation mismatch. Fetch the URL again without cursor to restart.',
      });
    }
    return page;
  });

  return Service.of({ first, next });
});

/** Snapshots kept for 10 minutes, within 32 MB. */
export const layer = Layer.effect(Service, make({ ttl: '10 minutes', maxBytes: 32 * 1024 * 1024 }));
