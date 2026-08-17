CREATE TABLE `sbl_lead_pipeline_prompt_versions` (
	`id` varchar(64) NOT NULL,
	`agent_profile` varchar(64) NOT NULL,
	`prompt_version` varchar(64) NOT NULL,
	`schema_version` varchar(64) NOT NULL,
	`skill_version` varchar(64) NOT NULL,
	`toolset_version` varchar(64) NOT NULL,
	`prompt_hash` varchar(64) NOT NULL,
	`configuration` json NOT NULL DEFAULT (JSON_OBJECT()),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `sbl_lead_pipeline_prompt_versions_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_lp_prompt_contract` UNIQUE(`agent_profile`,`prompt_version`,`schema_version`,`skill_version`,`toolset_version`)
);
--> statement-breakpoint
CREATE TABLE `sbl_lead_pipeline_runs` (
	`id` varchar(36) NOT NULL,
	`run_key` varchar(64) NOT NULL,
	`primary_event_id` varchar(64),
	`event_ids` json NOT NULL DEFAULT (JSON_ARRAY()),
	`runtime` varchar(32) NOT NULL,
	`agent_profile` varchar(64) NOT NULL,
	`prompt_version_id` varchar(64),
	`model` varchar(128) NOT NULL,
	`status` varchar(16) NOT NULL,
	`attempt` int NOT NULL DEFAULT 1,
	`input_tokens` bigint,
	`output_tokens` bigint,
	`total_tokens` bigint,
	`tool_calls` int NOT NULL DEFAULT 0,
	`duration_ms` int,
	`cost_microusd` bigint,
	`error` text,
	`metadata` json NOT NULL DEFAULT (JSON_OBJECT()),
	`started_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`finished_at` datetime(3),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `sbl_lead_pipeline_runs_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_lp_runs_key` UNIQUE(`run_key`)
);
--> statement-breakpoint
CREATE TABLE `sbl_lead_pipeline_decisions` (
	`id` varchar(36) NOT NULL,
	`decision_key` varchar(64) NOT NULL,
	`event_id` varchar(64) NOT NULL,
	`run_id` varchar(36),
	`parent_decision_id` varchar(36),
	`decision_type` varchar(32) NOT NULL,
	`outcome` varchar(16) NOT NULL,
	`subject_type` varchar(16),
	`subject_name` varchar(128),
	`legal_name` varchar(128),
	`confidence` int,
	`reason` text NOT NULL,
	`output` json NOT NULL DEFAULT (JSON_OBJECT()),
	`actor_type` varchar(32) NOT NULL,
	`actor_id` varchar(64),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `sbl_lead_pipeline_decisions_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_lp_decisions_key` UNIQUE(`decision_key`)
);
--> statement-breakpoint
CREATE TABLE `sbl_lead_pipeline_evidence` (
	`id` varchar(36) NOT NULL,
	`evidence_key` varchar(64) NOT NULL,
	`decision_id` varchar(36) NOT NULL,
	`event_id` varchar(64) NOT NULL,
	`source_id` text,
	`source_type` varchar(32) NOT NULL,
	`locator` text,
	`claim` text NOT NULL,
	`quote` text,
	`source_url` text,
	`reliability` varchar(16),
	`verification_status` varchar(16) NOT NULL DEFAULT 'unverified',
	`metadata` json NOT NULL DEFAULT (JSON_OBJECT()),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `sbl_lead_pipeline_evidence_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_lp_evidence_key` UNIQUE(`evidence_key`)
);
--> statement-breakpoint
CREATE TABLE `sbl_lead_pipeline_reviews` (
	`id` varchar(36) NOT NULL,
	`review_key` varchar(64) NOT NULL,
	`event_id` varchar(64) NOT NULL,
	`trigger_decision_id` varchar(36) NOT NULL,
	`status` varchar(16) NOT NULL DEFAULT 'pending',
	`reason` text NOT NULL,
	`assigned_user_id` varchar(36),
	`reviewer_user_id` varchar(36),
	`resolution_decision_id` varchar(36),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`resolved_at` datetime(3),
	CONSTRAINT `sbl_lead_pipeline_reviews_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_lp_reviews_key` UNIQUE(`review_key`)
);
--> statement-breakpoint
CREATE INDEX `idx_lp_runs_event` ON `sbl_lead_pipeline_runs` (`primary_event_id`,`started_at`);
--> statement-breakpoint
CREATE INDEX `idx_lp_runs_status` ON `sbl_lead_pipeline_runs` (`status`,`started_at`);
--> statement-breakpoint
CREATE INDEX `idx_lp_decisions_event` ON `sbl_lead_pipeline_decisions` (`event_id`,`created_at`);
--> statement-breakpoint
CREATE INDEX `idx_lp_decisions_run` ON `sbl_lead_pipeline_decisions` (`run_id`);
--> statement-breakpoint
CREATE INDEX `idx_lp_evidence_event` ON `sbl_lead_pipeline_evidence` (`event_id`,`created_at`);
--> statement-breakpoint
CREATE INDEX `idx_lp_evidence_decision` ON `sbl_lead_pipeline_evidence` (`decision_id`);
--> statement-breakpoint
CREATE INDEX `idx_lp_reviews_status` ON `sbl_lead_pipeline_reviews` (`status`,`created_at`);
--> statement-breakpoint
CREATE INDEX `idx_lp_reviews_event` ON `sbl_lead_pipeline_reviews` (`event_id`,`created_at`);
--> statement-breakpoint
ALTER TABLE `sbl_lead_pipeline_runs` ADD CONSTRAINT `sbl_lp_runs_event_fk` FOREIGN KEY (`primary_event_id`) REFERENCES `sbl_lead_pipeline_raw_events`(`id`) ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `sbl_lead_pipeline_runs` ADD CONSTRAINT `sbl_lp_runs_prompt_fk` FOREIGN KEY (`prompt_version_id`) REFERENCES `sbl_lead_pipeline_prompt_versions`(`id`) ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `sbl_lead_pipeline_decisions` ADD CONSTRAINT `sbl_lp_decisions_event_fk` FOREIGN KEY (`event_id`) REFERENCES `sbl_lead_pipeline_raw_events`(`id`) ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `sbl_lead_pipeline_decisions` ADD CONSTRAINT `sbl_lp_decisions_run_fk` FOREIGN KEY (`run_id`) REFERENCES `sbl_lead_pipeline_runs`(`id`) ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `sbl_lead_pipeline_decisions` ADD CONSTRAINT `sbl_lp_decisions_parent_fk` FOREIGN KEY (`parent_decision_id`) REFERENCES `sbl_lead_pipeline_decisions`(`id`) ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `sbl_lead_pipeline_evidence` ADD CONSTRAINT `sbl_lp_evidence_decision_fk` FOREIGN KEY (`decision_id`) REFERENCES `sbl_lead_pipeline_decisions`(`id`) ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `sbl_lead_pipeline_evidence` ADD CONSTRAINT `sbl_lp_evidence_event_fk` FOREIGN KEY (`event_id`) REFERENCES `sbl_lead_pipeline_raw_events`(`id`) ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `sbl_lead_pipeline_reviews` ADD CONSTRAINT `sbl_lp_reviews_event_fk` FOREIGN KEY (`event_id`) REFERENCES `sbl_lead_pipeline_raw_events`(`id`) ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `sbl_lead_pipeline_reviews` ADD CONSTRAINT `sbl_lp_reviews_trigger_fk` FOREIGN KEY (`trigger_decision_id`) REFERENCES `sbl_lead_pipeline_decisions`(`id`) ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `sbl_lead_pipeline_reviews` ADD CONSTRAINT `sbl_lp_reviews_resolution_fk` FOREIGN KEY (`resolution_decision_id`) REFERENCES `sbl_lead_pipeline_decisions`(`id`) ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `sbl_lead_pipeline_reviews` ADD CONSTRAINT `sbl_lp_reviews_assignee_fk` FOREIGN KEY (`assigned_user_id`) REFERENCES `sbl_users`(`id`) ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `sbl_lead_pipeline_reviews` ADD CONSTRAINT `sbl_lp_reviews_reviewer_fk` FOREIGN KEY (`reviewer_user_id`) REFERENCES `sbl_users`(`id`) ON DELETE set null ON UPDATE no action;
