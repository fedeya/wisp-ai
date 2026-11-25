CREATE TABLE `agent_messages` (
	`session_id` text NOT NULL,
	`position` integer NOT NULL,
	`role` text NOT NULL,
	`created_at` integer NOT NULL,
	`message` text NOT NULL,
	CONSTRAINT `agent_messages_pk` PRIMARY KEY(`session_id`, `position`),
	CONSTRAINT `fk_agent_messages_session_id_agent_sessions_id_fk` FOREIGN KEY (`session_id`) REFERENCES `agent_sessions`(`id`) ON DELETE CASCADE,
	CONSTRAINT "agent_message_position" CHECK("position" >= 0),
	CONSTRAINT "agent_message_role" CHECK("role" IN ('user','assistant','tool','system')),
	CONSTRAINT "agent_message_json" CHECK(json_valid("message"))
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
	`compacted_at` integer,
	`tokens_input` integer DEFAULT 0 NOT NULL,
	`tokens_output` integer DEFAULT 0 NOT NULL,
	`tokens_reasoning` integer DEFAULT 0 NOT NULL,
	`tokens_cache_read` integer DEFAULT 0 NOT NULL,
	`tokens_cache_write` integer DEFAULT 0 NOT NULL,
	CONSTRAINT "agent_session_tokens" CHECK("tokens_input" >= 0 AND "tokens_output" >= 0 AND "tokens_reasoning" >= 0 AND "tokens_cache_read" >= 0 AND "tokens_cache_write" >= 0)
) STRICT;
--> statement-breakpoint
ALTER TABLE `chat_instance_state` ADD `agent_session` text;--> statement-breakpoint
CREATE INDEX `agent_sessions_chat` ON `agent_sessions` (`chat_id`);
--> statement-breakpoint
-- Eve kept these sessions in the engine folder, which this version removes.
UPDATE `chat_instance_state` SET `eve_id` = NULL;
