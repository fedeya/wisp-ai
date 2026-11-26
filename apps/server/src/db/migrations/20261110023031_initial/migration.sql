CREATE TABLE `chat_instance_state` (
	`instance_id` text NOT NULL,
	`chat_id` text NOT NULL,
	`revision` integer NOT NULL,
	`history_revision` integer NOT NULL,
	`owner` text NOT NULL,
	`eve_id` text,
	`unread` integer,
	`model_settings` text,
	`model_request_id` text,
	`model_error` text,
	`usage` text,
	`last_ui_result` text,
	CONSTRAINT `chat_instance_state_pk` PRIMARY KEY(`instance_id`, `chat_id`),
	CONSTRAINT `fk_chat_instance_state_chat_id_chats_id_fk` FOREIGN KEY (`chat_id`) REFERENCES `chats`(`id`) ON DELETE CASCADE,
	CONSTRAINT "instance_revision" CHECK("revision" >= 0 AND "history_revision" >= 0),
	CONSTRAINT "instance_unread" CHECK("unread" IS NULL OR "unread" IN (0,1)),
	CONSTRAINT "instance_model" CHECK("model_settings" IS NULL OR json_valid("model_settings")),
	CONSTRAINT "instance_usage" CHECK("usage" IS NULL OR json_valid("usage")),
	CONSTRAINT "instance_ui" CHECK("last_ui_result" IS NULL OR json_valid("last_ui_result"))
) STRICT;
--> statement-breakpoint
CREATE TABLE `chats` (
	`id` text PRIMARY KEY,
	`sort_index` integer NOT NULL,
	`title` text NOT NULL,
	`status` text NOT NULL,
	`character_key` text,
	`last_used_at` real,
	`last_activity_at` real,
	`revision` integer NOT NULL,
	`extras` text NOT NULL,
	CONSTRAINT "chats_revision" CHECK("revision" >= 0),
	CONSTRAINT "chats_status" CHECK("status" IN ('idle','working','interrupted','needs_input','cancelled','done','error')),
	CONSTRAINT "chats_extras" CHECK(json_valid("extras") AND json_type("extras") = 'object')
) STRICT;
--> statement-breakpoint
CREATE TABLE `memory_entries` (
	`slot` text NOT NULL,
	`owner` text NOT NULL,
	`key` text NOT NULL,
	`sort_index` integer NOT NULL,
	`text` text NOT NULL,
	`updated_at` text NOT NULL,
	`extras` text NOT NULL,
	CONSTRAINT `memory_entries_pk` PRIMARY KEY(`slot`, `owner`, `key`),
	CONSTRAINT `fk_memory_entries_slot_owner_memory_scopes_slot_owner_fk` FOREIGN KEY (`slot`,`owner`) REFERENCES `memory_scopes`(`slot`,`owner`) ON DELETE CASCADE,
	CONSTRAINT "memory_entry_slot" CHECK("slot" IN ('preferences','character')),
	CONSTRAINT "memory_entry_extras" CHECK(json_valid("extras") AND json_type("extras") = 'object')
) STRICT;
--> statement-breakpoint
CREATE TABLE `memory_scopes` (
	`slot` text NOT NULL,
	`owner` text NOT NULL,
	`extras` text NOT NULL,
	CONSTRAINT `memory_scopes_pk` PRIMARY KEY(`slot`, `owner`),
	CONSTRAINT "memory_slot" CHECK("slot" IN ('preferences','character')),
	CONSTRAINT "memory_scope_extras" CHECK(json_valid("extras") AND json_type("extras") = 'object')
) STRICT;
--> statement-breakpoint
CREATE TABLE `messages` (
	`id` text PRIMARY KEY,
	`chat_id` text NOT NULL,
	`position` integer NOT NULL,
	`source_id` text,
	`role` text NOT NULL,
	`text` text NOT NULL,
	`extras` text NOT NULL,
	CONSTRAINT `fk_messages_chat_id_chats_id_fk` FOREIGN KEY (`chat_id`) REFERENCES `chats`(`id`) ON DELETE CASCADE,
	CONSTRAINT "messages_position" CHECK("position" >= 0),
	CONSTRAINT "messages_role" CHECK("role" IN ('user','assistant','system','tool')),
	CONSTRAINT "messages_extras" CHECK(json_valid("extras") AND json_type("extras") = 'object')
) STRICT;
--> statement-breakpoint
CREATE TABLE `metadata` (
	`key` text PRIMARY KEY,
	`value` text NOT NULL
) STRICT;
--> statement-breakpoint
CREATE TABLE `panels` (
	`character_key` text NOT NULL,
	`id` text NOT NULL,
	`sort_index` integer NOT NULL,
	`title` text NOT NULL,
	`updated_at` real NOT NULL,
	`content` text NOT NULL,
	CONSTRAINT `panels_pk` PRIMARY KEY(`character_key`, `id`),
	CONSTRAINT "panels_content" CHECK(json_valid("content") AND json_type("content") = 'object')
) STRICT;
--> statement-breakpoint
CREATE TABLE `routine_runs` (
	`id` text PRIMARY KEY,
	`character_key` text NOT NULL,
	`routine_id` text NOT NULL,
	`sort_index` integer NOT NULL,
	`title` text NOT NULL,
	`started_at` real NOT NULL,
	`finished_at` real,
	`event` text NOT NULL,
	`status` text NOT NULL,
	`summary` text,
	`extras` text NOT NULL,
	CONSTRAINT "routine_runs_status" CHECK("status" IN ('running','done','no_tip','error','cancelled','interrupted')),
	CONSTRAINT "routine_runs_extras" CHECK(json_valid("extras") AND json_type("extras") = 'object')
) STRICT;
--> statement-breakpoint
CREATE TABLE `routines` (
	`character_key` text NOT NULL,
	`id` text NOT NULL,
	`sort_index` integer NOT NULL,
	`title` text NOT NULL,
	`enabled` integer NOT NULL,
	`next_at` real NOT NULL,
	`updated_at` real NOT NULL,
	`content` text NOT NULL,
	CONSTRAINT `routines_pk` PRIMARY KEY(`character_key`, `id`),
	CONSTRAINT "routines_enabled" CHECK("enabled" IN (0,1)),
	CONSTRAINT "routines_content" CHECK(json_valid("content") AND json_type("content") = 'object')
) STRICT;
--> statement-breakpoint
CREATE INDEX `chats_character_activity` ON `chats` (`character_key`,`last_activity_at`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `messages_chat_position` ON `messages` (`chat_id`,`position`);--> statement-breakpoint
CREATE INDEX `routine_runs_order` ON `routine_runs` (`sort_index`);--> statement-breakpoint
CREATE INDEX `routine_runs_history` ON `routine_runs` (`character_key`,`routine_id`,`sort_index`);--> statement-breakpoint
CREATE INDEX `routine_runs_success` ON `routine_runs` (`character_key`,`routine_id`,`sort_index`) WHERE "routine_runs"."status" = 'done';--> statement-breakpoint
CREATE INDEX `routine_runs_visible` ON `routine_runs` (`sort_index`) WHERE "routine_runs"."status" <> 'no_tip';--> statement-breakpoint
CREATE INDEX `routine_runs_character_visible` ON `routine_runs` (`character_key`,`sort_index`) WHERE "routine_runs"."status" <> 'no_tip';--> statement-breakpoint
CREATE INDEX `routines_due` ON `routines` (`character_key`,`enabled`,`next_at`);