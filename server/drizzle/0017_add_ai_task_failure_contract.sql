ALTER TABLE `sbl_ai_tasks` ADD `error_code` varchar(64);
--> statement-breakpoint
ALTER TABLE `sbl_ai_tasks` ADD `retryable` boolean;
--> statement-breakpoint
CREATE INDEX `idx_ai_tasks_retry_of` ON `sbl_ai_tasks` (`retry_of_task_id`);
