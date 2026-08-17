DROP INDEX `uq_project_files_project_sha256` ON `sbl_project_files`;
--> statement-breakpoint
CREATE INDEX `idx_project_files_project_sha256` ON `sbl_project_files` (`project_id`,`sha256`);
