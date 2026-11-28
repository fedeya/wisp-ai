// @effect-migrated
import * as Everloot from '@wisp/agent/everloot';
import * as McpConnection from '@wisp/agent/mcp-connection';
import * as McpManager from '@wisp/agent/mcp-manager';
import * as McpStorage from '@wisp/agent/mcp-storage';
import { Effect, FileSystem, Layer, Path, Predicate, Schema } from 'effect';
import type { SecureRandom } from 'effect/crypto';
import { AppConfig } from '#/platform/config';
import * as JsonFile from '#/platform/json-file';
import { SecretVault } from '#/platform/secret-vault';
import { Settings } from '#/settings';

/** Like Node's `readFile(file, 'utf8')`: a byte order mark stays in the text. */
const utf8 = new TextDecoder('utf-8', { ignoreBOM: true });

/** The saved servers are written as they are, so their keys keep their order. */
const SavedFile = Schema.Struct({ servers: Schema.Record(Schema.String, Schema.Unknown) });

const storageError = (cause: unknown) =>
  new McpStorage.McpStorageError({
    message: Predicate.isError(cause) ? cause.message : String(cause),
    cause,
  });

/**
 * The custom servers in `mcp.json` in the runtime folder, or the file the
 * `mcpConfig` setting names, and their credentials in the vault.
 */
const storage = Layer.effect(
  McpStorage.Service,
  Effect.gen(function* () {
    const services = yield* Effect.context<
      FileSystem.FileSystem | Path.Path | SecureRandom.SecureRandom
    >();
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const vault = yield* SecretVault;
    const { paths } = yield* AppConfig;
    const { mcpConfig } = yield* (yield* Settings).get;
    const file = mcpConfig
      ? path.resolve(paths.dataRoot, mcpConfig)
      : path.join(paths.runtime, 'mcp.json');

    return McpStorage.Service.of({
      readConfig: fs.readFile(file).pipe(
        Effect.map((bytes): string | undefined => utf8.decode(bytes)),
        Effect.catchReason('PlatformError', 'NotFound', () => Effect.succeed(undefined)),
        Effect.mapError(storageError),
      ),
      writeConfig: (servers) =>
        JsonFile.write(file, SavedFile, { servers }).pipe(
          Effect.provideContext(services),
          Effect.mapError(storageError),
        ),
      readSecret: (key) => vault.read(key).pipe(Effect.mapError(storageError)),
      writeSecret: (key, value) => vault.write(key, value).pipe(Effect.mapError(storageError)),
    });
  }),
);

/** The MCP servers the server and its agent share: Everloot and the saved ones. */
export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const { paths } = yield* AppConfig;
    return McpManager.layer({ root: paths.root, bundled: [Everloot.profile] });
  }),
).pipe(Layer.provide([storage, McpConnection.layer]));
