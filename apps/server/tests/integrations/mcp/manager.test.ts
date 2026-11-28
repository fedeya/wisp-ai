import { assert, describe, layer } from '@effect/vitest';
import * as NodeCrypto from '@effect/platform-node/NodeCrypto';
import * as NodeServices from '@effect/platform-node/NodeServices';
import * as AgentConfig from '@wisp/agent/agent-config';
import * as McpManager from '@wisp/agent/mcp-manager';
import { ConfigProvider, Effect, FileSystem, Layer, Path, Redacted, Ref } from 'effect';
import * as ServerMcp from '../../../src/integrations/mcp/manager.ts';
import * as AppConfig from '../../../src/platform/config.ts';
import { SecretVault } from '../../../src/platform/secret-vault.ts';
import * as Settings from '../../../src/settings/index.ts';

const notes = { name: 'notes', url: 'https://example.com/mcp', args: [] };

/**
 * The server's MCP manager on a data folder for one test, removed when it
 * ends, with `settings` in its `config.local.json` and a vault in `secrets`.
 */
const serverMcp = Effect.fnUntraced(function* (settings: Record<string, unknown> = {}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dataRoot = yield* fs.makeTempDirectoryScoped({ prefix: 'wisp-mcp-' });
  yield* fs.writeFileString(path.join(dataRoot, 'config.local.json'), JSON.stringify(settings));
  const secrets = yield* Ref.make<ReadonlyMap<string, string>>(new Map());
  const vault = Layer.succeed(
    SecretVault,
    SecretVault.of({
      read: (key) =>
        Ref.get(secrets).pipe(Effect.map((saved) => Redacted.make(saved.get(key) ?? ''))),
      write: (key, value) =>
        Ref.update(secrets, (saved) => new Map(saved).set(key, Redacted.value(value))),
    }),
  );
  const config = AppConfig.layer.pipe(
    Layer.provide(
      ConfigProvider.layer(
        ConfigProvider.fromUnknown({ WISP_DATA_DIR: dataRoot, WISP_RESOURCE_ROOT: dataRoot }),
      ),
    ),
  );
  const platform = Layer.merge(NodeServices.layer, NodeCrypto.layerSecureRandom);
  const manager = ServerMcp.layer.pipe(
    Layer.provide([
      config,
      Settings.layer.pipe(Layer.provide([config, platform])),
      AgentConfig.layer.pipe(Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({})))),
      vault,
      platform,
    ]),
  );
  return { dataRoot, secrets, manager };
});

layer(NodeServices.layer)((it) => {
  describe('the server’s MCP storage', () => {
    it.effect('rewrites mcp.json in the runtime folder as two-space JSON', () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const { dataRoot, manager } = yield* serverMcp();
        const file = path.join(dataRoot, 'runtime', 'mcp.json');
        yield* fs.makeDirectory(path.dirname(file), { recursive: true });
        yield* fs.writeFileString(file, JSON.stringify({ servers: { notes } }));
        yield* Effect.gen(function* () {
          const servers = yield* McpManager.Service;
          yield* servers.load();
          yield* servers.setEnabled('notes', false);
        }).pipe(Effect.provide(manager));
        assert.strictEqual(
          yield* fs.readFileString(file),
          JSON.stringify(
            {
              servers: {
                notes: {
                  name: 'notes',
                  description: '',
                  transport: 'http',
                  url: 'https://example.com/mcp',
                  args: [],
                  enabled: false,
                  tools: [],
                  hasToken: false,
                  envKeys: [],
                },
              },
            },
            null,
            2,
          ),
        );
      }).pipe(Effect.scoped),
    );

    it.effect('reads the file the mcpConfig setting names, from the data folder', () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const { dataRoot, manager } = yield* serverMcp({ mcpConfig: 'custom/servers.json' });
        yield* fs.makeDirectory(path.join(dataRoot, 'custom'));
        yield* fs.writeFileString(
          path.join(dataRoot, 'custom', 'servers.json'),
          JSON.stringify({ servers: { notes } }),
        );
        const listed = yield* Effect.gen(function* () {
          const servers = yield* McpManager.Service;
          yield* servers.load();
          return yield* servers.list();
        }).pipe(Effect.provide(manager));
        assert.deepStrictEqual(
          listed.map(({ name }) => name),
          ['notes'],
        );
      }).pipe(Effect.scoped),
    );

    it.effect('starts with no custom servers when nothing is saved', () =>
      Effect.gen(function* () {
        const { manager } = yield* serverMcp();
        const listed = yield* Effect.gen(function* () {
          const servers = yield* McpManager.Service;
          yield* servers.load();
          return yield* servers.list();
        }).pipe(Effect.provide(manager));
        assert.deepStrictEqual(listed, []);
      }).pipe(Effect.scoped),
    );

    it.effect('removing a server clears its credentials in the vault', () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const { dataRoot, secrets, manager } = yield* serverMcp();
        yield* Ref.set(secrets, new Map([['mcp:notes:token', 'private-test-token']]));
        yield* fs.makeDirectory(path.join(dataRoot, 'runtime'));
        yield* fs.writeFileString(
          path.join(dataRoot, 'runtime', 'mcp.json'),
          JSON.stringify({ servers: { notes: { ...notes, hasToken: true } } }),
        );
        yield* Effect.gen(function* () {
          const servers = yield* McpManager.Service;
          yield* servers.load();
          yield* servers.remove('notes');
          assert.deepStrictEqual(yield* servers.list(), []);
        }).pipe(Effect.provide(manager));
        assert.deepStrictEqual(
          [...(yield* Ref.get(secrets))],
          [
            ['mcp:notes:token', ''],
            ['mcp:notes:env', ''],
          ],
        );
      }).pipe(Effect.scoped),
    );
  });
});
