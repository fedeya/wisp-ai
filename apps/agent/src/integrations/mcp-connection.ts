import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { mcpDefinition } from '@wisp/protocol/mcp-setup';
import { Cause, Deferred, Duration, Effect, Exit, Fiber } from 'effect';
import type { Scope } from 'effect';

export class McpConnectionError extends Error {
  readonly _tag = 'McpConnectionError';
}

const connectionError = (cause: unknown) =>
  new McpConnectionError(cause instanceof Error ? cause.message : String(cause), { cause });

function makeTransport(
  root: string,
  server: typeof mcpDefinition.Type,
  secret: string | undefined,
  env: Record<string, string>,
  redirect?: RequestRedirect,
) {
  return Effect.try({
    try: (): Transport => {
      if (server.transport === 'stdio') {
        let command = server.command!,
          args = [...server.args];
        if (/^node(?:\.exe)?$/i.test(command)) {
          command = process.env.WISP_ENGINE_EXECUTABLE
            ? path.join(root, 'runtime/node.exe')
            : process.execPath;
        }
        if (/^npx(?:\.cmd)?$/i.test(command)) {
          command = process.execPath;
          args = [
            process.env.WISP_ENGINE_EXECUTABLE
              ? '--npx'
              : path.join(root, 'runtime', 'npm', 'bin', 'npx-cli.js'),
            ...args,
          ];
        }
        const allowedEnv = Object.fromEntries(
          [
            'SystemRoot',
            'WINDIR',
            'PATH',
            'Path',
            'PATHEXT',
            'TEMP',
            'TMP',
            'USERPROFILE',
            'APPDATA',
            'LOCALAPPDATA',
            'HOME',
            'ComSpec',
          ].flatMap((key) => {
            const value = process.env[key];
            return value ? [[key, value]] : [];
          }),
        );
        allowedEnv.PATH =
          path.join(root, 'runtime') +
          path.delimiter +
          path.dirname(process.execPath) +
          path.delimiter +
          (process.env.PATH || process.env.Path || '');
        const transport = new StdioClientTransport({
          command,
          args,
          cwd: root,
          env: { ...allowedEnv, ...env },
          stderr: 'pipe',
        });
        transport.stderr?.on('data', () => {});
        return transport;
      }
      const headers: Record<string, string> = secret ? { authorization: 'Bearer ' + secret } : {};
      const url = new URL(server.url!);
      const requestInit = { headers, ...(redirect !== undefined ? { redirect } : {}) };
      return server.transport === 'sse'
        ? new SSEClientTransport(url, {
            requestInit,
            eventSourceInit: {
              fetch: (url, init) =>
                fetch(url, {
                  ...init,
                  ...(redirect !== undefined ? { redirect } : {}),
                  headers: { ...headers, ...Object.fromEntries(new Headers(init?.headers)) },
                }),
            },
          })
        : new StreamableHTTPClientTransport(url, { requestInit });
    },
    catch: connectionError,
  });
}

const discoverTools = Effect.fn('McpConnection.discoverTools')(function* (client: Client) {
  const tools: Tool[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 10; page++) {
    const result = yield* Effect.tryPromise({
      try: (signal) =>
        client.listTools(cursor ? { cursor } : undefined, { timeout: 10_000, signal }),
      catch: connectionError,
    });
    tools.push(...result.tools);
    if (!result.nextCursor) {
      break;
    }
    cursor = result.nextCursor;
  }
  if (tools.length > 1000) {
    return yield* Effect.fail(new McpConnectionError('MCP exposes too many tools'));
  }
  return tools;
}, Effect.timeout('15 seconds'));

const open = Effect.fn('McpConnection.open')(function* (
  transport: Transport,
  toolsTtl?: Duration.Input,
) {
  const client = yield* Effect.acquireRelease(
    Effect.sync(() => new Client({ name: 'WispAI', version: '0.2.0' }, { capabilities: {} })),
    (client, exit) => {
      const close = Effect.tryPromise({
        try: () => client.close(),
        catch: connectionError,
      });
      return Exit.isFailure(exit) ? Effect.ignore(close) : Effect.orDie(close);
    },
  );
  yield* Effect.tryPromise({
    try: (signal) => client.connect(transport, { signal }),
    catch: connectionError,
  });
  const listTools =
    toolsTtl !== undefined
      ? yield* Effect.cachedWithTTL(discoverTools(client), (exit) =>
          Exit.isSuccess(exit) ? toolsTtl : Duration.zero,
        )
      : yield* Effect.cached(discoverTools(client));
  const tools = yield* listTools;
  return { client, tools, listTools };
}, Effect.timeout('15 seconds'));

function probe<E>(transport: Effect.Effect<Transport, E>) {
  return Effect.scoped(
    transport.pipe(
      Effect.flatMap(open),
      Effect.map(({ tools }) => tools),
    ),
  );
}

type Connected = Effect.Success<ReturnType<typeof open>>;
type OpenError = Effect.Error<ReturnType<typeof open>>;

export interface Connection<E> {
  readonly start: Effect.Effect<void>;
  readonly awaitReady: Effect.Effect<Connected, E | OpenError>;
  readonly close: Effect.Effect<void>;
}

function make<E>(input: {
  scope: Scope.Scope;
  transport: Effect.Effect<Transport, E>;
  toolsTtl?: Duration.Input;
  onClosed: () => void;
}): Connection<E> {
  const ready = Deferred.makeUnsafe<Connected, E | OpenError>();
  let lifetime: Fiber.Fiber<never, E | OpenError> | undefined;

  const start = Effect.gen(function* () {
    if (lifetime) {
      return;
    }
    // The same fiber opens the client and owns its scope until the connection closes.
    const use = Effect.scoped(
      input.transport.pipe(
        Effect.flatMap((transport) => open(transport, input.toolsTtl)),
        Effect.tap((client) => Deferred.succeed(ready, client)),
        Effect.andThen(Effect.never),
      ),
    ).pipe(
      Effect.onExit((exit) =>
        Effect.sync(input.onClosed).pipe(
          Effect.ensuring(
            Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)
              ? Deferred.fail(ready, new McpConnectionError('MCP connection is unavailable'))
              : Deferred.done(ready, exit),
          ),
        ),
      ),
    );
    lifetime = yield* Effect.forkIn(use, input.scope, { startImmediately: true });
  });

  const close = Effect.suspend(() => (lifetime ? Fiber.interrupt(lifetime) : Effect.void));
  return { start, awaitReady: Deferred.await(ready), close };
}

export const McpConnection = { make, makeTransport, probe };
