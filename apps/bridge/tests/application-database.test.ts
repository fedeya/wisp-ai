import { test, expect } from 'vitest';
import { mkdtemp, readFile, writeFile, readdir, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ChatStore } from '@wisp/bridge/chat-store';
import { newChat } from '@wisp/bridge/chat-lifecycle';
import {
  applicationDatabaseFile,
  copyDatabaseSnapshot,
  findApplicationDatabase,
} from '@wisp/bridge/db/application-file';
import { MemoryStore } from '@wisp/bridge/memory-store';
import { PanelStore } from '@wisp/bridge/panels';
import { RoutineStore } from '@wisp/bridge/routines';
import { databaseScope } from './database-fixture.ts';

const chat = () => ({
  ...newChat('history', 'game'),
  eveId: 'engine',
  messages: [{ role: 'user' as const, text: 'Keep history 🧙' }],
});

test('JSON installations initialize the canonical application database and retain the source', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'wisp-canonical-database-'));
  const store = new ChatStore(applicationDatabaseFile(root), () => {});
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

test('installation snapshots include live WAL pages, preserve source sessions and never overwrite a destination', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'wisp-database-snapshot-'));
  const source = new ChatStore(applicationDatabaseFile(path.join(root, 'source')), () => {});
  const targetFile = applicationDatabaseFile(path.join(root, 'target'));
  const target = new ChatStore(targetFile, () => {});
  try {
    await source.load();
    await source.flush([chat()]);
    expect((await readFile(source.file + '-wal')).length).toBeGreaterThan(0);
    await copyDatabaseSnapshot(source.file, targetFile);
    // The destination's own instance identity does not resume the source engine.
    const history = await target.load();
    expect(history[0].messages).toEqual(chat().messages);
    expect(history[0].eveId).toBeUndefined();
    await target.flush([]);
    await target.close();
    await expect(copyDatabaseSnapshot(source.file, targetFile)).rejects.toMatchObject({
      code: 'EEXIST',
    });
    const reopened = new ChatStore(targetFile, () => {});
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
});

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

test('all stores reuse the runtime connection and only its owner closes it', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'wisp-shared-connection-'));
  const scope = databaseScope();
  const database = scope.open(applicationDatabaseFile(root));
  const chats = new ChatStore(database, () => {});
  try {
    await Promise.all([
      database.initialize(),
      database.initialize(),
      database.initializeProducts(),
    ]);
    const connection = database.connection;
    const memory = new MemoryStore(database),
      panels = new PanelStore(database),
      routines = new RoutineStore(database);
    await chats.load();
    await chats.flush([chat()]);
    await panels.load();
    await routines.load();
    await memory.update('character', 'mage', 'goal', 'Preserve this');
    await chats.close();
    await memory.update('character', 'mage', 'another', 'Still open');
    expect(database.connection).toBe(connection);
    expect(await memory.read('character', 'mage')).toHaveLength(2);
    await database.close();
    expect(() => connection.prepare('SELECT 1')).toThrow();
    await expect(memory.read('character', 'mage')).rejects.toThrow('closed');
  } finally {
    await chats.close();
    await scope.close();
    await rm(root, { recursive: true, force: true });
  }
});
