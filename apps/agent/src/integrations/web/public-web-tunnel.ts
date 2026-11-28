// @effect-migrated allow=nodeIoImports: Node's HTTP server parses the CONNECT requests; Effect's HTTP server has no CONNECT hook
import { createServer, type IncomingMessage } from 'node:http';
import { connect } from 'node:net';
import type { Duplex } from 'node:stream';
import ipaddr from 'ipaddr.js';
import { Array as Arr, Context, Effect, Layer, Option, Queue, Redacted, Ref, Schema } from 'effect';
import type { Scope } from 'effect';
import { SecureRandom } from 'effect/crypto';
import { Base64, Hex } from 'effect/encoding';
import { Dns } from 'effect/net';

/** A URL or address that is not public HTTPS, or a destination the tunnel did not approve. */
export class UnsafeWebDestination extends Schema.TaggedError<UnsafeWebDestination>()(
  'UnsafeWebDestination',
  { message: Schema.String },
) {}

/** The host name of a URL did not resolve. `message` is the DNS module's. */
export class WebLookupFailed extends Schema.TaggedError<WebLookupFailed>()('WebLookupFailed', {
  hostname: Schema.String,
  message: Schema.String,
  cause: Schema.Defect(),
}) {}

/** The tunnel's loopback listener could not start. */
export class WebTunnelFailed extends Schema.TaggedError<WebTunnelFailed>()('WebTunnelFailed', {
  message: Schema.String,
  cause: Schema.optionalKey(Schema.Defect()),
}) {}

/** Why the tunnel refused a destination. */
export type TunnelRefusal = UnsafeWebDestination | WebLookupFailed;

const bareHost = (host: string) => host.replaceAll(/^\[|\]$/g, '');
const isPublicAddress = (address: string) =>
  ipaddr.isValid(address) && ipaddr.process(address).range() === 'unicast';

/** `value` as a public HTTPS URL without credentials, or why it is not one. */
export const publicWebUrl = Effect.fnUntraced(function* (value: string) {
  const url = URL.parse(value);
  if (!url) {
    return yield* new UnsafeWebDestination({ message: 'Invalid URL' });
  }
  if (url.protocol !== 'https:' || url.username || url.password) {
    return yield* new UnsafeWebDestination({
      message: 'URL must be a public HTTPS URL without credentials.',
    });
  }
  const host = bareHost(url.hostname);
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    (ipaddr.isValid(host) && !isPublicAddress(host))
  ) {
    return yield* new UnsafeWebDestination({
      message: 'URL must not target private, localhost or reserved addresses.',
    });
  }
  return url;
});

/**
 * The addresses `host` resolves to, when every one of them is public. An IP
 * literal is its own address; every other name goes through `Dns`.
 */
export const publicWebAddresses = Effect.fn('PublicWebTunnel.addresses')(function* (host: string) {
  const name = bareHost(host);
  const addresses = ipaddr.isValid(name)
    ? Arr.of(name)
    : Arr.map(
        yield* (yield* Dns.Dns)
          .lookup(name)
          .pipe(
            Effect.mapError(
              (cause) => new WebLookupFailed({ hostname: name, message: cause.message, cause }),
            ),
          ),
        (address) => address.toString(),
      );
  if (!addresses.every(isPublicAddress)) {
    return yield* new UnsafeWebDestination({
      message: 'URL must not resolve to private, localhost or reserved addresses.',
    });
  }
  return addresses;
});

/** One open tunnel: a loopback CONNECT proxy for one approved destination at a time. */
export interface Tunnel {
  /** The proxy's URL, with the credentials it accepts. */
  readonly proxyUrl: Redacted.Redacted<string>;
  /** Approves `url`'s host and port; the tunnel refuses every other destination. */
  readonly allow: (url: URL) => Effect.Effect<void>;
  /** Why the tunnel last refused a destination, if it did. */
  readonly failure: Effect.Effect<Option.Option<TunnelRefusal>>;
}

/**
 * Impit has no custom DNS lookup hook. A tunnel pins the validated public IP
 * while preserving the origin's hostname, SNI and TLS fingerprint. It never
 * decrypts traffic or delegates DNS back to Impit.
 */
export class Service extends Context.Service<
  Service,
  {
    /** A tunnel that lives as long as the scope: closing it ends every connection. */
    readonly open: Effect.Effect<Tunnel, WebTunnelFailed, Scope.Scope>;
  }
>()('@wisp/agent/PublicWebTunnel') {}

interface ConnectRequest {
  readonly request: IncomingMessage;
  readonly downstream: Duplex;
  readonly head: Buffer;
}

export const make = Effect.gen(function* () {
  const random = yield* SecureRandom.SecureRandom;
  const dns = yield* Dns.Dns;

  const open = Effect.gen(function* () {
    const token = Hex.encode(yield* random.randomBytes(24));
    const authorization = 'Basic ' + Base64.encode(token + ':' + token);
    const authority = yield* Ref.make('');
    const failure = yield* Ref.make(Option.none<TunnelRefusal>());
    const requests = yield* Queue.unbounded<ConnectRequest>();
    // Every socket, so closing ends them: Node reports connections synchronously.
    const sockets = new Set<Duplex>();

    const server = yield* Effect.acquireRelease(
      Effect.sync(() => {
        const server = createServer((_request, response) => response.writeHead(405).end());
        server.on('connection', (socket) => {
          sockets.add(socket);
          socket.on('error', () => {});
          socket.on('close', () => sockets.delete(socket));
        });
        server.on('connect', (request, downstream, head) => {
          Queue.offerUnsafe(requests, { request, downstream, head });
        });
        return server;
      }),
      (server) =>
        Effect.callback<void>((resume) => {
          for (const socket of sockets) {
            socket.destroy();
          }
          server.close(() => resume(Effect.void));
        }),
    );
    yield* Effect.callback<void, WebTunnelFailed>((resume) => {
      server.once('error', (cause) =>
        resume(Effect.fail(new WebTunnelFailed({ message: cause.message, cause }))),
      );
      server.listen(0, '127.0.0.1', () => resume(Effect.void));
    });
    const address = server.address();
    if (!address || typeof address === 'string') {
      return yield* new WebTunnelFailed({ message: 'Could not start web tunnel.' });
    }

    const pass = Effect.fnUntraced(
      function* ({ request, downstream, head }: ConnectRequest) {
        const approved = yield* Ref.get(authority);
        if (request.headers['proxy-authorization'] !== authorization || request.url !== approved) {
          return yield* new UnsafeWebDestination({ message: 'Unapproved web destination.' });
        }
        const url = yield* publicWebUrl('https://' + approved);
        const [address] = yield* publicWebAddresses(url.hostname).pipe(
          Effect.provideService(Dns.Dns, dns),
        );
        if (downstream.destroyed) {
          return;
        }
        yield* Effect.sync(() => {
          const upstream = connect({ host: address, port: Number(url.port || 443) });
          sockets.add(upstream);
          upstream.on('close', () => sockets.delete(upstream));
          upstream.on('error', () => downstream.destroy());
          downstream.on('close', () => upstream.destroy());
          upstream.once('connect', () => {
            downstream.write('HTTP/1.1 200 Connection Established\r\n\r\n');
            if (head.length) {
              upstream.write(head);
            }
            downstream.pipe(upstream).pipe(downstream);
          });
        });
      },
      (effect, { downstream }) =>
        effect.pipe(
          Effect.catch((error) =>
            Ref.set(failure, Option.some(error)).pipe(
              Effect.andThen(
                Effect.sync(() =>
                  downstream.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'),
                ),
              ),
            ),
          ),
        ),
    );
    // Each request on its own fiber, all of them ended with the tunnel.
    yield* Queue.take(requests).pipe(
      Effect.flatMap((request) => Effect.forkScoped(pass(request))),
      Effect.forever,
      Effect.forkScoped,
    );

    return {
      proxyUrl: Redacted.make(`http://${token}:${token}@127.0.0.1:${address.port}`),
      allow: (url: URL) => Ref.set(authority, url.hostname + ':' + (url.port || '443')),
      failure: Ref.get(failure),
    } satisfies Tunnel;
  });

  return Service.of({ open });
});

/** Tunnels through the `Dns` it is given. */
export const layer = Layer.effect(Service, make);
