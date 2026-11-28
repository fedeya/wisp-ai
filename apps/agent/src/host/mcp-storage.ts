// @effect-migrated
import type { mcpDefinition } from '@wisp/protocol/mcp-setup';
import { Context, Effect, Layer, Redacted, Schema } from 'effect';

/** A custom MCP server as it is saved, with what its last test found. */
export type SavedServer = typeof mcpDefinition.Type & {
  tools?: readonly { readonly name: string; readonly description?: string | undefined }[];
  hasToken?: boolean | undefined;
  envKeys?: readonly string[] | undefined;
};

/** The host could not read or write what it keeps for MCP servers. */
export class McpStorageError extends Schema.TaggedError<McpStorageError>()('McpStorageError', {
  message: Schema.String,
  cause: Schema.optionalKey(Schema.Defect()),
}) {}

/** Where the host keeps the custom MCP servers and their credentials. */
export class Service extends Context.Service<
  Service,
  {
    /** The saved configuration as written, or `undefined` when there is none. */
    readonly readConfig: Effect.Effect<string | undefined, McpStorageError>;
    /**
     * Replaces the saved configuration with `servers`, written in the order
     * given. An entry that is not a `SavedServer` is one the manager could not
     * read, kept as it was found.
     */
    readonly writeConfig: (
      servers: Readonly<Record<string, SavedServer | Schema.Json>>,
    ) => Effect.Effect<void, McpStorageError>;
    /** A secret from the vault; one never written reads as empty. */
    readonly readSecret: (key: string) => Effect.Effect<Redacted.Redacted, McpStorageError>;
    /** Saves a secret; an empty one clears it. */
    readonly writeSecret: (
      key: string,
      value: Redacted.Redacted,
    ) => Effect.Effect<void, McpStorageError>;
  }
>()('@wisp/agent/McpStorage') {}

/** Nothing is saved and nothing can be: the agent's own MCP servers without a host. */
export const layerNone = Layer.succeed(
  Service,
  Service.of({
    readConfig: Effect.succeed(undefined),
    writeConfig: () =>
      Effect.fail(new McpStorageError({ message: 'MCP configuration storage is unavailable' })),
    readSecret: () => Effect.succeed(Redacted.make('')),
    writeSecret: () =>
      Effect.fail(new McpStorageError({ message: 'MCP credential storage is unavailable' })),
  }),
);
