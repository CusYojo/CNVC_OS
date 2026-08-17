CREATE TABLE `sbl_admin_configuration_revisions` (
	`id` varchar(36) NOT NULL,
	`domain` varchar(16) NOT NULL,
	`resource_type` varchar(32) NOT NULL,
	`resource_id` varchar(191) NOT NULL,
	`operation` varchar(16) NOT NULL,
	`source_version` int NOT NULL,
	`snapshot_ciphertext` longtext,
	`snapshot_sha256` varchar(64) NOT NULL,
	`created_by` varchar(36),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `sbl_admin_configuration_revisions_id` PRIMARY KEY(`id`),
	CONSTRAINT `fk_admin_config_revision_actor` FOREIGN KEY (`created_by`) REFERENCES `sbl_users`(`id`) ON DELETE set null ON UPDATE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_admin_config_revision_resource_version` ON `sbl_admin_configuration_revisions` (`domain`,`resource_type`,`resource_id`,`source_version`);
--> statement-breakpoint
CREATE INDEX `idx_admin_config_revision_resource_time` ON `sbl_admin_configuration_revisions` (`domain`,`resource_type`,`resource_id`,`created_at`);
--> statement-breakpoint
CREATE INDEX `idx_admin_config_revision_actor_time` ON `sbl_admin_configuration_revisions` (`created_by`,`created_at`);
