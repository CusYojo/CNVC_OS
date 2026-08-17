ALTER TABLE `sbl_ai_tasks` ADD `execution_attempts` int NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE `sbl_ai_tasks` ADD `lease_owner` varchar(128);
--> statement-breakpoint
ALTER TABLE `sbl_ai_tasks` ADD `lease_expires_at` datetime(3);
--> statement-breakpoint
CREATE INDEX `idx_ai_tasks_lease` ON `sbl_ai_tasks` (`status`,`lease_expires_at`);
