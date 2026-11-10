CREATE TABLE `routine_instance_state` (
	`instance_id` text NOT NULL,
	`character_key` text NOT NULL,
	`routine_id` text NOT NULL,
	`definition_updated_at` real NOT NULL,
	`next_at` real NOT NULL,
	`last_started_at` real,
	`pending` text,
	`completed_once` integer DEFAULT false NOT NULL,
	CONSTRAINT `routine_instance_state_pk` PRIMARY KEY(`instance_id`, `character_key`, `routine_id`),
	CONSTRAINT `fk_routine_instance_state_character_key_routine_id_routines_character_key_id_fk` FOREIGN KEY (`character_key`,`routine_id`) REFERENCES `routines`(`character_key`,`id`) ON DELETE CASCADE,
	CONSTRAINT "routine_instance_pending" CHECK("pending" IS NULL OR json_valid("pending")),
	CONSTRAINT "routine_instance_completed" CHECK("completed_once" IN (0,1))
) STRICT;
--> statement-breakpoint
CREATE TABLE `workspace_drafts` (
	`instance_id` text NOT NULL,
	`chat_id` text NOT NULL,
	`base_revision` integer,
	`content` text NOT NULL,
	CONSTRAINT `workspace_drafts_pk` PRIMARY KEY(`instance_id`, `chat_id`),
	CONSTRAINT "workspace_draft_content" CHECK(json_valid("content") AND json_type("content") = 'object')
) STRICT;
--> statement-breakpoint
ALTER TABLE `routine_runs` ADD `instance_id` text;