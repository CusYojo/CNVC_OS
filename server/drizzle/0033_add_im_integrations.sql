CREATE TABLE `sbl_im_bots` (
	`id` varchar(36) NOT NULL,
	`platform` varchar(16) NOT NULL,
	`name` varchar(128) NOT NULL,
	`credential_ciphertext` longtext NOT NULL,
	`credential_hint` varchar(16) NOT NULL,
	`credential_fingerprint` varchar(64) NOT NULL,
	`config` json NOT NULL DEFAULT (JSON_OBJECT()),
	`enabled` boolean NOT NULL DEFAULT false,
	`connection_status` varchar(16) NOT NULL DEFAULT 'disconnected',
	`last_connected_at` datetime(3),
	`last_error` text,
	`version` int NOT NULL DEFAULT 1,
	`created_by` varchar(36),
	`updated_by` varchar(36),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `sbl_im_bots_id` PRIMARY KEY(`id`),
	CONSTRAINT `fk_im_bots_created_by` FOREIGN KEY (`created_by`) REFERENCES `sbl_users`(`id`) ON DELETE set null ON UPDATE no action,
	CONSTRAINT `fk_im_bots_updated_by` FOREIGN KEY (`updated_by`) REFERENCES `sbl_users`(`id`) ON DELETE set null ON UPDATE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_im_bots_platform_name` ON `sbl_im_bots` (`platform`,`name`);
--> statement-breakpoint
CREATE INDEX `idx_im_bots_enabled` ON `sbl_im_bots` (`enabled`,`platform`);
--> statement-breakpoint
CREATE TABLE `sbl_im_bot_bindings` (
	`id` varchar(36) NOT NULL,
	`bot_id` varchar(36) NOT NULL,
	`external_conversation_id` varchar(191) NOT NULL,
	`user_id` varchar(36) NOT NULL,
	`project_id` varchar(36),
	`conversation_id` varchar(36),
	`department` varchar(64),
	`enabled` boolean NOT NULL DEFAULT true,
	`version` int NOT NULL DEFAULT 1,
	`created_by` varchar(36),
	`updated_by` varchar(36),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `sbl_im_bot_bindings_id` PRIMARY KEY(`id`),
	CONSTRAINT `fk_im_bot_bindings_bot` FOREIGN KEY (`bot_id`) REFERENCES `sbl_im_bots`(`id`) ON DELETE cascade ON UPDATE no action,
	CONSTRAINT `fk_im_bot_bindings_user` FOREIGN KEY (`user_id`) REFERENCES `sbl_users`(`id`) ON DELETE cascade ON UPDATE no action,
	CONSTRAINT `fk_im_bot_bindings_project` FOREIGN KEY (`project_id`) REFERENCES `sbl_projects`(`id`) ON DELETE cascade ON UPDATE no action,
	CONSTRAINT `fk_im_bot_bindings_conversation` FOREIGN KEY (`conversation_id`) REFERENCES `sbl_agent_conversations`(`id`) ON DELETE cascade ON UPDATE no action,
	CONSTRAINT `fk_im_bot_bindings_created_by` FOREIGN KEY (`created_by`) REFERENCES `sbl_users`(`id`) ON DELETE set null ON UPDATE no action,
	CONSTRAINT `fk_im_bot_bindings_updated_by` FOREIGN KEY (`updated_by`) REFERENCES `sbl_users`(`id`) ON DELETE set null ON UPDATE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_im_bot_bindings_external` ON `sbl_im_bot_bindings` (`bot_id`,`external_conversation_id`);
--> statement-breakpoint
CREATE INDEX `idx_im_bot_bindings_user` ON `sbl_im_bot_bindings` (`user_id`,`enabled`);
--> statement-breakpoint
CREATE INDEX `idx_im_bot_bindings_project` ON `sbl_im_bot_bindings` (`project_id`,`enabled`);
--> statement-breakpoint
CREATE INDEX `idx_im_bot_bindings_conversation` ON `sbl_im_bot_bindings` (`conversation_id`,`enabled`);
--> statement-breakpoint
CREATE TABLE `sbl_im_outbox` (
	`id` varchar(36) NOT NULL,
	`bot_id` varchar(36) NOT NULL,
	`binding_id` varchar(36) NOT NULL,
	`created_by` varchar(36),
	`idempotency_key` varchar(128) NOT NULL,
	`payload_hash` varchar(64) NOT NULL,
	`payload` json NOT NULL,
	`status` varchar(16) NOT NULL DEFAULT 'pending',
	`attempts` int NOT NULL DEFAULT 0,
	`next_attempt_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`lease_owner` varchar(128),
	`lease_expires_at` datetime(3),
	`last_error` text,
	`sent_at` datetime(3),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `sbl_im_outbox_id` PRIMARY KEY(`id`),
	CONSTRAINT `fk_im_outbox_bot` FOREIGN KEY (`bot_id`) REFERENCES `sbl_im_bots`(`id`) ON DELETE restrict ON UPDATE no action,
	CONSTRAINT `fk_im_outbox_binding` FOREIGN KEY (`binding_id`) REFERENCES `sbl_im_bot_bindings`(`id`) ON DELETE restrict ON UPDATE no action,
	CONSTRAINT `fk_im_outbox_created_by` FOREIGN KEY (`created_by`) REFERENCES `sbl_users`(`id`) ON DELETE set null ON UPDATE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_im_outbox_idempotency` ON `sbl_im_outbox` (`bot_id`,`idempotency_key`);
--> statement-breakpoint
CREATE INDEX `idx_im_outbox_due` ON `sbl_im_outbox` (`status`,`next_attempt_at`,`lease_expires_at`);
--> statement-breakpoint
CREATE INDEX `idx_im_outbox_binding` ON `sbl_im_outbox` (`binding_id`,`created_at`);
--> statement-breakpoint
CREATE TABLE `sbl_im_delivery_logs` (
	`id` varchar(36) NOT NULL,
	`outbox_id` varchar(36) NOT NULL,
	`attempt` int NOT NULL,
	`status` varchar(16) NOT NULL,
	`external_message_id` varchar(191),
	`http_status` int,
	`duration_ms` int NOT NULL,
	`error` text,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `sbl_im_delivery_logs_id` PRIMARY KEY(`id`),
	CONSTRAINT `fk_im_delivery_logs_outbox` FOREIGN KEY (`outbox_id`) REFERENCES `sbl_im_outbox`(`id`) ON DELETE cascade ON UPDATE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_im_delivery_logs_attempt` ON `sbl_im_delivery_logs` (`outbox_id`,`attempt`);
--> statement-breakpoint
CREATE INDEX `idx_im_delivery_logs_status` ON `sbl_im_delivery_logs` (`status`,`created_at`);
--> statement-breakpoint
CREATE TABLE `sbl_im_inbound_messages` (
	`id` varchar(36) NOT NULL,
	`bot_id` varchar(36) NOT NULL,
	`binding_id` varchar(36),
	`external_message_id` varchar(191) NOT NULL,
	`external_conversation_id` varchar(191) NOT NULL,
	`external_user_id` varchar(191),
	`content_hash` varchar(64) NOT NULL,
	`payload` json NOT NULL,
	`status` varchar(16) NOT NULL,
	`rejection_reason` varchar(64),
	`received_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `sbl_im_inbound_messages_id` PRIMARY KEY(`id`),
	CONSTRAINT `fk_im_inbound_messages_bot` FOREIGN KEY (`bot_id`) REFERENCES `sbl_im_bots`(`id`) ON DELETE restrict ON UPDATE no action,
	CONSTRAINT `fk_im_inbound_messages_binding` FOREIGN KEY (`binding_id`) REFERENCES `sbl_im_bot_bindings`(`id`) ON DELETE set null ON UPDATE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_im_inbound_external` ON `sbl_im_inbound_messages` (`bot_id`,`external_message_id`);
--> statement-breakpoint
CREATE INDEX `idx_im_inbound_route` ON `sbl_im_inbound_messages` (`binding_id`,`status`,`received_at`);
