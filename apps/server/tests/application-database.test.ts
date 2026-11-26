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
import { makeMemoryStore } from '../src/agent/memory-store.ts';
import { makePanelStore } from '../src/panels/panel-store.ts';
import { makeRoutineStore } from '../src/routines/routine-store.ts';
import { databaseScope, chatStoreAt, promised } from './database-fixture.ts';
import { makeChatStore } from '../src/chat/chat-store.ts';

const chat = () => ({
  ...newChat('history', 'game'),
  agentSession: 'engine',
  messages: [{ role: 'user' as const, text: 'Keep history 🧙' }],
});

test('JSON installations initialize the canonical application database and retain the source', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'wisp-canonical-database-'));
  const store = chatStoreAt(applicationDatabaseFile(root), () => {});
  try {
    const original = chat();
    const bytes = JSON.stringify([original], null, 2);
    await writeFile(path.join(root, 'chats.json'), bytes);
    expect(await findApplicationDatabase(root)).toBeUndefined();
    expect((await store.load())[0]).toMatchObject(original);
    expect(await findApplicationDatabase(root)).toBe(path.join(root, 'wisp.sqlite'));
    expect(await readFile(path.join(root, 'chats.json'), 'utf8')).toBe(bytes);
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test(
  'installation snapshots include live WAL pages, preserve source sessions and never overwrite a destination',
  { timeout: 30_000 },
  async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'wisp-database-snapshot-'));
    const source = chatStoreAt(applicationDatabaseFile(path.join(root, 'source')), () => {});
    const targetFile = applicationDatabaseFile(path.join(root, 'target'));
    const target = chatStoreAt(targetFile, () => {});
    try {
      await source.load();
      await source.flush([chat()]);
      expect((await readFile(source.file + '-wal')).length).toBeGreaterThan(0);
      await copyDatabaseSnapshot(source.file, targetFile);
      // The destination's own instance identity does not resume the source engine.
      const history = await target.load();
      expect(history[0].messages).toEqual(chat().messages);
      expect(history[0].agentSession).toBeUndefined();
      await target.flush([]);
      await target.close();
      await expect(copyDatabaseSnapshot(source.file, targetFile)).rejects.toMatchObject({
        code: 'EEXIST',
      });
      const reopened = chatStoreAt(targetFile, () => {});
      try {
        expect(await reopened.load()).toEqual([]);
      } finally {
        await reopened.close();
      }
      expect(
        (await readdir(path.dirname(targetFile))).some((name) => name.startsWith('.wisp-import-')),
      ).toBe(false);
    } finally {
      await target.close();
      await source.close();
      await rm(root, { recursive: true, force: true });
    }
  },
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

test('all stores share the runtime connection and only its scope closes it', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'wisp-shared-connection-'));
  const scope = databaseScope();
  try {
    const database = await scope.open(applicationDatabaseFile(root));
    const chats = promised(await scope.run(makeChatStore(database, { onError: () => {} })));
    const memory = promised(makeMemoryStore(database)),
      panels = promised(makePanelStore(database)),
      routines = promised(makeRoutineStore(database));
    await chats.load();
    await chats.flush([chat()]);
    expect(await panels.all()).toEqual([]);
    await routines.recover();
    await memory.update('character', 'mage', 'goal', 'Preserve this');
    await chats.close();
    await memory.update('character', 'mage', 'another', 'Still open');
    expect(await memory.read('character', 'mage')).toHaveLength(2);
    await scope.close();
    await expect(memory.read('character', 'mage')).rejects.toThrow();
  } finally {
    await scope.close();
    await rm(root, { recursive: true, force: true });
  }
});
