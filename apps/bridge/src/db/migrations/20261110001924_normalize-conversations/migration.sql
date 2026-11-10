-- Backfill into new tables before removing the legacy ones. Foreign keys stay
-- enabled throughout; the migration runner validates all legacy chats first.
CREATE TABLE __new_chats (
  id TEXT PRIMARY KEY NOT NULL,
  sort_index INTEGER NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('idle','working','interrupted','needs_input','cancelled','done','error')),
  character_key TEXT,
  last_used_at REAL,
  last_activity_at REAL,
  revision INTEGER NOT NULL CHECK(revision >= 0),
  extras TEXT NOT NULL CHECK(json_valid(extras) AND json_type(extras) = 'object')
) STRICT;
--> statement-breakpoint
INSERT INTO __new_chats
SELECT id, sort_index, json_extract(metadata, '$.title'), json_extract(metadata, '$.status'),
  json_extract(metadata, '$.characterKey'), json_extract(metadata, '$.lastUsedAt'),
  json_extract(metadata, '$.lastActivityAt'), revision,
  json_remove(metadata, '$.id', '$.title', '$.status', '$.characterKey', '$.lastUsedAt', '$.lastActivityAt',
    '$.owner', '$.eveId', '$.unread', '$.modelSettings', '$.modelRequestId', '$.modelError', '$.usage', '$.lastUIResult')
FROM chats;
--> statement-breakpoint
CREATE TABLE __new_messages (
  id TEXT PRIMARY KEY NOT NULL,
  chat_id TEXT NOT NULL REFERENCES __new_chats(id) ON DELETE CASCADE,
  position INTEGER NOT NULL CHECK(position >= 0),
  source_id TEXT,
  role TEXT NOT NULL CHECK(role IN ('user','assistant','system','tool')),
  text TEXT NOT NULL,
  extras TEXT NOT NULL CHECK(json_valid(extras) AND json_type(extras) = 'object')
) STRICT;
--> statement-breakpoint
INSERT INTO __new_messages
SELECT lower(hex(randomblob(16))), chat_id, position, json_extract(content, '$.id'),
  json_extract(content, '$.role'), json_extract(content, '$.text'),
  json_remove(content, '$.id', '$.role', '$.text')
FROM messages;
--> statement-breakpoint
CREATE TABLE chat_instance_state (
  instance_id TEXT NOT NULL,
  chat_id TEXT NOT NULL REFERENCES __new_chats(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL CHECK(revision >= 0),
  history_revision INTEGER NOT NULL CHECK(history_revision >= 0),
  owner TEXT NOT NULL,
  eve_id TEXT,
  unread INTEGER CHECK(unread IS NULL OR unread IN (0,1)),
  model_settings TEXT CHECK(model_settings IS NULL OR json_valid(model_settings)),
  model_request_id TEXT,
  model_error TEXT,
  usage TEXT CHECK(usage IS NULL OR json_valid(usage)),
  last_ui_result TEXT CHECK(last_ui_result IS NULL OR json_valid(last_ui_result)),
  PRIMARY KEY(instance_id, chat_id)
) STRICT;
--> statement-breakpoint
INSERT INTO chat_instance_state
SELECT '__legacy__', id, 0, revision, json_extract(metadata, '$.owner'),
  json_extract(metadata, '$.eveId'), json_extract(metadata, '$.unread'),
  metadata -> '$.modelSettings',
  json_extract(metadata, '$.modelRequestId'), json_extract(metadata, '$.modelError'),
  metadata -> '$.usage', metadata -> '$.lastUIResult'
FROM chats;
--> statement-breakpoint
DROP TABLE messages;
--> statement-breakpoint
DROP TABLE chats;
--> statement-breakpoint
ALTER TABLE __new_chats RENAME TO chats;
--> statement-breakpoint
ALTER TABLE __new_messages RENAME TO messages;
--> statement-breakpoint
CREATE INDEX chats_character_activity ON chats(character_key, last_activity_at, id);
--> statement-breakpoint
CREATE UNIQUE INDEX messages_chat_position ON messages(chat_id, position);
