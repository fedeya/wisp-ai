// @effect-migrated
import * as NodeCrypto from '@effect/platform-node/NodeCrypto';
import { parseHTML } from 'linkedom';
import TurndownService from 'turndown';
import { Context, Effect, Layer, Option, Schema, SchemaGetter, Stream } from 'effect';
import { errorText } from '../../execution/engine-errors.ts';
import * as Impit from './impit-client.ts';
import * as Tunnel from './public-web-tunnel.ts';
import * as Pages from './web-fetch-pages.ts';

/**
 * zod's `z.string().url()`: a string the URL parser accepts once trimmed,
 * decoded trimmed and without the tabs and newlines the parser drops.
 */
const UrlString = (description: string) =>
  Schema.String.check(
    Schema.makeFilter((value: string) => URL.canParse(value.trim()) || 'Invalid URL', {
      toJsonSchema: () => ({ format: 'uri' }),
    }),
  )
    .annotate({ description })
    .pipe(
      Schema.decode({
        decode: SchemaGetter.transform((value: string) => value.trim().replaceAll(/[\t\n\r]/g, '')),
        encode: SchemaGetter.passthrough(),
      }),
    );

/** What the model asks `web_fetch` for. */
export const Input = Schema.Struct({
  url: UrlString('Public HTTPS URL. For continuation, reuse the original or returned URL.'),
  format: Schema.optionalKey(Schema.Literals(['markdown', 'text', 'html'])),
  timeout: Schema.optionalKey(
    Schema.Finite.check(Schema.isGreaterThan(0)).annotate({
      description: 'Timeout in seconds; default 30, maximum 120.',
    }),
  ),
  cursor: Schema.optionalKey(
    Schema.String.check(Schema.isMaxLength(100)).annotate({
      description:
        'Copy nextCursor from the previous result to continue the same snapshot. Omit to fetch a fresh page.',
    }),
  ),
});
export type Input = typeof Input.Type;

/** A download that failed: a timeout, a redirect loop or a response past the limit. */
export class WebFetchFailed extends Schema.TaggedError<WebFetchFailed>()('WebFetchFailed', {
  message: Schema.String,
}) {}

export type WebFetchError =
  | WebFetchFailed
  | Tunnel.UnsafeWebDestination
  | Tunnel.WebLookupFailed
  | Tunnel.WebTunnelFailed
  | Impit.ImpitFailed
  | Pages.WebPageTooLarge
  | Pages.InvalidWebCursor;

const maxBytes = 5 * 1024 * 1024;
const maxRedirects = 10;
const redirectStatuses = new Set([301, 302, 303, 307, 308]);

export const navigationHeaders = {
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Sec-Fetch-User': '?1',
  'Upgrade-Insecure-Requests': '1',
};

/** `html` without scripts and styles, with absolute links, in `format`. */
function convertHtml(html: string, url: URL, format: string) {
  if (format === 'html') {
    return html;
  }
  const { document } = parseHTML(html);
  document
    .querySelectorAll('script, style, noscript, template, meta, link')
    .forEach((el) => el.remove());
  for (const el of document.querySelectorAll('[href], [src]')) {
    for (const name of ['href', 'src']) {
      const value = el.getAttribute(name);
      if (value) {
        const absolute = URL.parse(value, url);
        if (absolute) {
          el.setAttribute(name, absolute.href);
        } else {
          el.removeAttribute(name);
        }
      }
    }
  }
  if (format === 'text') {
    document
      .querySelectorAll('p, div, h1, h2, h3, li, tr, br')
      .forEach((el) => el.appendChild(document.createTextNode('\n')));
    return (document.documentElement.textContent ?? '').replace(/\n{3,}/g, '\n\n').trim();
  }
  return new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    bulletListMarker: '-',
  }).turndown(document.toString());
}

const tooLarge = () => new WebFetchFailed({ message: 'Response too large (exceeds 5 MB).' });

/** The whole body, failing once it passes `maxBytes`. */
const readBody = (response: Impit.WebResponse) =>
  response.body.pipe(
    Stream.mapAccum(
      () => 0,
      (size, chunk) =>
        [size + chunk.byteLength, [{ chunk, size: size + chunk.byteLength }]] as const,
    ),
    Stream.mapEffect(({ chunk, size }) =>
      size > maxBytes ? Effect.fail(tooLarge()) : Effect.succeed(chunk),
    ),
    Stream.runCollect,
    Effect.map((chunks) => Buffer.concat(chunks).toString('utf8')),
  );

/** Reads public HTTPS pages for the model, and continues ones it read before. */
export class Service extends Context.Service<
  Service,
  {
    /** The first fragment of `input.url`, or the one `input.cursor` names, for `owner`. */
    readonly fetch: (input: Input, owner: string) => Effect.Effect<Pages.Page, WebFetchError>;
  }
>()('@wisp/agent/WebFetch') {}

export const make = Effect.gen(function* () {
  const pages = yield* Pages.Service;
  const tunnels = yield* Tunnel.Service;
  const impit = yield* Impit.Service;

  /** Downloads `requested` through a tunnel that lives as long as the scope. */
  const download = Effect.fnUntraced(function* (
    input: Input,
    requested: URL,
    owner: string,
    timeoutMs: number,
  ) {
    const tunnel = yield* tunnels.open;
    // A refused destination explains impit's failure better than impit does.
    const explained = <A, E>(effect: Effect.Effect<A, E>) =>
      effect.pipe(
        Effect.catch((error) =>
          Effect.flatMap(tunnel.failure, (failure) =>
            Effect.fail(Option.getOrElse(failure, () => error)),
          ),
        ),
      );
    return yield* explained(
      Effect.gen(function* () {
        const client = yield* impit.client({
          browser: 'chrome',
          headers: navigationHeaders,
          proxyUrl: tunnel.proxyUrl,
          timeout: timeoutMs,
        });
        let url = requested;
        for (let redirects = 0; ; redirects++) {
          yield* tunnel.allow(url);
          const response = yield* client.fetch(url);
          const location = response.headers.get('location');
          if (redirectStatuses.has(response.status) && location) {
            yield* response.cancel;
            if (redirects >= maxRedirects) {
              return yield* new WebFetchFailed({ message: 'Too many web redirects.' });
            }
            const target = URL.parse(location, url);
            if (!target) {
              return yield* new WebFetchFailed({ message: 'Invalid URL' });
            }
            url = yield* Tunnel.publicWebUrl(target.href);
            continue;
          }
          if (Number(response.headers.get('content-length')) > maxBytes) {
            yield* response.cancel;
            return yield* tooLarge();
          }
          const raw = yield* readBody(response);
          const contentType = response.headers.get('content-type') ?? '';
          const html =
            /text\/html|application\/xhtml\+xml/i.test(contentType) ||
            (!contentType && /^\s*<(?:!doctype\s+html|html)[\s>]/i.test(raw));
          const format = input.format ?? 'markdown';
          const converted = html
            ? yield* Effect.try({
                try: () => convertHtml(raw, url, format),
                catch: (cause) => new WebFetchFailed({ message: errorText(cause) }),
              })
            : raw;
          return yield* pages.first({
            content: response.ok
              ? converted
              : `Request failed with status code: ${response.status}\n\n${converted}`,
            contentType,
            url: url.href,
            requestedUrl: requested.href,
            format,
            owner,
          });
        }
      }),
    );
  });

  const fetch = Effect.fn('WebFetch.fetch')(function* (input: Input, owner: string) {
    const requested = yield* Tunnel.publicWebUrl(input.url);
    if (input.cursor !== undefined) {
      return yield* pages.next(input.cursor, requested.href, owner, input.format);
    }
    const timeoutMs = Math.min((input.timeout ?? 30) * 1000, 120_000);
    return yield* download(input, requested, owner, timeoutMs).pipe(
      Effect.scoped,
      Effect.timeoutOrElse({
        duration: timeoutMs,
        orElse: () =>
          Effect.fail(new WebFetchFailed({ message: 'The operation was aborted due to timeout' })),
      }),
    );
  });

  return Service.of({ fetch });
});

/** Fetches through impit and the public web tunnel, with the system resolver. */
export const layer = Layer.effect(Service, make).pipe(
  Layer.provide(
    Layer.mergeAll(
      Pages.layer,
      Tunnel.layer.pipe(Layer.provide(Tunnel.resolverLayer)),
      Impit.layer,
    ),
  ),
  Layer.provide(NodeCrypto.layerSecureRandom),
);
