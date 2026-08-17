CREATE TABLE `sbl_ai_model_providers` (
	`id` varchar(36) NOT NULL,
	`name` varchar(128) NOT NULL,
	`protocol` varchar(32) NOT NULL DEFAULT 'openai-compatible',
	`base_url` varchar(2048) NOT NULL,
	`credential_ciphertext` longtext,
	`credential_hint` varchar(16),
	`credential_fingerprint` varchar(64),
	`timeout_ms` int NOT NULL DEFAULT 120000,
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
	CONSTRAINT `sbl_ai_model_providers_id` PRIMARY KEY(`id`),
	CONSTRAINT `fk_ai_model_provider_created_by` FOREIGN KEY (`created_by`) REFERENCES `sbl_users`(`id`) ON DELETE set null ON UPDATE no action,
	CONSTRAINT `fk_ai_model_provider_updated_by` FOREIGN KEY (`updated_by`) REFERENCES `sbl_users`(`id`) ON DELETE set null ON UPDATE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_ai_model_providers_name` ON `sbl_ai_model_providers` (`name`);
--> statement-breakpoint
CREATE INDEX `idx_ai_model_providers_enabled` ON `sbl_ai_model_providers` (`enabled`,`name`);
--> statement-breakpoint
CREATE TABLE `sbl_ai_models` (
	`id` varchar(36) NOT NULL,
	`provider_id` varchar(36) NOT NULL,
	`model_key` varchar(128) NOT NULL,
	`display_name` varchar(128) NOT NULL,
	`context_window` int,
	`capability_tags` json NOT NULL DEFAULT (JSON_ARRAY()),
	`allowed_roles` json NOT NULL DEFAULT (JSON_ARRAY()),
	`enabled` boolean NOT NULL DEFAULT true,
	`is_default` boolean NOT NULL DEFAULT false,
	`version` int NOT NULL DEFAULT 1,
	`created_by` varchar(36),
	`updated_by` varchar(36),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `sbl_ai_models_id` PRIMARY KEY(`id`),
	CONSTRAINT `fk_ai_models_provider` FOREIGN KEY (`provider_id`) REFERENCES `sbl_ai_model_providers`(`id`) ON DELETE restrict ON UPDATE no action,
	CONSTRAINT `fk_ai_models_created_by` FOREIGN KEY (`created_by`) REFERENCES `sbl_users`(`id`) ON DELETE set null ON UPDATE no action,
	CONSTRAINT `fk_ai_models_updated_by` FOREIGN KEY (`updated_by`) REFERENCES `sbl_users`(`id`) ON DELETE set null ON UPDATE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_ai_models_provider_key` ON `sbl_ai_models` (`provider_id`,`model_key`);
--> statement-breakpoint
CREATE INDEX `idx_ai_models_enabled_default` ON `sbl_ai_models` (`enabled`,`is_default`);
--> statement-breakpoint
CREATE TABLE `sbl_ai_model_routes` (
	`profile_key` varchar(64) NOT NULL,
	`model_id` varchar(36) NOT NULL,
	`fallback_model_id` varchar(36),
	`enabled` boolean NOT NULL DEFAULT true,
	`version` int NOT NULL DEFAULT 1,
	`updated_by` varchar(36),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `sbl_ai_model_routes_profile_key` PRIMARY KEY(`profile_key`),
	CONSTRAINT `fk_ai_model_routes_model` FOREIGN KEY (`model_id`) REFERENCES `sbl_ai_models`(`id`) ON DELETE restrict ON UPDATE no action,
	CONSTRAINT `fk_ai_model_routes_fallback` FOREIGN KEY (`fallback_model_id`) REFERENCES `sbl_ai_models`(`id`) ON DELETE restrict ON UPDATE no action,
	CONSTRAINT `fk_ai_model_routes_updated_by` FOREIGN KEY (`updated_by`) REFERENCES `sbl_users`(`id`) ON DELETE set null ON UPDATE no action
);
--> statement-breakpoint
CREATE INDEX `idx_ai_model_routes_models` ON `sbl_ai_model_routes` (`model_id`,`fallback_model_id`);
