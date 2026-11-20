import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync, backup } from 'node:sqlite';
import { ChatStore } from '../src/chat/chat-store.ts';
import { preparePrivateDatabase } from '../src/db/private-file.ts';
import { applicationDatabaseFile } from '../src/db/application-file.ts';
import { migrateReplies } from '../src/migrations/replies.ts';

// Run with Wisp stopped. The legacy JSON is imported by ChatStore if needed.
const root = process.env.WISP_DATA_DIR || fileURLToPath(new URL('../../..', import.meta.url));
const file = applicationDatabaseFile(path.join(root, 'runtime'));
const store = new ChatStore(file, (error) => {
  throw error;
});
try {
  const chats = await store.load();
  const snapshot = new DatabaseSync(file, { readOnly: true });
  const destination = path.join(root, `runtime/wisp.before-rich-stream-${Date.now()}.sqlite`);
  try {
    if (snapshot.prepare("SELECT id FROM chats WHERE status = 'working' LIMIT 1").get()) {
      throw Error('Wait for active turns and stop Wisp before migrating.');
    }
    await preparePrivateDatabase(destination);
    await backup(snapshot, destination);
  } finally {
    snapshot.close();
  }
  const result = migrateReplies(chats);
  await store.flush(chats);
  console.log(JSON.stringify({ ...result, backup: destination }));
} finally {
  await store.close();
}
