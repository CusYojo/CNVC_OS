CREATE TABLE `sbl_iam_user_mappings` (
	`id` varchar(36) NOT NULL,
	`source_system` varchar(32) NOT NULL,
	`source_user_id` varchar(64) NOT NULL,
	`source_email` varchar(255) NOT NULL,
	`target_user_id` varchar(36) NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `sbl_iam_user_mappings_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_iam_user_mappings_source` UNIQUE(`source_system`,`source_user_id`)
);
--> statement-breakpoint
ALTER TABLE `sbl_iam_user_mappings` ADD CONSTRAINT `sbl_iam_user_mappings_target_user_id_sbl_users_id_fk` FOREIGN KEY (`target_user_id`) REFERENCES `sbl_users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `idx_iam_user_mappings_target` ON `sbl_iam_user_mappings` (`target_user_id`);