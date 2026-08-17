CREATE TABLE `sbl_agent_conversations` (
	`id` varchar(36) NOT NULL,
	`user_id` varchar(36) NOT NULL,
	`project_id` varchar(36),
	`title` varchar(255) NOT NULL DEFAULT '新会话',
	`scope` varchar(16) NOT NULL DEFAULT 'project',
	`status` varchar(16) NOT NULL DEFAULT 'idle',
	`runtime` varchar(32) NOT NULL DEFAULT 'jw',
	`external_session_id` varchar(128),
	`legacy_source` varchar(32),
	`legacy_conversation_id` varchar(64),
	`model_id` varchar(128),
	`metadata` json NOT NULL DEFAULT (JSON_OBJECT()),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `sbl_agent_conversations_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_agent_conversations_legacy` UNIQUE(`legacy_source`,`legacy_conversation_id`)
);
--> statement-breakpoint
CREATE TABLE `sbl_agent_message_parts` (
	`id` varchar(36) NOT NULL,
	`message_id` varchar(36) NOT NULL,
	`part_index` int NOT NULL,
	`type` varchar(32) NOT NULL,
	`content` longtext,
	`payload` json,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `sbl_agent_message_parts_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_agent_message_parts_order` UNIQUE(`message_id`,`part_index`)
);
--> statement-breakpoint
CREATE TABLE `sbl_agent_messages` (
	`id` varchar(36) NOT NULL,
	`conversation_id` varchar(36) NOT NULL,
	`external_message_id` varchar(128),
	`role` varchar(16) NOT NULL,
	`sequence` int NOT NULL,
	`content` longtext,
	`tool_name` varchar(128),
	`tool_input` json,
	`tool_output` json,
	`thinking` longtext,
	`status` varchar(16) NOT NULL DEFAULT 'complete',
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `sbl_agent_messages_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_agent_messages_external` UNIQUE(`conversation_id`,`external_message_id`)
);
--> statement-breakpoint
ALTER TABLE `sbl_agent_conversations` ADD CONSTRAINT `sbl_agent_conversations_user_id_sbl_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `sbl_users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `sbl_agent_conversations` ADD CONSTRAINT `sbl_agent_conversations_project_id_sbl_projects_id_fk` FOREIGN KEY (`project_id`) REFERENCES `sbl_projects`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `sbl_agent_message_parts` ADD CONSTRAINT `sbl_agent_message_parts_message_id_sbl_agent_messages_id_fk` FOREIGN KEY (`message_id`) REFERENCES `sbl_agent_messages`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `sbl_agent_messages` ADD CONSTRAINT `sbl_agent_messages_conversation_id_sbl_agent_conversations_id_fk` FOREIGN KEY (`conversation_id`) REFERENCES `sbl_agent_conversations`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `idx_agent_conversations_user` ON `sbl_agent_conversations` (`user_id`);--> statement-breakpoint
CREATE INDEX `idx_agent_conversations_project` ON `sbl_agent_conversations` (`project_id`);--> statement-breakpoint
CREATE INDEX `idx_agent_conversations_updated` ON `sbl_agent_conversations` (`updated_at`);--> statement-breakpoint
CREATE INDEX `idx_agent_conversations_external` ON `sbl_agent_conversations` (`external_session_id`);--> statement-breakpoint
CREATE INDEX `idx_agent_messages_conversation_sequence` ON `sbl_agent_messages` (`conversation_id`,`sequence`);