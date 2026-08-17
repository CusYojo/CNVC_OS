ALTER TABLE `sbl_project_files` ADD `byte_size` bigint NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE `sbl_project_files` ADD `sha256` varchar(64);
--> statement-breakpoint
ALTER TABLE `sbl_project_files` ADD `uploaded_by` varchar(36);
--> statement-breakpoint
UPDATE `sbl_project_files` f
JOIN `sbl_projects` p ON p.id = f.project_id
SET f.uploaded_by = p.created_by
WHERE f.uploaded_by IS NULL AND p.created_by IS NOT NULL;
--> statement-breakpoint
UPDATE `sbl_project_files`
SET `byte_size` = ROUND(CAST(SUBSTRING_INDEX(TRIM(`size`), ' ', 1) AS DECIMAL(20,6)) * 1048576)
WHERE `byte_size` = 0 AND TRIM(COALESCE(`size`, '')) REGEXP '^[0-9]+(\\.[0-9]+)?[[:space:]]+MB$';
--> statement-breakpoint
ALTER TABLE `sbl_project_files` ADD CONSTRAINT `sbl_project_files_uploaded_by_sbl_users_id_fk` FOREIGN KEY (`uploaded_by`) REFERENCES `sbl_users`(`id`) ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX `idx_project_files_uploader` ON `sbl_project_files` (`uploaded_by`,`project_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_project_files_project_sha256` ON `sbl_project_files` (`project_id`,`sha256`);
--> statement-breakpoint
CREATE TABLE `sbl_project_file_versions` (
	`id` varchar(36) NOT NULL,
	`file_id` varchar(36) NOT NULL,
	`version` int NOT NULL,
	`byte_size` bigint NOT NULL DEFAULT 0,
	`sha256` varchar(64),
	`storage_path` text NOT NULL,
	`created_by` varchar(36),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `sbl_project_file_versions_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_project_file_versions_file_version` UNIQUE(`file_id`,`version`),
	CONSTRAINT `sbl_project_file_versions_file_id_sbl_project_files_id_fk` FOREIGN KEY (`file_id`) REFERENCES `sbl_project_files`(`id`) ON DELETE cascade ON UPDATE no action,
	CONSTRAINT `sbl_project_file_versions_created_by_sbl_users_id_fk` FOREIGN KEY (`created_by`) REFERENCES `sbl_users`(`id`) ON DELETE set null ON UPDATE no action
);
--> statement-breakpoint
CREATE INDEX `idx_project_file_versions_sha256` ON `sbl_project_file_versions` (`sha256`);
--> statement-breakpoint
INSERT INTO `sbl_project_file_versions`
	(`id`, `file_id`, `version`, `byte_size`, `sha256`, `storage_path`, `created_by`, `created_at`)
SELECT UUID(), f.id, f.version, f.byte_size, f.sha256, f.storage_path, f.uploaded_by, f.uploaded_at
FROM `sbl_project_files` f
WHERE f.storage_path IS NOT NULL AND f.storage_path <> '';
