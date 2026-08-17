CREATE TABLE `sbl_lead_score_jobs` (
	`lead_id` varchar(36) NOT NULL,
	`status` varchar(16) NOT NULL DEFAULT 'queued',
	`execution_attempts` int NOT NULL DEFAULT 0,
	`next_attempt_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`lease_owner` varchar(128),
	`lease_expires_at` datetime(3),
	`last_started_at` datetime(3),
	`completed_at` datetime(3),
	`last_error` text,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `sbl_lead_score_jobs_lead_id` PRIMARY KEY(`lead_id`)
);
--> statement-breakpoint
ALTER TABLE `sbl_lead_score_jobs` ADD CONSTRAINT `sbl_lead_score_jobs_lead_id_sbl_leads_id_fk` FOREIGN KEY (`lead_id`) REFERENCES `sbl_leads`(`id`) ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX `idx_lead_score_jobs_due` ON `sbl_lead_score_jobs` (`status`,`next_attempt_at`);
--> statement-breakpoint
CREATE INDEX `idx_lead_score_jobs_lease` ON `sbl_lead_score_jobs` (`lease_expires_at`);
