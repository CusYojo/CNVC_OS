ALTER TABLE `sbl_lead_reserve` ADD `imported_lead_id` varchar(36);--> statement-breakpoint
ALTER TABLE `sbl_lead_reserve` ADD `score_status` varchar(16) DEFAULT 'not_requested' NOT NULL;--> statement-breakpoint
ALTER TABLE `sbl_lead_reserve` ADD `score_requested_at` datetime(3);--> statement-breakpoint
ALTER TABLE `sbl_lead_reserve` ADD `score_last_error` text;--> statement-breakpoint
ALTER TABLE `sbl_lead_reserve` ADD CONSTRAINT `uq_reserve_imported_lead` UNIQUE(`imported_lead_id`);--> statement-breakpoint
CREATE INDEX `idx_reserve_score_status` ON `sbl_lead_reserve` (`score_status`,`imported_at`);
