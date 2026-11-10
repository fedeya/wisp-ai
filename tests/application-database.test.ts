import { test, expect } from 'vitest';
import {
  mkdtemp,
  readFile,
  writeFile,
  readdir,
  rm,
  unlink,
  access,
  chmod,
  stat,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { ChatStore } from '@wisp/bridge/chat-store';
import { newChat } from '@wisp/bridge/chat-lifecycle';
import { applicationDatabaseFile } from '@wisp/bridge/db/application-file';
import { migrateDesktop } from '@wisp/bridge/desktop-migration';

function chat(id = 'history') {
  return {
    ...newChat(id, 'game'),
    eveId: 'local-engine',
    title: 'Preserve history 🧙',
    messages: [{ role: 'user' as const, text: 'Keep every message' }],
  };
}
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'wisp-database-name-'));
  const stores: ChatStore[] = [];
  return {
    root,
    store(file: string) {
      const store = new ChatStore(file, () => {});
      stores.push(store);
      return store;
    },
    async close() {
      for (const store of stores) {
        await store.close();
      }
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    },
  };
}

test('JSON-only installations initialize wisp.sqlite and preserve the original JSON', async () => {
  const f = await fixture();
  try {
    const original = chat();
    const bytes = JSON.stringify([original], null, 2);
    await writeFile(path.join(f.root, 'chats.json'), bytes);
    const file = await applicationDatabaseFile(f.root);
    expect(file).toBe(path.join(f.root, 'wisp.sqlite'));
    expect((await f.store(file).load())[0]).toMatchObject(original);
    expect(await readFile(path.join(f.root, 'chats.json'), 'utf8')).toBe(bytes);
    await expect(access(path.join(f.root, 'chats.sqlite'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  } finally {
    await f.close();
  }
});

test('renaming snapshots committed WAL history, keeps private state and retains the source database', async () => {
  const f = await fixture();
  try {
    const oldFile = path.join(f.root, 'chats.sqlite');
    const old = f.store(oldFile);
    await old.load();
    const original = chat();
    await old.flush([original]);
    // Keep the source connection open so recent history is still in its WAL.
    expect((await readFile(oldFile + '-wal')).length).toBeGreaterThan(0);
    const sourceBytes = await readFile(oldFile);
    const file = await applicationDatabaseFile(f.root);
    const store = f.store(file);
    const loaded = await store.load();
    expect(loaded[0]).toMatchObject(original);
    expect(await readFile(oldFile)).toEqual(sourceBytes);
    expect((await readdir(f.root)).filter((name) => name.startsWith('.wisp-import-'))).toEqual([]);
    // An empty canonical database must never resurrect the retained legacy copy.
    await store.flush([]);
    await store.close();
    expect(await applicationDatabaseFile(f.root)).toBe(file);
    expect(await f.store(file).load()).toEqual([]);
  } finally {
    await f.close();
  }
});

test('failed filename migration never publishes an empty destination and can retry', async () => {
  const f = await fixture();
  try {
    const oldFile = path.join(f.root, 'chats.sqlite');
    await writeFile(oldFile, 'not a SQLite database');
    await expect(applicationDatabaseFile(f.root)).rejects.toThrow();
    expect(await readFile(oldFile, 'utf8')).toBe('not a SQLite database');
    await expect(access(path.join(f.root, 'wisp.sqlite'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect((await readdir(f.root)).filter((name) => name.startsWith('.wisp-import-'))).toEqual([]);
    await unlink(oldFile);
    const old = f.store(oldFile);
    await old.load();
    await old.flush([chat()]);
    await old.close();
    const file = await applicationDatabaseFile(f.root);
    expect((await f.store(file).load())[0].messages).toEqual(chat().messages);
  } finally {
    await f.close();
  }
});

test('an existing invalid wisp.sqlite fails instead of falling back to stale history', async () => {
  const f = await fixture();
  try {
    const old = f.store(path.join(f.root, 'chats.sqlite'));
    await old.load();
    await old.flush([chat()]);
    await old.close();
    const canonical = path.join(f.root, 'wisp.sqlite');
    await writeFile(canonical, 'invalid canonical database');
    expect(await applicationDatabaseFile(f.root)).toBe(canonical);
    await expect(f.store(canonical).load()).rejects.toThrow('preserved');
    expect(await readFile(canonical, 'utf8')).toBe('invalid canonical database');
  } finally {
    await f.close();
  }
});

test('simultaneous processes publish exactly one complete wisp.sqlite', async () => {
  const f = await fixture();
  try {
    const old = f.store(path.join(f.root, 'chats.sqlite'));
    await old.load();
    await old.flush([chat()]);
    await old.close();
    const source = `
      import { applicationDatabaseFile } from '@wisp/bridge/db/application-file';
      import { ChatStore } from '@wisp/bridge/chat-store';
      const file = await applicationDatabaseFile(process.argv[1]);
      const store = new ChatStore(file, (error) => { throw error; });
      try { console.log(JSON.stringify((await store.load()).map(c => c.id))); }
      finally { await store.close(); }
    `;
    const settled = await Promise.allSettled(
      [1, 2, 3].map(() =>
        promisify(execFile)(process.execPath, ['--input-type=module', '-e', source, f.root], {
          cwd: fileURLToPath(new URL('.', import.meta.url)),
          windowsHide: true,
        }),
      ),
    );
    const results = settled.map((result) => {
      if (result.status === 'rejected') {
        throw result.reason;
      }
      return result.value;
    });
    expect(results.map(({ stdout }) => JSON.parse(stdout))).toEqual([
      ['history'],
      ['history'],
      ['history'],
    ]);
    expect((await readdir(f.root)).filter((name) => name.startsWith('.wisp-import-'))).toEqual([]);
  } finally {
    await f.close();
  }
});

test('installation import prefers wisp.sqlite over a stale chats.sqlite source', async () => {
  const f = await fixture();
  try {
    const source = path.join(f.root, 'source');
    const destination = path.join(f.root, 'destination');
    const old = f.store(path.join(source, 'runtime/chats.sqlite'));
    await old.load();
    await old.flush([chat()]);
    await old.close();
    const canonical = f.store(path.join(source, 'runtime/wisp.sqlite'));
    await canonical.load();
    await canonical.close();
    await writeFile(path.join(source, 'config.local.json'), JSON.stringify({ wow: 'fixture-wow' }));
    await writeFile(path.join(source, 'runtime/chats.json'), '{stale JSON');
    await migrateDesktop(source, destination, '');
    expect(await f.store(path.join(destination, 'runtime/wisp.sqlite')).load()).toEqual([]);
    await expect(access(path.join(destination, 'runtime/chats.sqlite'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect((await f.store(path.join(source, 'runtime/chats.sqlite')).load())[0].messages).toEqual(
      chat().messages,
    );
  } finally {
    await f.close();
  }
});

test.runIf(process.platform !== 'win32')(
  'the retained legacy database backup and its sidecars stay private',
  async () => {
    const f = await fixture();
    try {
      const oldFile = path.join(f.root, 'chats.sqlite');
      const old = f.store(oldFile);
      await old.load();
      await old.flush([chat()]);
      for (const suffix of ['', '-wal', '-shm']) {
        await chmod(oldFile + suffix, 0o644);
      }
      const file = await applicationDatabaseFile(f.root);
      const current = f.store(file);
      const loaded = await current.load();
      loaded[0].title = 'Updated in the canonical database';
      await current.flush(loaded);
      for (const base of [oldFile, file]) {
        for (const suffix of ['', '-wal', '-shm']) {
          expect((await stat(base + suffix)).mode & 0o777).toBe(0o600);
        }
      }
    } finally {
      await f.close();
    }
  },
);
