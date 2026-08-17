CREATE TABLE `sbl_runtime_job_runs` (
	`id` varchar(36) NOT NULL,
	`job_id` varchar(64) NOT NULL,
	`task` varchar(64) NOT NULL,
	`status` varchar(16) NOT NULL,
	`attempt` int NOT NULL DEFAULT 1,
	`lease_owner` varchar(128) NOT NULL,
	`started_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`finished_at` datetime(3),
	`result` json,
	`error` text,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `sbl_runtime_job_runs_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `sbl_runtime_jobs` (
	`id` varchar(64) NOT NULL,
	`task` varchar(64) NOT NULL,
	`enabled` boolean NOT NULL DEFAULT true,
	`schedule_kind` varchar(16) NOT NULL,
	`interval_seconds` int,
	`daily_hour` int,
	`daily_minute` int,
	`payload` json NOT NULL DEFAULT (JSON_OBJECT()),
	`next_run_at` datetime(3) NOT NULL,
	`lease_owner` varchar(128),
	`lease_expires_at` datetime(3),
	`current_run_id` varchar(36),
	`last_status` varchar(16),
	`last_started_at` datetime(3),
	`last_finished_at` datetime(3),
	`last_error` text,
	`consecutive_failures` int NOT NULL DEFAULT 0,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `sbl_runtime_jobs_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `sbl_runtime_job_runs` ADD CONSTRAINT `sbl_runtime_job_runs_job_id_sbl_runtime_jobs_id_fk` FOREIGN KEY (`job_id`) REFERENCES `sbl_runtime_jobs`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `idx_runtime_job_runs_job_started` ON `sbl_runtime_job_runs` (`job_id`,`started_at`);--> statement-breakpoint
CREATE INDEX `idx_runtime_job_runs_status` ON `sbl_runtime_job_runs` (`status`);--> statement-breakpoint
CREATE INDEX `idx_runtime_jobs_due` ON `sbl_runtime_jobs` (`enabled`,`next_run_at`);--> statement-breakpoint
CREATE INDEX `idx_runtime_jobs_lease` ON `sbl_runtime_jobs` (`lease_expires_at`);
