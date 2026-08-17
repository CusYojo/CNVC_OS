ALTER TABLE `sbl_projects` ADD COLUMN `version` int NOT NULL DEFAULT 1 AFTER `pinned`;
--> statement-breakpoint
ALTER TABLE `sbl_meetings` ADD COLUMN `version` int NOT NULL DEFAULT 1 AFTER `created_by`;
--> statement-breakpoint
ALTER TABLE `sbl_todos` ADD COLUMN `version` int NOT NULL DEFAULT 1 AFTER `created_by`;
--> statement-breakpoint
ALTER TABLE `sbl_risks` ADD COLUMN `version` int NOT NULL DEFAULT 1 AFTER `resolved_at`;
