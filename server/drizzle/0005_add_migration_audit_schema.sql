CREATE TABLE `sbl_agent_conversation_source_mappings` (
	`id` varchar(36) NOT NULL,
	`conversation_id` varchar(36) NOT NULL,
	`source_system` varchar(32) NOT NULL,
	`source_conversation_id` varchar(191) NOT NULL,
	`source_instance_id` varchar(191),
	`source_checksum` varchar(64) NOT NULL,
	`metadata` json NOT NULL DEFAULT (JSON_OBJECT()),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `sbl_agent_conversation_source_mappings_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_agent_conversation_source` UNIQUE(`source_system`,`source_conversation_id`)
);
--> statement-breakpoint
CREATE TABLE `sbl_agent_message_source_mappings` (
	`id` varchar(36) NOT NULL,
	`message_id` varchar(36) NOT NULL,
	`source_system` varchar(32) NOT NULL,
	`source_conversation_id` varchar(191) NOT NULL,
	`source_message_id` varchar(191) NOT NULL,
	`source_checksum` varchar(64) NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `sbl_agent_message_source_mappings_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_agent_message_source` UNIQUE(`source_system`,`source_conversation_id`,`source_message_id`)
);
--> statement-breakpoint
CREATE TABLE `sbl_migration_issues` (
	`id` varchar(36) NOT NULL,
	`run_id` varchar(36) NOT NULL,
	`severity` varchar(16) NOT NULL,
	`source_system` varchar(32) NOT NULL,
	`source_table` varchar(64),
	`source_key` varchar(255),
	`code` varchar(64) NOT NULL,
	`message` text NOT NULL,
	`payload` json NOT NULL DEFAULT (JSON_OBJECT()),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `sbl_migration_issues_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `sbl_migration_runs` (
	`id` varchar(36) NOT NULL,
	`migration_type` varchar(64) NOT NULL,
	`source_locator` text NOT NULL,
	`source_sha256` varchar(64) NOT NULL,
	`mode` varchar(16) NOT NULL,
	`status` varchar(16) NOT NULL DEFAULT 'running',
	`source_counts` json NOT NULL DEFAULT (JSON_OBJECT()),
	`target_counts` json NOT NULL DEFAULT (JSON_OBJECT()),
	`source_checksum` varchar(64),
	`target_checksum` varchar(64),
	`report` json NOT NULL DEFAULT (JSON_OBJECT()),
	`started_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`completed_at` datetime(3),
	CONSTRAINT `sbl_migration_runs_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `sbl_agent_conversation_source_mappings` ADD CONSTRAINT `fk_agent_conv_source_conversation` FOREIGN KEY (`conversation_id`) REFERENCES `sbl_agent_conversations`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `sbl_agent_message_source_mappings` ADD CONSTRAINT `fk_agent_message_source_message` FOREIGN KEY (`message_id`) REFERENCES `sbl_agent_messages`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `sbl_migration_issues` ADD CONSTRAINT `fk_migration_issue_run` FOREIGN KEY (`run_id`) REFERENCES `sbl_migration_runs`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `idx_agent_conversation_source_target` ON `sbl_agent_conversation_source_mappings` (`conversation_id`);--> statement-breakpoint
CREATE INDEX `idx_agent_message_source_target` ON `sbl_agent_message_source_mappings` (`message_id`);--> statement-breakpoint
CREATE INDEX `idx_migration_issues_run` ON `sbl_migration_issues` (`run_id`);--> statement-breakpoint
CREATE INDEX `idx_migration_issues_code` ON `sbl_migration_issues` (`code`);--> statement-breakpoint
CREATE INDEX `idx_migration_runs_type_started` ON `sbl_migration_runs` (`migration_type`,`started_at`);--> statement-breakpoint
CREATE INDEX `idx_migration_runs_source_sha` ON `sbl_migration_runs` (`source_sha256`);