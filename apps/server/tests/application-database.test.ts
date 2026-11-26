import { test, expect } from 'vitest';
import { mkdtemp, readFile, writeFile, readdir, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { newChat } from '../src/chat/chat-lifecycle.ts';
import {
  applicationDatabaseFile,
  copyDatabaseSnapshot,
  findApplicationDatabase,
} from '@wisp/db/application-file';
import { it } from '@effect/vitest';
import { Effect, Exit, Layer, Scope } from 'effect';
import { MemoryStore } from '../src/agent/memory-store.ts';
import { PanelStore } from '../src/panels/panel-store.ts';
import { RoutineStore } from '../src/routines/routine-store.ts';
import { ChatStore } from '../src/chat/chat-store.ts';
import { chatsAt, storageAt, testDirectory, TestDirectory } from './storage-fixture.ts';

const chat = () => ({
  ...newChat('history', 'game'),
  agentSession: 'engine',
  messages: [{ role: 'user' as const, text: 'Keep history 🧙' }],
});

it.live(
  'JSON installations initialize the canonical application database and retain the source',
  () =>
    Effect.gen(function* () {
      const { root } = yield* TestDirectory;
      const original = chat();
      const bytes = JSON.stringify([original], null, 2);
      yield* Effect.promise(() => writeFile(path.join(root, 'chats.json'), bytes));
      expect(yield* Effect.promise(() => findApplicationDatabase(root))).toBeUndefined();
      const store = yield* chatsAt(applicationDatabaseFile(root));
      expect((yield* store.load())[0]).toMatchObject(original);
      expect(yield* Effect.promise(() => findApplicationDatabase(root))).toBe(
        path.join(root, 'wisp.sqlite'),
      );
      expect(yield* Effect.promise(() => readFile(path.join(root, 'chats.json'), 'utf8'))).toBe(
        bytes,
      );
    }).pipe(Effect.scoped, Effect.provide(testDirectory)),
);

test(
  'installation snapshots include live WAL pages, preserve source sessions and never overwrite a destination',
  { timeout: 30_000 },
  () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { root } = yield* TestDirectory;
        const source = yield* chatsAt(applicationDatabaseFile(path.join(root, 'source')));
        const targetFile = applicationDatabaseFile(path.join(root, 'target'));
        yield* source.load();
        yield* source.flush([chat()]);
        expect(
          (yield* Effect.promise(async () => readFile(source.file + '-wal'))).length,
        ).toBeGreaterThan(0);
        yield* Effect.promise(async () => copyDatabaseSnapshot(source.file, targetFile));
        // The destination's own instance identity does not resume the source engine.
        const target = yield* chatsAt(targetFile);
        const history = yield* target.load();
        expect(history[0].messages).toEqual(chat().messages);
        expect(history[0].agentSession).toBeUndefined();
        yield* target.flush([]);
        yield* target.close();
        yield* Effect.promise(async () =>
          expect(copyDatabaseSnapshot(source.file, targetFile)).rejects.toMatchObject({
            code: 'EEXIST',
          }),
        );
        const reopened = yield* chatsAt(targetFile);
        expect(yield* reopened.load()).toEqual([]);
        yield* reopened.close();
        expect(
          (yield* Effect.promise(async () => readdir(path.dirname(targetFile)))).some((name) =>
            name.startsWith('.wisp-import-'),
          ),
        ).toBe(false);
      }).pipe(Effect.scoped, Effect.provide(testDirectory)),
    ),
);

test('a failed snapshot preserves its source and does not publish an empty database', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'wisp-failed-snapshot-'));
  const source = path.join(root, 'invalid.sqlite');
  const target = applicationDatabaseFile(path.join(root, 'destination'));
  try {
    await writeFile(source, 'invalid SQLite');
    await expect(copyDatabaseSnapshot(source, target)).rejects.toThrow();
    expect(await readFile(source, 'utf8')).toBe('invalid SQLite');
    await expect(access(target)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(
      (await readdir(path.dirname(target))).filter((name) => name.startsWith('.wisp-import-')),
    ).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it.live('all stores share the runtime connection and only its scope closes it', () =>
  Effect.gen(function* () {
    const { root } = yield* TestDirectory;
    const scope = yield* Scope.make();
    const context = yield* Layer.build(storageAt(applicationDatabaseFile(root))).pipe(
      Scope.provide(scope),
    );
    const read = Effect.flatMap(MemoryStore, (memory) => memory.read('character', 'mage')).pipe(
      Effect.provide(context),
    );
    yield* Effect.gen(function* () {
      const chats = yield* ChatStore;
      const memory = yield* MemoryStore;
      yield* chats.load();
      yield* chats.flush([chat()]);
      expect(yield* (yield* PanelStore).all()).toEqual([]);
      yield* (yield* RoutineStore).recover();
      yield* memory.update('character', 'mage', 'goal', 'Preserve this');
      yield* memory.update('character', 'mage', 'another', 'Still open');
    }).pipe(Effect.provide(context));
    expect(yield* read).toHaveLength(2);
    yield* Scope.close(scope, Exit.void);
    // Once the connection closes, the stores cannot query it.
    expect(Exit.isFailure(yield* Effect.exit(read))).toBe(true);
  }).pipe(Effect.provide(testDirectory)),
);
