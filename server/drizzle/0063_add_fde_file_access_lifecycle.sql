ALTER TABLE `sbl_project_files`
  ADD COLUMN `access_mode` varchar(16) NOT NULL DEFAULT 'project',
  ADD COLUMN `access_version` int NOT NULL DEFAULT 1,
  ADD COLUMN `lifecycle` varchar(16) NOT NULL DEFAULT 'active',
  ADD COLUMN `deleted_by` varchar(36) NULL,
  ADD COLUMN `deleted_at` datetime(3) NULL,
  ADD COLUMN `delete_reason` text NULL,
  ADD COLUMN `retention_until` datetime(3) NULL,
  ADD FOREIGN KEY (`deleted_by`) REFERENCES `sbl_users` (`id`) ON DELETE RESTRICT,
  ADD CHECK (`access_mode` IN ('project','explicit')),
  ADD CHECK (`access_version` > 0),
  ADD CHECK (`lifecycle` IN ('active','deleted')),
  ADD CHECK ((`lifecycle`='active' AND `deleted_by` IS NULL AND `deleted_at` IS NULL AND `delete_reason` IS NULL AND `retention_until` IS NULL) OR (`lifecycle`='deleted' AND `deleted_by` IS NOT NULL AND `deleted_at` IS NOT NULL AND `delete_reason` IS NOT NULL AND CHAR_LENGTH(`delete_reason`)>=5 AND `retention_until` IS NOT NULL AND `retention_until`>`deleted_at`));
--> statement-breakpoint
CREATE TABLE `sbl_project_file_grants` (
  `id` varchar(36) NOT NULL PRIMARY KEY,
  `file_id` varchar(36) NOT NULL,
  `user_id` varchar(36) NOT NULL,
  `can_view` boolean NOT NULL DEFAULT false,
  `can_download` boolean NOT NULL DEFAULT false,
  `granted_by` varchar(36) NOT NULL,
  `updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY `uq_file_grant_user` (`file_id`,`user_id`),
  FOREIGN KEY (`file_id`) REFERENCES `sbl_project_files` (`id`) ON DELETE RESTRICT,
  FOREIGN KEY (`user_id`) REFERENCES `sbl_users` (`id`) ON DELETE RESTRICT,
  FOREIGN KEY (`granted_by`) REFERENCES `sbl_users` (`id`) ON DELETE RESTRICT,
  CHECK (`can_download`=false OR `can_view`=true)
);
--> statement-breakpoint
CREATE TABLE `sbl_project_file_events` (
  `id` varchar(36) NOT NULL PRIMARY KEY,
  `file_id` varchar(36) NOT NULL,
  `actor_id` varchar(36) NOT NULL,
  `request_id` varchar(36) NOT NULL,
  `request_hash` varchar(64) NOT NULL,
  `action` varchar(24) NOT NULL,
  `version` int NOT NULL,
  `reason` text NOT NULL,
  `snapshot` json NOT NULL,
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY `uq_file_event_request` (`request_id`),
  UNIQUE KEY `uq_file_event_version` (`file_id`,`version`),
  FOREIGN KEY (`file_id`) REFERENCES `sbl_project_files` (`id`) ON DELETE RESTRICT,
  FOREIGN KEY (`actor_id`) REFERENCES `sbl_users` (`id`) ON DELETE RESTRICT
);
