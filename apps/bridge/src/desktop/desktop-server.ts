import { randomBytes, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { ByteSize, Effect } from 'effect';
import {
  HttpIncomingMessage,
  HttpServerError,
  HttpServerRequest,
  HttpServerResponse,
} from 'effect/http';
import { writeJson } from '../json-file.ts';
import { serveOnLoopback } from '../loopback-server.ts';

/** The desktop API's routes; they stay a Hono app because the desktop UI's typed client reads its type. */
export interface FetchApp {
  fetch: (request: Request) => Response | Promise<Response>;
}

const MAX_BODY_BYTES = 100000;

const tooLarge = (error: unknown) =>
  error instanceof HttpServerError.HttpServerError &&
  error.reason._tag === 'RequestParseError' &&
  error.reason.reason === 'BodyTooLarge';

/**
 * Serves the desktop API on loopback until the caller's scope closes. Each
 * request needs this session's token and no browser origin, so only the
 * desktop app's host can call it; the port and token go to `desktop.json` in
 * `runtime`. Returns the bound port.
 */
export const serveDesktop = Effect.fn('DesktopServer.serve')(function* (
  runtime: string,
  app: FetchApp,
  port = 43190,
) {
  const token = randomBytes(32).toString('hex');
  const expected = Buffer.from('Bearer ' + token);
  const guarded = Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const supplied = Buffer.from(request.headers.authorization || '');
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      return HttpServerResponse.text('Forbidden', { status: 403 });
    }
    if (request.headers.origin) {
      return HttpServerResponse.text('Browser origins are not allowed', { status: 403 });
    }
    const body =
      request.method === 'GET' || request.method === 'HEAD'
        ? undefined
        : yield* request.arrayBuffer.pipe(
            Effect.provideService(HttpIncomingMessage.MaxBodySize, ByteSize.bytes(MAX_BODY_BYTES)),
          );
    const response = yield* Effect.promise(async (signal) =>
      app.fetch(
        new Request(new URL(request.url, 'http://127.0.0.1'), {
          method: request.method,
          headers: request.headers,
          body,
          signal,
        }),
      ),
    );
    return HttpServerResponse.fromWeb(response);
  }).pipe(
    Effect.catchIf(tooLarge, () =>
      Effect.succeed(
        HttpServerResponse.jsonUnsafe({ error: 'Request is too large' }, { status: 400 }),
      ),
    ),
  );
  const boundPort = yield* serveOnLoopback(guarded, port);
  yield* Effect.promise(() =>
    writeJson(path.join(runtime, 'desktop.json'), { port: boundPort, token, pid: process.pid }),
  );
  return boundPort;
});
