import { Cause, Deferred, Duration, Effect, Exit, Fiber, type Scope } from 'effect';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { hostCall, type HostError } from '../execution/engine-errors.ts';

export interface McpConnection {
  url: string;
  description: string;
  headers?: Record<string, string>;
  allow?: string[];
  block?: string[];
  /** Arguments the application fixes; they are hidden from the model. */
  provided?: Record<string, unknown>;
}

const LIST_TIMEOUT_MS = 30_000;
const CALL_TIMEOUT_MS = 120_000;

const listTools = Effect.fn('McpConnection.listTools')(function* (client: Client) {
  const tools: Tool[] = [];
  let cursor: string | undefined;
  do {
    const page = yield* hostCall((signal) =>
      client.listTools(cursor ? { cursor } : undefined, { timeout: LIST_TIMEOUT_MS, signal }),
    );
    tools.push(...page.tools);
    cursor = page.nextCursor;
  } while (cursor);
  return tools;
});

const open = Effect.fn('McpConnection.open')(function* (connection: McpConnection) {
  const client = yield* Effect.acquireRelease(
    Effect.sync(() => new Client({ name: 'wisp', version: '1.0.0' })),
    (client) => hostCall(() => client.close()).pipe(Effect.ignore),
  );
  yield* hostCall((signal) =>
    client.connect(
      new StreamableHTTPClientTransport(new URL(connection.url), {
        requestInit: { headers: connection.headers },
      }),
      { timeout: LIST_TIMEOUT_MS, signal },
    ),
  );
  const tools = yield* Effect.cachedWithTTL(listTools(client), (exit) =>
    Exit.isSuccess(exit) ? Duration.minutes(5) : Duration.zero,
  );
  return {
    tools,
    call: (name: string, args: Record<string, unknown>) =>
      hostCall((signal) =>
        client.callTool({ name, arguments: args }, undefined, { signal, timeout: CALL_TIMEOUT_MS }),
      ),
  };
});

/** One fiber opens the client and owns its scope until the cache retires the entry. */
export const start = Effect.fnUntraced(function* (
  scope: Scope.Scope,
  connection: McpConnection,
  onClosed: () => void,
) {
  const ready = Deferred.makeUnsafe<Effect.Success<ReturnType<typeof open>>, HostError>();
  const lifetime = yield* open(connection).pipe(
    Effect.tap((client) => Deferred.succeed(ready, client)),
    Effect.andThen(Effect.never),
    Effect.scoped,
    Effect.onExit((exit) =>
      Effect.sync(onClosed).pipe(Effect.ensuring(Deferred.done(ready, exit))),
    ),
    // The cache publishes the entry before this fiber can remove it on exit.
    Effect.forkIn(scope, { startImmediately: false }),
  );
  return {
    ready: Deferred.await(ready).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause) ? Effect.succeed(undefined) : Effect.failCause(cause),
      ),
    ),
    close: Fiber.interrupt(lifetime),
  };
});
