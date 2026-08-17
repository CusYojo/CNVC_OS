CREATE TABLE `sbl_ai_capabilities` (
	`id` varchar(36) NOT NULL,
	`kind` varchar(16) NOT NULL,
	`capability_key` varchar(128) NOT NULL,
	`name` varchar(128) NOT NULL,
	`description` text,
	`source` varchar(32) NOT NULL DEFAULT 'builtin',
	`package_version` varchar(64) NOT NULL DEFAULT 'builtin',
	`config` json NOT NULL DEFAULT (JSON_OBJECT()),
	`tool_names` json NOT NULL DEFAULT (JSON_ARRAY()),
	`dependency_names` json NOT NULL DEFAULT (JSON_ARRAY()),
	`allowed_roles` json NOT NULL DEFAULT (JSON_ARRAY()),
	`enabled` boolean NOT NULL DEFAULT true,
	`version` int NOT NULL DEFAULT 1,
	`last_test_status` varchar(16),
	`last_test_error` text,
	`last_test_latency_ms` int,
	`last_test_trace_id` varchar(36),
	`last_test_at` datetime(3),
	`created_by` varchar(36),
	`updated_by` varchar(36),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `sbl_ai_capabilities_id` PRIMARY KEY(`id`),
	CONSTRAINT `fk_ai_capabilities_created_by` FOREIGN KEY (`created_by`) REFERENCES `sbl_users`(`id`) ON DELETE set null ON UPDATE no action,
	CONSTRAINT `fk_ai_capabilities_updated_by` FOREIGN KEY (`updated_by`) REFERENCES `sbl_users`(`id`) ON DELETE set null ON UPDATE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_ai_capabilities_kind_key` ON `sbl_ai_capabilities` (`kind`,`capability_key`);
--> statement-breakpoint
CREATE INDEX `idx_ai_capabilities_enabled` ON `sbl_ai_capabilities` (`enabled`,`kind`,`name`);
--> statement-breakpoint
CREATE TABLE `sbl_ai_capability_bindings` (
	`id` varchar(36) NOT NULL,
	`capability_id` varchar(36) NOT NULL,
	`scope_type` varchar(16) NOT NULL,
	`scope_key` varchar(128) NOT NULL,
	`department` varchar(64),
	`project_id` varchar(36),
	`enabled` boolean NOT NULL DEFAULT true,
	`version` int NOT NULL DEFAULT 1,
	`created_by` varchar(36),
	`updated_by` varchar(36),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `sbl_ai_capability_bindings_id` PRIMARY KEY(`id`),
	CONSTRAINT `fk_ai_capability_bindings_capability` FOREIGN KEY (`capability_id`) REFERENCES `sbl_ai_capabilities`(`id`) ON DELETE cascade ON UPDATE no action,
	CONSTRAINT `fk_ai_capability_bindings_project` FOREIGN KEY (`project_id`) REFERENCES `sbl_projects`(`id`) ON DELETE cascade ON UPDATE no action,
	CONSTRAINT `fk_ai_capability_bindings_created_by` FOREIGN KEY (`created_by`) REFERENCES `sbl_users`(`id`) ON DELETE set null ON UPDATE no action,
	CONSTRAINT `fk_ai_capability_bindings_updated_by` FOREIGN KEY (`updated_by`) REFERENCES `sbl_users`(`id`) ON DELETE set null ON UPDATE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_ai_capability_bindings_scope` ON `sbl_ai_capability_bindings` (`capability_id`,`scope_type`,`scope_key`);
--> statement-breakpoint
CREATE INDEX `idx_ai_capability_bindings_project` ON `sbl_ai_capability_bindings` (`project_id`,`enabled`);
--> statement-breakpoint
CREATE INDEX `idx_ai_capability_bindings_department` ON `sbl_ai_capability_bindings` (`department`,`enabled`);
--> statement-breakpoint
CREATE TABLE `sbl_ai_conversation_capabilities` (
	`conversation_id` varchar(36) NOT NULL,
	`capability_id` varchar(36) NOT NULL,
	`user_id` varchar(36) NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `fk_ai_conversation_capabilities_conversation` FOREIGN KEY (`conversation_id`) REFERENCES `sbl_agent_conversations`(`id`) ON DELETE cascade ON UPDATE no action,
	CONSTRAINT `fk_ai_conversation_capabilities_capability` FOREIGN KEY (`capability_id`) REFERENCES `sbl_ai_capabilities`(`id`) ON DELETE cascade ON UPDATE no action,
	CONSTRAINT `fk_ai_conversation_capabilities_user` FOREIGN KEY (`user_id`) REFERENCES `sbl_users`(`id`) ON DELETE cascade ON UPDATE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_ai_conversation_capabilities` ON `sbl_ai_conversation_capabilities` (`conversation_id`,`capability_id`);
--> statement-breakpoint
CREATE INDEX `idx_ai_conversation_capabilities_user` ON `sbl_ai_conversation_capabilities` (`user_id`,`conversation_id`);
