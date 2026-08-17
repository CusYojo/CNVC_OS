CREATE TABLE `sbl_ai_template_analysis_progress` (
	`id` varchar(36) NOT NULL,
	`user_id` varchar(36) NOT NULL,
	`project_id` varchar(36) NOT NULL,
	`task_id` varchar(36),
	`file_name` varchar(255) NOT NULL,
	`purpose` varchar(48) NOT NULL,
	`status` varchar(16) NOT NULL DEFAULT 'running',
	`stage` varchar(255) NOT NULL,
	`progress` int NOT NULL DEFAULT 0,
	`error_message` text,
	`result` json,
	`started_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`expires_at` datetime(3) NOT NULL,
	CONSTRAINT `sbl_ai_template_analysis_progress_id` PRIMARY KEY(`id`),
	CONSTRAINT `sbl_ai_template_analysis_progress_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `sbl_users`(`id`) ON DELETE cascade ON UPDATE no action,
	CONSTRAINT `sbl_ai_template_analysis_progress_project_id_projects_id_fk` FOREIGN KEY (`project_id`) REFERENCES `sbl_projects`(`id`) ON DELETE cascade ON UPDATE no action,
	CONSTRAINT `sbl_ai_template_analysis_progress_task_id_ai_tasks_id_fk` FOREIGN KEY (`task_id`) REFERENCES `sbl_ai_tasks`(`id`) ON DELETE set null ON UPDATE no action
);
--> statement-breakpoint
CREATE INDEX `idx_ai_template_progress_user_updated` ON `sbl_ai_template_analysis_progress` (`user_id`,`updated_at`);
--> statement-breakpoint
CREATE INDEX `idx_ai_template_progress_status_expiry` ON `sbl_ai_template_analysis_progress` (`status`,`expires_at`);
