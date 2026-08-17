CREATE TABLE `sbl_lead_pipeline_raw_events` (
	`id` varchar(64) NOT NULL,
	`source_type` varchar(32) NOT NULL,
	`source_id` text,
	`source_id_hash` varchar(64),
	`content_hash` varchar(64) NOT NULL,
	`idempotency_key` varchar(64) NOT NULL,
	`payload` json NOT NULL,
	`source_occurred_at` datetime(3),
	`ingested_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `sbl_lead_pipeline_raw_events_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_lead_pipeline_raw_idempotency` UNIQUE(`idempotency_key`)
);
--> statement-breakpoint
CREATE TABLE `sbl_lead_pipeline_items` (
	`event_id` varchar(64) NOT NULL,
	`status` varchar(16) NOT NULL DEFAULT 'discovered',
	`lead_id` varchar(36),
	`processing_attempts` int NOT NULL DEFAULT 0,
	`decision_reason` text,
	`evidence` json NOT NULL DEFAULT (JSON_ARRAY()),
	`confidence` int,
	`last_error` text,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `sbl_lead_pipeline_items_event_id` PRIMARY KEY(`event_id`)
);
--> statement-breakpoint
CREATE TABLE `sbl_lead_pipeline_transitions` (
	`id` varchar(36) NOT NULL,
	`event_id` varchar(64) NOT NULL,
	`from_status` varchar(16),
	`to_status` varchar(16) NOT NULL,
	`reason` text NOT NULL,
	`evidence` json NOT NULL DEFAULT (JSON_ARRAY()),
	`confidence` int,
	`actor_type` varchar(32) NOT NULL,
	`actor_id` varchar(64),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `sbl_lead_pipeline_transitions_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
DROP INDEX `uq_reserve_imported_lead` ON `sbl_lead_reserve`;
--> statement-breakpoint
CREATE INDEX `idx_reserve_imported_lead` ON `sbl_lead_reserve` (`imported_lead_id`);
--> statement-breakpoint
CREATE INDEX `idx_lead_pipeline_raw_source` ON `sbl_lead_pipeline_raw_events` (`source_type`,`source_id_hash`);
--> statement-breakpoint
CREATE INDEX `idx_lead_pipeline_raw_content` ON `sbl_lead_pipeline_raw_events` (`source_type`,`content_hash`);
--> statement-breakpoint
CREATE INDEX `idx_lead_pipeline_items_status` ON `sbl_lead_pipeline_items` (`status`,`updated_at`);
--> statement-breakpoint
CREATE INDEX `idx_lead_pipeline_items_lead` ON `sbl_lead_pipeline_items` (`lead_id`);
--> statement-breakpoint
CREATE INDEX `idx_lead_pipeline_transitions_event` ON `sbl_lead_pipeline_transitions` (`event_id`,`created_at`);
--> statement-breakpoint
CREATE INDEX `idx_lead_pipeline_transitions_status` ON `sbl_lead_pipeline_transitions` (`to_status`,`created_at`);
--> statement-breakpoint
ALTER TABLE `sbl_lead_pipeline_items` ADD CONSTRAINT `sbl_lp_items_event_fk` FOREIGN KEY (`event_id`) REFERENCES `sbl_lead_pipeline_raw_events`(`id`) ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `sbl_lead_pipeline_items` ADD CONSTRAINT `sbl_lp_items_lead_fk` FOREIGN KEY (`lead_id`) REFERENCES `sbl_leads`(`id`) ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `sbl_lead_pipeline_transitions` ADD CONSTRAINT `sbl_lp_transitions_event_fk` FOREIGN KEY (`event_id`) REFERENCES `sbl_lead_pipeline_raw_events`(`id`) ON DELETE restrict ON UPDATE no action;
