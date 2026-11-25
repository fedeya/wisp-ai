import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
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

export const routines = sqliteTable(
  'routines',
  {
    characterKey: text('character_key').notNull(),
    id: text().notNull(),
    sortIndex: integer('sort_index').notNull(),
    title: text().notNull(),
    enabled: integer({ mode: 'boolean' }).notNull(),
    nextAt: real('next_at').notNull(),
    updatedAt: real('updated_at').notNull(),
    content: text().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.characterKey, t.id] }),
    index('routines_due').on(t.characterKey, t.enabled, t.nextAt),
    check('routines_enabled', sql`${t.enabled} IN (0,1)`),
    check('routines_content', sql`json_valid(${t.content}) AND json_type(${t.content}) = 'object'`),
  ],
);

// Runs retain their history after the routine or its source conversation is removed.
export const routineRuns = sqliteTable(
  'routine_runs',
  {
    id: text().primaryKey().notNull(),
    characterKey: text('character_key').notNull(),
    routineId: text('routine_id').notNull(),
    sortIndex: integer('sort_index').notNull(),
    title: text().notNull(),
    startedAt: real('started_at').notNull(),
    finishedAt: real('finished_at'),
    event: text().notNull(),
    status: text().notNull(),
    summary: text(),
    extras: text().notNull(),
  },
  (t) => [
    index('routine_runs_order').on(t.sortIndex),
    index('routine_runs_history').on(t.characterKey, t.routineId, t.sortIndex),
    index('routine_runs_success')
      .on(t.characterKey, t.routineId, t.sortIndex)
      .where(sql`${t.status} = 'done'`),
    index('routine_runs_visible')
      .on(t.sortIndex)
      .where(sql`${t.status} <> 'no_tip'`),
    index('routine_runs_character_visible')
      .on(t.characterKey, t.sortIndex)
      .where(sql`${t.status} <> 'no_tip'`),
    check(
      'routine_runs_status',
      sql`${t.status} IN ('running','done','no_tip','error','cancelled','interrupted')`,
    ),
    check(
      'routine_runs_extras',
      sql`json_valid(${t.extras}) AND json_type(${t.extras}) = 'object'`,
    ),
  ],
);

export const panels = sqliteTable(
  'panels',
  {
    characterKey: text('character_key').notNull(),
    id: text().notNull(),
    sortIndex: integer('sort_index').notNull(),
    title: text().notNull(),
    updatedAt: real('updated_at').notNull(),
    content: text().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.characterKey, t.id] }),
    check('panels_content', sql`json_valid(${t.content}) AND json_type(${t.content}) = 'object'`),
  ],
);

export const memoryScopes = sqliteTable(
  'memory_scopes',
  {
    slot: text().notNull(),
    owner: text().notNull(),
    extras: text().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.slot, t.owner] }),
    check('memory_slot', sql`${t.slot} IN ('preferences','character')`),
    check(
      'memory_scope_extras',
      sql`json_valid(${t.extras}) AND json_type(${t.extras}) = 'object'`,
    ),
  ],
);

export const memoryEntries = sqliteTable(
  'memory_entries',
  {
    slot: text().notNull(),
    owner: text().notNull(),
    key: text().notNull(),
    sortIndex: integer('sort_index').notNull(),
    text: text().notNull(),
    updatedAt: text('updated_at').notNull(),
    extras: text().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.slot, t.owner, t.key] }),
    foreignKey({
      columns: [t.slot, t.owner],
      foreignColumns: [memoryScopes.slot, memoryScopes.owner],
    }).onDelete('cascade'),
    check('memory_entry_slot', sql`${t.slot} IN ('preferences','character')`),
    check(
      'memory_entry_extras',
      sql`json_valid(${t.extras}) AND json_type(${t.extras}) = 'object'`,
    ),
  ],
);

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
    // Written by versions that ran Eve. Kept, always null now, so an older version
    // can still read this database after a downgrade and start fresh sessions.
    eveId: text('eve_id'),
    agentSession: text('agent_session'),
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

/**
 * One agent session of a chat: the model-facing conversation the agent
 * resumes on each turn. A new session starts when the model or connection
 * changes, since provider-native history (reasoning signatures, response IDs)
 * is not portable.
 *
 * `chat_id` has no foreign key: a session starts on the chat's first turn,
 * before the chat's debounced save reaches this database. The chat store
 * deletes a chat's sessions with the chat, and startup removes sessions whose
 * chat was never saved.
 */
export const agentSessions = sqliteTable(
  'agent_sessions',
  {
    id: text().primaryKey().notNull(),
    chatId: text('chat_id').notNull(),
    /** The model slug the session was started with (`connection:<id>:<model>` for connections). */
    model: text().notNull(),
    /** How `agent_messages.message` is encoded, so a later format can migrate older rows. */
    format: text().notNull(),
    /** The Wisp version that started the session. */
    wispVersion: text('wisp_version').notNull(),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    compactedAt: integer('compacted_at'),
    // Totals the providers reported for this session's model calls.
    tokensInput: integer('tokens_input').notNull().default(0),
    tokensOutput: integer('tokens_output').notNull().default(0),
    tokensReasoning: integer('tokens_reasoning').notNull().default(0),
    tokensCacheRead: integer('tokens_cache_read').notNull().default(0),
    tokensCacheWrite: integer('tokens_cache_write').notNull().default(0),
  },
  (t) => [
    index('agent_sessions_chat').on(t.chatId),
    check(
      'agent_session_tokens',
      sql`${t.tokensInput} >= 0 AND ${t.tokensOutput} >= 0 AND ${t.tokensReasoning} >= 0 AND ${t.tokensCacheRead} >= 0 AND ${t.tokensCacheWrite} >= 0`,
    ),
  ],
);

/**
 * A session's history: user, assistant and tool messages in AI SDK form
 * (`agent_sessions.format`), tool calls and results with their call IDs
 * included. It is always loaded whole, in position order.
 */
export const agentMessages = sqliteTable(
  'agent_messages',
  {
    sessionId: text('session_id')
      .notNull()
      .references(() => agentSessions.id, { onDelete: 'cascade' }),
    position: integer().notNull(),
    role: text().$type<'user' | 'assistant' | 'tool' | 'system'>().notNull(),
    createdAt: integer('created_at').notNull(),
    message: text().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.sessionId, t.position] }),
    check('agent_message_position', sql`${t.position} >= 0`),
    check('agent_message_role', sql`${t.role} IN ('user','assistant','tool','system')`),
    check('agent_message_json', sql`json_valid(${t.message})`),
  ],
);
