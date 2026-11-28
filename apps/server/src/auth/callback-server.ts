// @effect-migrated allow=nodeIoImports: NodeHttpServer listens with the node:http server it is given
// oxlint-disable-next-line no-restricted-imports -- NodeHttpServer takes a node:http server
import { createServer } from 'node:http';
import { make as makeHttpServer } from '@effect/platform-node/NodeHttpServer';
import { Effect, Layer } from 'effect';
import { HttpRouter, HttpServerResponse } from 'effect/http';
import type { HttpServerRequest } from 'effect/http';

/** Headers on every response from the callback server. */
const responseHeaders = { 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' };

const notFound = HttpServerResponse.text('Not found', {
  status: 404,
  contentType: 'text/plain; charset=utf-8',
});

/**
 * Serves the OAuth redirect on a random loopback port while the current scope
 * is open, and returns the port. `GET /auth/callback` runs `callback`; every
 * other request is answered with 404. Closing the scope drops open connections
 * and stops the server.
 */
export const serveCallback = Effect.fnUntraced(function* (
  callback: Effect.Effect<
    HttpServerResponse.HttpServerResponse,
    never,
    HttpServerRequest.HttpServerRequest
  >,
) {
  const node = createServer({ headersTimeout: 10_000, requestTimeout: 15_000 });
  node.maxConnections = 10;
  const server = yield* makeHttpServer(() => node, { host: '127.0.0.1', port: 0 });
  // Added after the server's own finalizer, so it runs first: a closed sign-in
  // drops its connections instead of waiting for them to finish.
  yield* Effect.addFinalizer(() => Effect.sync(() => node.closeAllConnections()));
  const app = yield* HttpRouter.toHttpEffect(
    Layer.mergeAll(
      HttpRouter.add('GET', '/auth/callback', callback),
      HttpRouter.add('*', '*', notFound),
    ),
  );
  yield* server.serve(app.pipe(Effect.map(HttpServerResponse.setHeaders(responseHeaders))));
  const { address } = server;
  if (address._tag === 'UnixPathAddress') {
    return yield* Effect.die(new Error('The callback server is not listening on a port'));
  }
  return address.port;
});
