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
);
--> statement-breakpoint
CREATE TABLE `memory_scopes` (
	`slot` text NOT NULL,
	`owner` text NOT NULL,
	`extras` text NOT NULL,
	CONSTRAINT `memory_scopes_pk` PRIMARY KEY(`slot`, `owner`),
	CONSTRAINT "memory_slot" CHECK("slot" IN ('preferences','character')),
	CONSTRAINT "memory_scope_extras" CHECK(json_valid("extras") AND json_type("extras") = 'object')
);
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
);
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
);
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
);
--> statement-breakpoint
CREATE INDEX `routine_runs_history` ON `routine_runs` (`character_key`,`routine_id`,`started_at`);--> statement-breakpoint
CREATE INDEX `routines_due` ON `routines` (`character_key`,`enabled`,`next_at`);