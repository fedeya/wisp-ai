// @effect-migrated allow=effectPromises: adapter around the MCP SDK
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import type { mcpDefinition } from '@wisp/protocol/mcp-setup';
import { Context, Duration, Effect, Layer, Option, Predicate, Redacted, Schema } from 'effect';
import type { Cause, Scope } from 'effect';
import { AgentConfig } from '../host/agent-config.ts';
import * as Environment from '../host/environment.ts';

/**
 * Why an MCP operation failed:
 *
 * - `Transport`: the transport could not be built, or the SDK failed without a
 *   JSON-RPC error, such as a process that would not start or an HTTP error.
 * - `Timeout`: the operation ran past its time limit.
 * - `Protocol`: the server answered with a JSON-RPC error, or with a result
 *   Wisp could not decode.
 * - `Limit`: the server lists more tools than Wisp takes.
 * - `Closed`: the connection is closed, or closed before a request was answered.
 */
export class McpConnectionError extends Schema.TaggedError<McpConnectionError>()(
  'McpConnectionError',
  {
    reason: Schema.Literals(['Transport', 'Timeout', 'Protocol', 'Limit', 'Closed']),
    message: Schema.String,
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {}

/** A tool an MCP server lists, as far as Wisp reads it. */
export const McpTool = Schema.Struct({
  name: Schema.String,
  description: Schema.optional(Schema.String),
  /** The tool's input as JSON Schema, passed to the model unchanged. */
  inputSchema: Schema.Record(Schema.String, Schema.Unknown),
  annotations: Schema.optional(Schema.Struct({ readOnlyHint: Schema.optional(Schema.Boolean) })),
});
export type McpTool = typeof McpTool.Type;

/**
 * What a tool call returns. The model receives it as the server sent it, so
 * `_meta` and any other field are kept in the order the SDK returns them.
 */
export const McpCallResult = Schema.StructWithRest(
  Schema.Struct({
    _meta: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
    content: Schema.Array(Schema.Unknown),
    structuredContent: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
    isError: Schema.optionalKey(Schema.Boolean),
  }),
  [Schema.Record(Schema.String, Schema.Unknown)],
);
export type McpCallResult = typeof McpCallResult.Type;

const ToolPage = Schema.Struct({
  tools: Schema.Array(McpTool),
  nextCursor: Schema.optional(Schema.String),
});
const decodeToolPage = Schema.decodeUnknownEffect(ToolPage);
const decodeCallResult = Schema.decodeUnknownEffect(McpCallResult);
const isMcpError = Schema.is(Schema.instanceOf(McpError));

const reasonOf = (cause: unknown): McpConnectionError['reason'] => {
  if (!isMcpError(cause)) return 'Transport';
  if (cause.code === ErrorCode.ConnectionClosed) return 'Closed';
  return cause.code === ErrorCode.RequestTimeout ? 'Timeout' : 'Protocol';
};

/** An SDK failure, with its own message. */
const sdkError = (cause: unknown) =>
  new McpConnectionError({
    reason: reasonOf(cause),
    message: Predicate.isError(cause) ? cause.message : String(cause),
    cause,
  });

const protocolError = (cause: Schema.SchemaError) =>
  new McpConnectionError({ reason: 'Protocol', message: cause.message, cause });

const timeoutError = (cause: Cause.TimeoutError) =>
  new McpConnectionError({ reason: 'Timeout', message: cause.message, cause });

/** An open connection's operations. They fail once the scope `open` ran in closes. */
export interface McpSession {
  /**
   * The tools the server lists, read page by page: at most 10 pages, each
   * within 10 seconds, all within 15. Pages past the tenth are left out; more
   * than 1000 tools fail with `Limit`.
   */
  readonly tools: Effect.Effect<readonly McpTool[], McpConnectionError>;
  /** Calls a tool, failing with `Timeout` when the server takes longer than `timeout`. */
  readonly callTool: (
    name: string,
    args: Readonly<Record<string, unknown>>,
    timeout: Duration.Input,
  ) => Effect.Effect<McpCallResult, McpConnectionError>;
}

/** Where a server runs and how its HTTP requests treat redirects. */
export interface OpenOptions {
  /** Wisp's root: a stdio server runs in it and finds the bundled runtimes under it. */
  readonly root: string;
  /** Set on the HTTP requests when given; an SSE server's event stream request keeps the SDK's own. */
  readonly redirect?: RequestRedirect | undefined;
}

type McpServer = typeof mcpDefinition.Type;

export class Service extends Context.Service<
  Service,
  {
    /**
     * Connects to `server` within 15 seconds. The client closes when the
     * scope closes; a client that fails to close is logged and left.
     * `secret` is sent as a bearer token to an HTTP server, and `env` is
     * added to a stdio server's environment.
     */
    readonly open: (
      server: McpServer,
      secret: Redacted.Redacted | undefined,
      env: Readonly<Record<string, string>>,
      options: OpenOptions,
    ) => Effect.Effect<McpSession, McpConnectionError, Scope.Scope>;
  }
>()('@wisp/agent/McpConnection') {}

/** The variables of Wisp's environment a stdio MCP server inherits. */
const inheritedVariables = [
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
];

/** The inherited variables that are set, with the bundled runtimes first on `PATH`. */
const inheritedEnvironment = Effect.fnUntraced(function* (root: string) {
  const values = yield* Effect.forEach(inheritedVariables, (name) =>
    Effect.map(Environment.variable(name), (value) => ({ name, value })),
  );
  const allowedEnv: Record<string, string> = Object.fromEntries(
    values.flatMap(({ name, value }): [string, string][] =>
      Option.isSome(value) ? [[name, value.value]] : [],
    ),
  );
  allowedEnv.PATH =
    path.join(root, 'runtime') +
    path.delimiter +
    path.dirname(process.execPath) +
    path.delimiter +
    (allowedEnv.PATH || allowedEnv.Path || '');
  return allowedEnv;
});

/** `node` and `npx` run on Wisp's own Node; the packaged engine ships them in its runtime. */
function bundledCommand(
  command: string,
  args: readonly string[],
  root: string,
  packagedEngine: boolean,
) {
  if (/^node(?:\.exe)?$/i.test(command)) {
    return {
      command: packagedEngine ? path.join(root, 'runtime/node.exe') : process.execPath,
      args: [...args],
    };
  }
  if (/^npx(?:\.cmd)?$/i.test(command)) {
    return {
      command: process.execPath,
      args: [
        packagedEngine ? '--npx' : path.join(root, 'runtime', 'npm', 'bin', 'npx-cli.js'),
        ...args,
      ],
    };
  }
  return { command, args: [...args] };
}

/** Pages through the server's tools; see `McpSession.tools`. */
const listTools = Effect.fn('McpConnection.tools')(
  function* (client: Client) {
    const tools: McpTool[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 10; page++) {
      const result = yield* Effect.tryPromise({
        try: (signal) =>
          client.listTools(cursor ? { cursor } : undefined, { timeout: 10_000, signal }),
        catch: sdkError,
      });
      const listed = yield* decodeToolPage(result).pipe(Effect.mapError(protocolError));
      tools.push(...listed.tools);
      if (!listed.nextCursor) {
        break;
      }
      cursor = listed.nextCursor;
    }
    if (tools.length > 1000) {
      return yield* new McpConnectionError({
        reason: 'Limit',
        message: 'MCP exposes too many tools',
      });
    }
    return tools;
  },
  Effect.timeout('15 seconds'),
  Effect.catchTag('TimeoutError', (error) => Effect.fail(timeoutError(error))),
);

const callTool = Effect.fn('McpConnection.callTool')(function* (
  client: Client,
  name: string,
  args: Readonly<Record<string, unknown>>,
  timeout: Duration.Input,
) {
  const result = yield* Effect.tryPromise({
    try: (signal) =>
      client.callTool({ name, arguments: { ...args } }, undefined, {
        signal,
        timeout: Duration.toMillis(timeout),
      }),
    catch: sdkError,
  });
  return yield* decodeCallResult(result).pipe(Effect.mapError(protocolError));
});

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { packagedEngine } = yield* AgentConfig;

    const makeTransport = Effect.fnUntraced(function* (
      server: McpServer,
      secret: Redacted.Redacted | undefined,
      env: Readonly<Record<string, string>>,
      { root, redirect }: OpenOptions,
    ): Effect.fn.Return<Transport, McpConnectionError> {
      if (server.transport === 'stdio') {
        if (server.command === undefined) {
          return yield* new McpConnectionError({
            reason: 'Transport',
            message: 'Command is required',
          });
        }
        const { command, args } = bundledCommand(server.command, server.args, root, packagedEngine);
        const allowedEnv = yield* inheritedEnvironment(root).pipe(
          Effect.mapError(
            (cause) =>
              new McpConnectionError({ reason: 'Transport', message: cause.message, cause }),
          ),
        );
        return yield* Effect.try({
          try: () => {
            const transport = new StdioClientTransport({
              command,
              args,
              cwd: root,
              env: { ...allowedEnv, ...env },
              stderr: 'pipe',
            });
            // Drained, so a server that writes much to stderr does not stall.
            transport.stderr?.on('data', () => {});
            return transport;
          },
          catch: sdkError,
        });
      }
      const { url } = server;
      if (url === undefined) {
        return yield* new McpConnectionError({
          reason: 'Transport',
          message: 'Use an HTTP(S) URL without embedded credentials',
        });
      }
      const token = secret === undefined ? undefined : Redacted.value(secret);
      const headers: Record<string, string> = token ? { authorization: 'Bearer ' + token } : {};
      const requestInit: RequestInit = redirect === undefined ? { headers } : { headers, redirect };
      // The SSE transport sends these headers on its event stream request too.
      return yield* Effect.try({
        try: () =>
          server.transport === 'sse'
            ? new SSEClientTransport(new URL(url), { requestInit })
            : new StreamableHTTPClientTransport(new URL(url), { requestInit }),
        catch: sdkError,
      });
    });

    const open = Effect.fn('McpConnection.open')(
      function* (
        server: McpServer,
        secret: Redacted.Redacted | undefined,
        env: Readonly<Record<string, string>>,
        options: OpenOptions,
      ) {
        const transport = yield* makeTransport(server, secret, env, options);
        const client = yield* Effect.acquireRelease(
          Effect.sync(() => new Client({ name: 'WispAI', version: '0.2.0' }, { capabilities: {} })),
          (client) =>
            Effect.tryPromise({ try: () => client.close(), catch: sdkError }).pipe(
              Effect.catch((error) =>
                Effect.logWarning('MCP client did not close').pipe(
                  Effect.annotateLogs({
                    event: 'agent.mcp_close_failed',
                    connection: server.name,
                    error: error.message,
                  }),
                ),
              ),
            ),
        );
        yield* Effect.tryPromise({
          try: (signal) => client.connect(transport, { signal }),
          catch: sdkError,
        });
        return {
          tools: listTools(client),
          callTool: (name, args, timeout) => callTool(client, name, args, timeout),
        } satisfies McpSession;
      },
      Effect.timeout('15 seconds'),
      Effect.catchTag('TimeoutError', (error) => Effect.fail(timeoutError(error))),
    );

    return Service.of({ open });
  }),
);
