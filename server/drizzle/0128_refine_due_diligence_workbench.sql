ALTER TABLE `sbl_due_diligence_interviews` ADD COLUMN `sort_order` int NOT NULL DEFAULT 0 AFTER `participant_names`;
--> statement-breakpoint
ALTER TABLE `sbl_digital_twins` ADD COLUMN `deleted_at` timestamp(3) NULL AFTER `active_version`;
--> statement-breakpoint
CREATE TABLE `sbl_digital_twin_asset_archives` (
  `id` char(36) NOT NULL,
  `owner_user_id` char(36) NOT NULL,
  `asset_type` varchar(24) NOT NULL,
  `source_twin_id` char(36),
  `name` varchar(255) NOT NULL,
  `snapshot` json NOT NULL,
  `deleted_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `restored_at` timestamp(3),
  PRIMARY KEY (`id`),
  KEY `idx_digital_twin_asset_archives_owner` (`owner_user_id`,`deleted_at`),
  CONSTRAINT `fk_digital_twin_asset_archives_owner` FOREIGN KEY (`owner_user_id`) REFERENCES `sbl_users` (`id`) ON DELETE CASCADE
);
