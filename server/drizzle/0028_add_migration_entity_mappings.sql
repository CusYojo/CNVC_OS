CREATE TABLE `sbl_migration_entity_mappings` (
	`id` varchar(36) NOT NULL,
	`run_id` varchar(36),
	`source_system` varchar(32) NOT NULL,
	`source_table` varchar(64) NOT NULL,
	`source_id` varchar(191) NOT NULL,
	`target_table` varchar(64) NOT NULL,
	`target_id` varchar(191) NOT NULL,
	`mapping_kind` varchar(16) NOT NULL,
	`source_checksum` varchar(64) NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `sbl_migration_entity_mappings_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_migration_entity_source` UNIQUE(`source_system`,`source_table`,`source_id`)
);
--> statement-breakpoint
ALTER TABLE `sbl_migration_entity_mappings` ADD CONSTRAINT `fk_migration_entity_run` FOREIGN KEY (`run_id`) REFERENCES `sbl_migration_runs`(`id`) ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX `idx_migration_entity_target` ON `sbl_migration_entity_mappings` (`target_table`,`target_id`);
--> statement-breakpoint
CREATE INDEX `idx_migration_entity_run` ON `sbl_migration_entity_mappings` (`run_id`);
