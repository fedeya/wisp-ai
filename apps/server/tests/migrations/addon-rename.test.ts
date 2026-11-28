import { assert, layer } from '@effect/vitest';
import * as NodeServices from '@effect/platform-node/NodeServices';
import { Effect, FileSystem, Path } from 'effect';
import { TestClock } from 'effect/testing';
import { migrateGameSaves, retireLegacyAddons } from '../../src/migrations/addon-rename.ts';

/** A fresh WoW folder for one test, removed when it ends. */
const wowFolder = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.makeTempDirectoryScoped({ prefix: 'wisp-rename-' });
});

layer(NodeServices.layer)((it) => {
  it.effect('imports preferences and bindings once, keeping originals and newer Wisp data', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* wowFolder;
      const saves = path.join(root, 'WTF', 'Account', 'account', 'SavedVariables');
      const character = path.join(root, 'WTF', 'Account', 'account', 'realm', 'player');
      yield* fs.makeDirectory(saves, { recursive: true });
      yield* fs.makeDirectory(character, { recursive: true });
      const original =
        'WoWCompanionDB = { draft = "Keep Companion in my original text", active = "saved-chat" }';
      yield* fs.writeFileString(path.join(saves, 'WoWCompanion.lua'), original);
      // A byte order mark stays, so the first line keeps its legacy name.
      yield* fs.writeFileString(path.join(saves, 'WoWCompanion.lua.bak'), '\uFEFF' + original);
      const bindings = 'bind CTRL-H WOWCOMPANION_INLINE\nbind Q OTHER_ACTION\n';
      yield* fs.writeFileString(path.join(character, 'bindings-cache.wtf'), bindings);

      assert.strictEqual(yield* migrateGameSaves(root), 3);
      assert.strictEqual(yield* fs.readFileString(path.join(saves, 'WoWCompanion.lua')), original);
      assert.strictEqual(
        yield* fs.readFileString(path.join(saves, 'WispAI.lua')),
        original.replace('WoWCompanionDB', 'WispAIDB'),
      );
      assert.deepStrictEqual(
        yield* fs.readFile(path.join(saves, 'WispAI.lua.bak')),
        new TextEncoder().encode('\uFEFF' + original),
      );
      assert.strictEqual(
        yield* fs.readFileString(path.join(character, 'bindings-cache.wtf')),
        'bind CTRL-H WISPAI_INLINE\nbind Q OTHER_ACTION\n',
      );
      assert.strictEqual(
        yield* fs.readFileString(path.join(character, 'bindings-cache.wtf.before-wisp')),
        bindings,
      );

      yield* fs.writeFileString(path.join(saves, 'WispAI.lua'), 'WispAIDB = { newer = true }');
      assert.strictEqual(yield* migrateGameSaves(root), 0);
      assert.strictEqual(
        yield* fs.readFileString(path.join(saves, 'WispAI.lua')),
        'WispAIDB = { newer = true }',
      );
    }),
  );

  it.effect('keeps an earlier bindings backup and finds no saves without a WTF folder', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* wowFolder;
      assert.strictEqual(yield* migrateGameSaves(root), 0);
      const account = path.join(root, 'WTF', 'Account', 'account');
      yield* fs.makeDirectory(account, { recursive: true });
      yield* fs.writeFileString(path.join(account, 'bindings-cache.wtf'), 'WOWCOMPANION_INLINE');
      yield* fs.writeFileString(path.join(account, 'bindings-cache.wtf.before-wisp'), 'earlier');
      assert.strictEqual(yield* migrateGameSaves(root), 1);
      assert.strictEqual(
        yield* fs.readFileString(path.join(account, 'bindings-cache.wtf.before-wisp')),
        'earlier',
      );
    }),
  );

  it.effect('moves only legacy addon folders outside AddOns, and is repeatable', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* wowFolder;
      const addons = path.join(root, 'Interface', 'AddOns');
      for (const name of [
        'WoWCompanion',
        'WoWCompanion_Payload',
        'WoWCompanion_B001',
        'WoWCompanion_S1024',
        'WispAI',
        'OtherAddon',
        'WoWCompanionUnrelated',
      ]) {
        yield* fs.makeDirectory(path.join(addons, name), { recursive: true });
        yield* fs.writeFileString(path.join(addons, name, 'keep.txt'), 'original');
      }
      yield* TestClock.setTime(1_795_000_000_000);
      const result = yield* retireLegacyAddons(root);
      const backup = path.join(root, 'Interface', 'WispAI-RenameBackup', '1795000000000');
      assert.deepStrictEqual(result, { count: 4, backup });
      assert.strictEqual(
        yield* fs.readFileString(path.join(backup, 'WoWCompanion', 'keep.txt')),
        'original',
      );
      assert.deepStrictEqual((yield* fs.readDirectory(addons)).sort(), [
        'OtherAddon',
        'WispAI',
        'WoWCompanionUnrelated',
      ]);
      assert.deepStrictEqual(yield* retireLegacyAddons(root), { count: 0, backup: null });
    }),
  );
});
