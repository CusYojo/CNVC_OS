CREATE TABLE `sbl_migration_cdc_checkpoints` (
	`id` varchar(36) NOT NULL,
	`source_system` varchar(32) NOT NULL,
	`source_instance` varchar(128) NOT NULL,
	`source_fingerprint` varchar(64) NOT NULL,
	`capture_version` varchar(32) NOT NULL,
	`status` varchar(16) NOT NULL DEFAULT 'idle',
	`last_sequence` bigint unsigned NOT NULL DEFAULT 0,
	`last_txid` bigint unsigned NOT NULL DEFAULT 0,
	`source_safe_watermark` bigint unsigned NOT NULL DEFAULT 0,
	`source_observed_watermark` bigint unsigned NOT NULL DEFAULT 0,
	`applied_events` bigint unsigned NOT NULL DEFAULT 0,
	`replayed_events` bigint unsigned NOT NULL DEFAULT 0,
	`inserted_events` bigint unsigned NOT NULL DEFAULT 0,
	`updated_events` bigint unsigned NOT NULL DEFAULT 0,
	`deleted_events` bigint unsigned NOT NULL DEFAULT 0,
	`cascade_deleted_events` bigint unsigned NOT NULL DEFAULT 0,
	`replication_lag_ms` bigint unsigned NOT NULL DEFAULT 0,
	`last_event_at` datetime(3),
	`report` json NOT NULL DEFAULT (JSON_OBJECT()),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `sbl_migration_cdc_checkpoints_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_migration_cdc_source` UNIQUE(`source_system`,`source_instance`)
);
--> statement-breakpoint
CREATE TABLE `sbl_migration_cdc_events` (
	`id` varchar(36) NOT NULL,
	`checkpoint_id` varchar(36) NOT NULL,
	`source_sequence` bigint unsigned NOT NULL,
	`source_txid` bigint unsigned NOT NULL,
	`source_table` varchar(64) NOT NULL,
	`source_entity_id` varchar(191) NOT NULL,
	`operation` varchar(8) NOT NULL,
	`event_checksum` varchar(64) NOT NULL,
	`outcome` varchar(16) NOT NULL,
	`tombstone` boolean NOT NULL DEFAULT false,
	`cascade_delete` boolean NOT NULL DEFAULT false,
	`source_occurred_at` datetime(3) NOT NULL,
	`applied_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `sbl_migration_cdc_events_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_migration_cdc_event_sequence` UNIQUE(`checkpoint_id`,`source_sequence`),
	CONSTRAINT `fk_migration_cdc_event_checkpoint` FOREIGN KEY (`checkpoint_id`) REFERENCES `sbl_migration_cdc_checkpoints`(`id`) ON DELETE cascade ON UPDATE no action
);
--> statement-breakpoint
CREATE INDEX `idx_migration_cdc_event_entity` ON `sbl_migration_cdc_events` (`source_table`,`source_entity_id`,`source_sequence`);
--> statement-breakpoint
CREATE INDEX `idx_migration_cdc_event_txid` ON `sbl_migration_cdc_events` (`checkpoint_id`,`source_txid`,`source_sequence`);
