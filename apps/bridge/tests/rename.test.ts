import { test } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { migrateGameSaves, retireLegacyAddons } from '@wisp/bridge/rename-migration';

test('rename imports preferences and bindings once, retaining originals and newer Wisp data', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'wisp-rename-'));
  try {
    const saves = path.join(root, 'WTF', 'Account', 'account', 'SavedVariables'),
      character = path.join(root, 'WTF', 'Account', 'account', 'realm', 'player');
    await mkdir(saves, { recursive: true });
    await mkdir(character, { recursive: true });
    const original =
      'WoWCompanionDB = { draft = "Keep Companion in my original text", active = "saved-chat" }';
    await writeFile(path.join(saves, 'WoWCompanion.lua'), original);
    await writeFile(path.join(saves, 'WoWCompanion.lua.bak'), original);
    await writeFile(
      path.join(character, 'bindings-cache.wtf'),
      'bind CTRL-H WOWCOMPANION_INLINE\nbind Q OTHER_ACTION\n',
    );
    assert.equal(await migrateGameSaves(root), 3);
    assert.equal(await readFile(path.join(saves, 'WoWCompanion.lua'), 'utf8'), original);
    assert.equal(
      await readFile(path.join(saves, 'WispAI.lua'), 'utf8'),
      original.replace('WoWCompanionDB', 'WispAIDB'),
    );
    assert.match(
      await readFile(path.join(character, 'bindings-cache.wtf'), 'utf8'),
      /WISPAI_INLINE/,
    );
    assert.match(
      await readFile(path.join(character, 'bindings-cache.wtf.before-wisp'), 'utf8'),
      /WOWCOMPANION_INLINE/,
    );
    await writeFile(path.join(saves, 'WispAI.lua'), 'WispAIDB = { newer = true }');
    assert.equal(await migrateGameSaves(root), 0);
    assert.match(await readFile(path.join(saves, 'WispAI.lua'), 'utf8'), /newer/);
  } finally {
    assert.ok(root.startsWith(path.join(tmpdir(), 'wisp-rename-')));
    await rm(root, { recursive: true, force: true });
  }
});
test('retirement moves only legacy addon directories outside AddOns and is repeatable', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'wisp-rename-'));
  try {
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
      await mkdir(path.join(addons, name), { recursive: true });
      await writeFile(path.join(addons, name, 'keep.txt'), 'original');
    }
    const result = await retireLegacyAddons(root);
    assert.equal(result.count, 4);
    assert.equal(
      await readFile(path.join(result.backup!, 'WoWCompanion', 'keep.txt'), 'utf8'),
      'original',
    );
    assert.deepEqual((await readdir(addons)).sort(), [
      'OtherAddon',
      'WispAI',
      'WoWCompanionUnrelated',
    ]);
    assert.equal((await retireLegacyAddons(root)).count, 0);
  } finally {
    assert.ok(root.startsWith(path.join(tmpdir(), 'wisp-rename-')));
    await rm(root, { recursive: true, force: true });
  }
});
