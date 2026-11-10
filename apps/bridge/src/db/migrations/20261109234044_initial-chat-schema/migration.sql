CREATE TABLE IF NOT EXISTS `chats` (
	`id` text PRIMARY KEY,
	`sort_index` integer NOT NULL,
	`character_key` text,
	`last_activity` real NOT NULL,
	`revision` integer NOT NULL,
	`metadata` text NOT NULL,
	CONSTRAINT "chats_revision" CHECK("revision" >= 0),
	CONSTRAINT "chats_metadata" CHECK(json_valid("metadata"))
) STRICT;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `messages` (
	`chat_id` text NOT NULL,
	`position` integer NOT NULL,
	`content` text NOT NULL,
	CONSTRAINT `messages_pk` PRIMARY KEY(`chat_id`, `position`),
	CONSTRAINT `fk_messages_chat_id_chats_id_fk` FOREIGN KEY (`chat_id`) REFERENCES `chats`(`id`) ON DELETE CASCADE,
	CONSTRAINT "messages_position" CHECK("position" >= 0),
	CONSTRAINT "messages_content" CHECK(json_valid("content"))
) STRICT;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `metadata` (
	`key` text PRIMARY KEY,
	`value` text NOT NULL
) STRICT;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `chats_character_activity` ON `chats` (`character_key`,`last_activity`);