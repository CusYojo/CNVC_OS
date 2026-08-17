CREATE TABLE `sbl_project_score_jobs` (
	`project_id` varchar(36) NOT NULL,
	`status` varchar(16) NOT NULL DEFAULT 'queued',
	`execution_attempts` int NOT NULL DEFAULT 0,
	`next_attempt_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`lease_owner` varchar(128),
	`lease_expires_at` datetime(3),
	`last_started_at` datetime(3),
	`completed_at` datetime(3),
	`dead_lettered_at` datetime(3),
	`last_error` text,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `sbl_project_score_jobs_project_id` PRIMARY KEY(`project_id`),
	CONSTRAINT `sbl_project_score_jobs_project_id_projects_id_fk` FOREIGN KEY (`project_id`) REFERENCES `sbl_projects`(`id`) ON DELETE cascade ON UPDATE no action
);
--> statement-breakpoint
CREATE INDEX `idx_project_score_jobs_due` ON `sbl_project_score_jobs` (`status`,`next_attempt_at`);
--> statement-breakpoint
CREATE INDEX `idx_project_score_jobs_lease` ON `sbl_project_score_jobs` (`lease_expires_at`);
