import { access, cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { ChatStore, conversationInstanceId } from './chat-store.ts';
import { ProductDatabase } from './db/product-store.ts';
import {
  copyDatabaseSnapshot,
  findApplicationDatabase,
  DATABASE_NAME,
} from './db/application-file.ts';

async function stopPreviousBridge(source: string) {
  let identity: { port?: number; token?: string };
  try {
    identity = JSON.parse(await readFile(path.join(source, 'runtime/desktop.json'), 'utf8'));
  } catch (error) {
    if (error instanceof SyntaxError || (error as NodeJS.ErrnoException).code === 'ENOENT') {
      return;
    }
    throw error;
  }
  if (
    !Number.isInteger(identity.port) ||
    identity.port! < 1 ||
    identity.port! > 65535 ||
    typeof identity.token !== 'string'
  ) {
    return;
  }
  try {
    const response = await fetch('http://127.0.0.1:' + identity.port + '/stop', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + identity.token, 'content-type': 'application/json' },
      body: '{}',
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) {
      throw Error(
        'Close the previous Wisp application after its active reply finishes, then import again.',
      );
    }
    for (let attempt = 0; attempt < 50; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      try {
        await fetch('http://127.0.0.1:' + identity.port + '/status', {
          headers: { authorization: 'Bearer ' + identity.token },
          signal: AbortSignal.timeout(1000),
        });
      } catch {
        return;
      }
    }
    throw Error('The previous Wisp bridge is still stopping. Try again in a moment.');
  } catch (error) {
    if (error instanceof TypeError && /fetch failed/i.test(error.message)) {
      return;
    }
    throw error;
  }
}

export async function migrateDesktop(
  source: string,
  destination: string,
  localAppData = process.env.LOCALAPPDATA,
) {
  source = path.resolve(source);
  destination = path.resolve(destination);
  if (source === destination) {
    throw Error('Choose the previous Wisp installation folder.');
  }
  try {
    await access(path.join(destination, 'config.local.json'));
    throw Error('This installation is already configured; no data was overwritten.');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }
  const config = JSON.parse(await readFile(path.join(source, 'config.local.json'), 'utf8'));
  if (typeof config.wow !== 'string') {
    throw Error('This folder does not contain a Wisp installation.');
  }
  await stopPreviousBridge(source);
  await mkdir(path.join(destination, 'runtime'), { recursive: true });
  // Use SQLite's snapshot API so committed WAL pages are included as well.
  const databaseFile = path.join(destination, 'runtime', DATABASE_NAME);
  const sourceDatabase = await findApplicationDatabase(path.join(source, 'runtime'));
  if (sourceDatabase) {
    await copyDatabaseSnapshot(sourceDatabase, databaseFile);
  }
  const allowed = [
    'chats.json',
    'memory',
    'mcp.json',
    'panels.json',
    'routines.json',
    'suggestions.json',
    'capabilities.json',
    'advice-history.json',
    'chatgpt-host.json',
  ];
  for (const name of allowed) {
    try {
      await cp(path.join(source, 'runtime', name), path.join(destination, 'runtime', name), {
        recursive: true,
        force: false,
        errorOnExist: true,
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
  }
  if (!sourceDatabase) {
    const chatsFile = path.join(destination, 'runtime/chats.json');
    try {
      const chats = JSON.parse(await readFile(chatsFile, 'utf8'));
      if (!Array.isArray(chats)) {
        throw Error('Invalid conversation history.');
      }
      for (const chat of chats) {
        if (chat && typeof chat === 'object') {
          delete chat.eveId;
          if (chat.status === 'working') {
            chat.status = 'interrupted';
          }
        }
      }
      await writeFile(chatsFile, JSON.stringify(chats, null, 2));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
  }
  // The copied database is authoritative when both formats are present.
  if (sourceDatabase) {
    const store = new ChatStore(databaseFile, () => {}, undefined, {
      inheritInstanceId: conversationInstanceId(path.join(source, 'runtime')),
    });
    try {
      const chats = await store.load();
      for (const chat of chats) {
        delete chat.eveId;
      }
      await store.flush(chats);
    } finally {
      await store.close();
    }
  }
  await new ProductDatabase(databaseFile).initialize();
  if (localAppData) {
    const hash = createHash('sha256').update(source).digest('hex');
    const secrets = path.join(localAppData, 'WispAI', 'Secrets', hash);
    let entries: string[] = [];
    try {
      entries = await readdir(secrets);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
    await mkdir(path.join(destination, 'secrets'), { recursive: true });
    for (const name of entries.filter((name) => /^[a-f0-9]{64}\.bin$/.test(name))) {
      await cp(path.join(secrets, name), path.join(destination, 'secrets', name), {
        force: false,
        errorOnExist: true,
      });
    }
  }
  // Commit configuration last: a failed import never starts a partially migrated account.
  await writeFile(
    path.join(destination, 'config.local.json'),
    JSON.stringify({ wow: config.wow, model: config.model || '' }, null, 2),
    { flag: 'wx' },
  );
}
