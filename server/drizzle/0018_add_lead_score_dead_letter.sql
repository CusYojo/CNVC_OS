ALTER TABLE `sbl_lead_score_jobs` ADD `manual_retry_count` int NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE `sbl_lead_score_jobs` ADD `dead_lettered_at` datetime(3);
