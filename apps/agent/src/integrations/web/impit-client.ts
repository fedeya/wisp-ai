// @effect-migrated allow=effectPromises: adapter around impit's Promise API
import { Impit } from 'impit';
import type { ImpitOptions } from 'impit';
import { Context, Effect, Layer, Redacted, Schema, Stream } from 'effect';
import { errorText } from '../../execution/engine-errors.ts';

/** impit failed a request or its body. `message` is impit's. */
export class ImpitFailed extends Schema.TaggedError<ImpitFailed>()('ImpitFailed', {
  message: Schema.String,
  cause: Schema.Defect(),
}) {}

const failed = (cause: unknown) => new ImpitFailed({ message: errorText(cause), cause });

/** A response whose body is read at most once: as `body`, or dropped with `cancel`. */
export interface WebResponse {
  readonly status: number;
  readonly ok: boolean;
  readonly headers: Headers;
  readonly body: Stream.Stream<Uint8Array, ImpitFailed>;
  /** Drops the unread body. */
  readonly cancel: Effect.Effect<void, ImpitFailed>;
}

/** A Fetch API response, impit's or the platform's, as a `WebResponse`. */
export function webResponse(response: {
  readonly status: number;
  readonly ok: boolean;
  readonly headers: Headers;
  readonly body: ReadableStream<Uint8Array> | null;
}): WebResponse {
  const { body } = response;
  return {
    status: response.status,
    ok: response.ok,
    headers: response.headers,
    body: body
      ? Stream.fromReadableStream({ evaluate: () => body, onError: failed })
      : Stream.empty,
    cancel: body ? Effect.tryPromise({ try: () => body.cancel(), catch: failed }) : Effect.void,
  };
}

/** impit's client options, with the proxy URL kept out of logs. */
export interface ClientOptions extends Omit<ImpitOptions, 'proxyUrl'> {
  readonly proxyUrl: Redacted.Redacted<string>;
}

/** One impersonated browser: a cookie jar and connection pool shared by its requests. */
export interface Client {
  /** A GET of `url` that returns redirects instead of following them. Interrupting it cancels it. */
  readonly fetch: (url: URL) => Effect.Effect<WebResponse, ImpitFailed>;
}

/** impit, which fetches pages with a browser's TLS and HTTP fingerprint. */
export class Service extends Context.Service<
  Service,
  { readonly client: (options: ClientOptions) => Effect.Effect<Client, ImpitFailed> }
>()('@wisp/agent/Impit') {}

export const layer = Layer.succeed(
  Service,
  Service.of({
    client: Effect.fn('Impit.client')(function* (options: ClientOptions) {
      const impit = yield* Effect.try({
        try: () => new Impit({ ...options, proxyUrl: Redacted.value(options.proxyUrl) }),
        catch: failed,
      });
      return {
        fetch: Effect.fn('Impit.fetch')(function* (url: URL) {
          const response = yield* Effect.tryPromise({
            try: (signal) => impit.fetch(url, { redirect: 'manual', signal }),
            catch: failed,
          });
          return webResponse(response);
        }),
      };
    }),
  }),
);
