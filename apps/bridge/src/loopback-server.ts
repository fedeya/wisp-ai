import { createServer } from 'node:http';
import * as NodeHttpServer from '@effect/platform-node/NodeHttpServer';
import { Effect } from 'effect';
import type { Scope } from 'effect';
import type { HttpServerRequest, HttpServerResponse } from 'effect/http';

const addressInUse = (error: { cause?: unknown }) =>
  (error.cause as NodeJS.ErrnoException | undefined)?.code === 'EADDRINUSE';

/**
 * Serves `app` on 127.0.0.1 until the caller's scope closes, on
 * `preferredPort` or, when another process holds it, on a free port. Returns
 * the bound port.
 *
 * Closing the scope does not wait for open requests: like the agent's model
 * streams, they are cut at once so the bridge stops promptly.
 */
export const serveOnLoopback = Effect.fn('serveOnLoopback')(function* <E>(
  app: Effect.Effect<
    HttpServerResponse.HttpServerResponse,
    E,
    HttpServerRequest.HttpServerRequest | Scope.Scope
  >,
  preferredPort: number,
) {
  const listen = (port: number) =>
    NodeHttpServer.make(() => createServer(), {
      port,
      host: '127.0.0.1',
      gracefulShutdownTimeout: 0,
    });
  const server = yield* listen(preferredPort).pipe(
    Effect.catchIf(
      (error) => preferredPort !== 0 && addressInUse(error),
      () => listen(0),
    ),
  );
  yield* server.serve(app);
  if (server.address._tag === 'UnixPathAddress') {
    return yield* Effect.die(Error('The loopback server is not on a TCP port.'));
  }
  return server.address.port;
});
