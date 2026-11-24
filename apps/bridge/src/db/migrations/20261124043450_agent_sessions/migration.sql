CREATE TABLE `agent_messages` (
	`session` text NOT NULL,
	`position` integer NOT NULL,
	`message` text NOT NULL,
	CONSTRAINT `agent_messages_pk` PRIMARY KEY(`session`, `position`),
	CONSTRAINT "agent_message_position" CHECK("position" >= 0),
	CONSTRAINT "agent_message_json" CHECK(json_valid("message"))
) STRICT;
--> statement-breakpoint
ALTER TABLE `chat_instance_state` ADD `agent_session` text;
--> statement-breakpoint
-- Eve kept these sessions in the engine folder, which this version removes.
UPDATE `chat_instance_state` SET `eve_id` = NULL;