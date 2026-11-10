import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

export const metadata = sqliteTable('metadata', {
  key: text().primaryKey().notNull(),
  value: text().notNull(),
});

export const chats = sqliteTable(
  'chats',
  {
    id: text().primaryKey().notNull(),
    sortIndex: integer('sort_index').notNull(),
    title: text().notNull(),
    status: text()
      .$type<'idle' | 'working' | 'interrupted' | 'needs_input' | 'cancelled' | 'done' | 'error'>()
      .notNull(),
    characterKey: text('character_key'),
    lastUsedAt: real('last_used_at'),
    lastActivityAt: real('last_activity_at'),
    revision: integer().notNull(),
    extras: text().notNull(),
  },
  (t) => [
    index('chats_character_activity').on(t.characterKey, t.lastActivityAt, t.id),
    check('chats_revision', sql`${t.revision} >= 0`),
    check(
      'chats_status',
      sql`${t.status} IN ('idle','working','interrupted','needs_input','cancelled','done','error')`,
    ),
    check('chats_extras', sql`json_valid(${t.extras}) AND json_type(${t.extras}) = 'object'`),
  ],
);

export const messages = sqliteTable(
  'messages',
  {
    id: text().primaryKey().notNull(),
    chatId: text('chat_id')
      .notNull()
      .references(() => chats.id, { onDelete: 'cascade' }),
    position: integer().notNull(),
    sourceId: text('source_id'),
    role: text().$type<'user' | 'assistant' | 'system' | 'tool'>().notNull(),
    text: text().notNull(),
    extras: text().notNull(),
  },
  (t) => [
    uniqueIndex('messages_chat_position').on(t.chatId, t.position),
    check('messages_position', sql`${t.position} >= 0`),
    check('messages_role', sql`${t.role} IN ('user','assistant','system','tool')`),
    check('messages_extras', sql`json_valid(${t.extras}) AND json_type(${t.extras}) = 'object'`),
  ],
);

export const chatInstanceState = sqliteTable(
  'chat_instance_state',
  {
    instanceId: text('instance_id').notNull(),
    chatId: text('chat_id')
      .notNull()
      .references(() => chats.id, { onDelete: 'cascade' }),
    revision: integer().notNull(),
    historyRevision: integer('history_revision').notNull(),
    owner: text().notNull(),
    eveId: text('eve_id'),
    unread: integer({ mode: 'boolean' }),
    modelSettings: text('model_settings'),
    modelRequestId: text('model_request_id'),
    modelError: text('model_error'),
    usage: text(),
    lastUIResult: text('last_ui_result'),
  },
  (t) => [
    primaryKey({ columns: [t.instanceId, t.chatId] }),
    check('instance_revision', sql`${t.revision} >= 0 AND ${t.historyRevision} >= 0`),
    check('instance_unread', sql`${t.unread} IS NULL OR ${t.unread} IN (0,1)`),
    check('instance_model', sql`${t.modelSettings} IS NULL OR json_valid(${t.modelSettings})`),
    check('instance_usage', sql`${t.usage} IS NULL OR json_valid(${t.usage})`),
    check('instance_ui', sql`${t.lastUIResult} IS NULL OR json_valid(${t.lastUIResult})`),
  ],
);
