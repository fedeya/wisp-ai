import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
} from 'drizzle-orm/sqlite-core';

export const metadata = sqliteTable('metadata', {
  key: text().primaryKey(),
  value: text().notNull(),
});

export const chats = sqliteTable(
  'chats',
  {
    id: text().primaryKey(),
    sortIndex: integer('sort_index').notNull(),
    characterKey: text('character_key'),
    lastActivity: real('last_activity').notNull(),
    revision: integer().notNull(),
    metadata: text().notNull(),
  },
  (t) => [
    index('chats_character_activity').on(t.characterKey, t.lastActivity),
    check('chats_revision', sql`${t.revision} >= 0`),
    check('chats_metadata', sql`json_valid(${t.metadata})`),
  ],
);

export const messages = sqliteTable(
  'messages',
  {
    chatId: text('chat_id')
      .notNull()
      .references(() => chats.id, { onDelete: 'cascade' }),
    position: integer().notNull(),
    content: text().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.chatId, t.position] }),
    check('messages_position', sql`${t.position} >= 0`),
    check('messages_content', sql`json_valid(${t.content})`),
  ],
);
