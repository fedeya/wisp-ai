CREATE TABLE `agent_entries` (
	`session_id` text NOT NULL,
	`seq` integer NOT NULL,
	`type` text NOT NULL,
	`role` text,
	`model` text NOT NULL,
	`created_at` integer NOT NULL,
	`data` text NOT NULL,
	CONSTRAINT `agent_entries_pk` PRIMARY KEY(`session_id`, `seq`),
	CONSTRAINT `fk_agent_entries_session_id_agent_sessions_id_fk` FOREIGN KEY (`session_id`) REFERENCES `agent_sessions`(`id`) ON DELETE CASCADE,
	CONSTRAINT "agent_entry_seq" CHECK("seq" >= 0),
	CONSTRAINT "agent_entry_type" CHECK(("type" = 'message' AND "role" IN ('user','assistant','tool','system')) OR ("type" = 'compaction' AND "role" IS NULL)),
	CONSTRAINT "agent_entry_json" CHECK(json_valid("data") AND json_type("data") = 'object')
) STRICT;
--> statement-breakpoint
CREATE TABLE `agent_sessions` (
	`id` text PRIMARY KEY,
	`chat_id` text NOT NULL,
	`model` text NOT NULL,
	`format` text NOT NULL,
	`wisp_version` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`tokens_input` integer DEFAULT 0 NOT NULL,
	`tokens_output` integer DEFAULT 0 NOT NULL,
	`tokens_reasoning` integer DEFAULT 0 NOT NULL,
	`tokens_cache_read` integer DEFAULT 0 NOT NULL,
	`tokens_cache_write` integer DEFAULT 0 NOT NULL,
	CONSTRAINT "agent_session_tokens" CHECK("tokens_input" >= 0 AND "tokens_output" >= 0 AND "tokens_reasoning" >= 0 AND "tokens_cache_read" >= 0 AND "tokens_cache_write" >= 0)
) STRICT;
--> statement-breakpoint
ALTER TABLE `chat_instance_state` ADD `agent_session` text;--> statement-breakpoint
CREATE INDEX `agent_entries_type` ON `agent_entries` (`session_id`,`type`,`seq`);--> statement-breakpoint
CREATE INDEX `agent_sessions_chat` ON `agent_sessions` (`chat_id`);
--> statement-breakpoint
-- Eve kept these sessions in the engine folder, which this version removes.
UPDATE `chat_instance_state` SET `eve_id` = NULL;
