CREATE TABLE `sbl_ai_artifacts` (
	`id` varchar(36) NOT NULL,
	`task_id` varchar(36) NOT NULL,
	`user_id` varchar(36) NOT NULL,
	`project_id` varchar(36) NOT NULL,
	`conversation_id` varchar(64),
	`file_name` varchar(255) NOT NULL,
	`format` varchar(16) NOT NULL,
	`mime_type` varchar(128) NOT NULL,
	`version` int NOT NULL DEFAULT 1,
	`storage_path` text NOT NULL,
	`editable_level` varchar(32) NOT NULL DEFAULT 'none',
	`source_cutoff_date` varchar(10),
	`template_version` varchar(64) NOT NULL,
	`quality_status` varchar(16) NOT NULL DEFAULT 'unchecked',
	`metadata` json NOT NULL DEFAULT (JSON_OBJECT()),
	`archived` boolean NOT NULL DEFAULT false,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `sbl_ai_artifacts_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `sbl_ai_custom_templates` (
	`id` varchar(36) NOT NULL,
	`user_id` varchar(36) NOT NULL,
	`project_id` varchar(36) NOT NULL,
	`conversation_id` varchar(36),
	`original_file_name` varchar(255) NOT NULL,
	`format` varchar(16) NOT NULL,
	`mime_type` varchar(128) NOT NULL,
	`file_size` int NOT NULL,
	`sha256` varchar(64) NOT NULL,
	`storage_path` text NOT NULL,
	`analysis` json NOT NULL,
	`skill_name` varchar(64) NOT NULL,
	`skill_path` text NOT NULL,
	`skill_version` varchar(64) NOT NULL,
	`status` varchar(16) NOT NULL DEFAULT 'succeeded',
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `sbl_ai_custom_templates_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `sbl_ai_summaries` (
	`id` varchar(36) NOT NULL,
	`project_id` varchar(36) NOT NULL,
	`positioning` text,
	`highlights` json NOT NULL DEFAULT (JSON_ARRAY()),
	`risks` json NOT NULL DEFAULT (JSON_ARRAY()),
	`questions` json NOT NULL DEFAULT (JSON_ARRAY()),
	`missing` json NOT NULL DEFAULT (JSON_ARRAY()),
	`confidence` int NOT NULL DEFAULT 0,
	`sources` json NOT NULL DEFAULT (JSON_ARRAY()),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `sbl_ai_summaries_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `sbl_ai_task_sources` (
	`id` varchar(36) NOT NULL,
	`task_id` varchar(36) NOT NULL,
	`artifact_id` varchar(36),
	`source_type` varchar(24) NOT NULL,
	`source_id` varchar(64),
	`source_name` varchar(255) NOT NULL,
	`locator` text,
	`verification_status` varchar(16) NOT NULL DEFAULT '待核验',
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `sbl_ai_task_sources_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `sbl_ai_tasks` (
	`id` varchar(36) NOT NULL,
	`user_id` varchar(36) NOT NULL,
	`project_id` varchar(36) NOT NULL,
	`conversation_id` varchar(64),
	`type` varchar(40) NOT NULL,
	`parameters` json NOT NULL DEFAULT (JSON_OBJECT()),
	`template_version` varchar(64) NOT NULL,
	`status` varchar(16) NOT NULL DEFAULT 'pending',
	`stage` varchar(64) NOT NULL DEFAULT '等待执行',
	`progress` int NOT NULL DEFAULT 0,
	`result_summary` text,
	`error_id` varchar(64),
	`error_message` text,
	`cancellation_requested` boolean NOT NULL DEFAULT false,
	`idempotency_key` varchar(128) NOT NULL,
	`request_hash` varchar(64),
	`retry_of_task_id` varchar(36),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`started_at` datetime(3),
	`completed_at` datetime(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `sbl_ai_tasks_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_ai_tasks_user_idempotency` UNIQUE(`user_id`,`idempotency_key`)
);
--> statement-breakpoint
CREATE TABLE `sbl_audit_logs` (
	`id` varchar(36) NOT NULL,
	`user_id` varchar(36),
	`user_name` varchar(64) NOT NULL,
	`module` varchar(32) NOT NULL,
	`action` varchar(64) NOT NULL,
	`target` text,
	`ip` varchar(45),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `sbl_audit_logs_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `sbl_chat_conversations` (
	`id` varchar(36) NOT NULL,
	`user_id` varchar(36),
	`title` varchar(128) NOT NULL DEFAULT '新会话',
	`scope` varchar(16) NOT NULL DEFAULT 'project',
	`project_id` varchar(36),
	`project_name` varchar(128),
	`agent_id` varchar(64),
	`messages` json NOT NULL DEFAULT (JSON_ARRAY()),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `sbl_chat_conversations_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `sbl_file_chunks` (
	`id` varchar(36) NOT NULL,
	`file_id` varchar(36) NOT NULL,
	`project_id` varchar(36) NOT NULL,
	`file_name` varchar(255) NOT NULL,
	`chunk_index` int NOT NULL DEFAULT 0,
	`content` text NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `sbl_file_chunks_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `sbl_knowledge_chunks` (
	`id` varchar(36) NOT NULL,
	`scope` varchar(16) NOT NULL,
	`ref_id` varchar(64) NOT NULL,
	`source_type` varchar(24) NOT NULL,
	`source_id` varchar(64),
	`source_name` varchar(255) NOT NULL DEFAULT '',
	`chunk_index` int NOT NULL DEFAULT 0,
	`content` text NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `sbl_knowledge_chunks_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `sbl_leads` (
	`id` varchar(36) NOT NULL,
	`name` varchar(128) NOT NULL,
	`company_name` varchar(128),
	`industry` varchar(64),
	`business_region` varchar(32),
	`business_region_source` varchar(64),
	`business_region_confidence` varchar(8),
	`source` text,
	`pool_status` varchar(32) NOT NULL DEFAULT '成功',
	`score` int NOT NULL DEFAULT 0,
	`summary` text,
	`highlights` json NOT NULL DEFAULT (JSON_ARRAY()),
	`risks` json NOT NULL DEFAULT (JSON_ARRAY()),
	`team` text,
	`funding_rounds` json NOT NULL DEFAULT (JSON_ARRAY()),
	`risk_tags` json NOT NULL DEFAULT (JSON_ARRAY()),
	`sources` json NOT NULL DEFAULT (JSON_ARRAY()),
	`scoring` json,
	`radar_profile` json,
	`radar_source_keys` json NOT NULL DEFAULT (JSON_ARRAY()),
	`claimed_by` varchar(64),
	`converted_project_id` varchar(36),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`active_name` varchar(128) GENERATED ALWAYS AS ((CASE WHEN pool_status <> '已转专属项目' THEN name ELSE NULL END)) STORED,
	CONSTRAINT `sbl_leads_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_leads_name_active` UNIQUE(`active_name`)
);
--> statement-breakpoint
CREATE TABLE `sbl_meetings` (
	`id` varchar(36) NOT NULL,
	`project_id` varchar(36),
	`project_name` varchar(128) NOT NULL,
	`title` varchar(255) NOT NULL,
	`type` varchar(32) NOT NULL DEFAULT '项目会议',
	`host` varchar(64) NOT NULL,
	`attendees` json NOT NULL DEFAULT (JSON_ARRAY()),
	`raw_transcript` text,
	`ai_summary` text,
	`conclusions` json NOT NULL DEFAULT (JSON_ARRAY()),
	`started_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`created_by` varchar(36),
	CONSTRAINT `sbl_meetings_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `sbl_project_files` (
	`id` varchar(36) NOT NULL,
	`project_id` varchar(36) NOT NULL,
	`name` varchar(255) NOT NULL,
	`type` varchar(16) NOT NULL,
	`category` varchar(32) NOT NULL,
	`size` varchar(32),
	`uploader` varchar(64) NOT NULL,
	`parse_status` varchar(16) NOT NULL DEFAULT '解析中',
	`visibility` varchar(16) NOT NULL DEFAULT '项目成员',
	`storage_path` text,
	`content_text` text,
	`parse_error` text,
	`version` int NOT NULL DEFAULT 1,
	`uploaded_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `sbl_project_files_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `sbl_projects` (
	`id` varchar(36) NOT NULL,
	`name` varchar(128) NOT NULL,
	`company_name` varchar(128),
	`industry` varchar(64),
	`round` varchar(64),
	`stage` varchar(16) NOT NULL DEFAULT '线索',
	`stage_source` varchar(32),
	`owner` varchar(64) NOT NULL,
	`collaborators` json NOT NULL DEFAULT (JSON_ARRAY()),
	`source` text,
	`financing` text,
	`valuation` text,
	`risk_level` varchar(8) NOT NULL DEFAULT '低',
	`score` int NOT NULL DEFAULT 0,
	`progress` int NOT NULL DEFAULT 0,
	`summary` text,
	`business_model` text,
	`market` text,
	`team` text,
	`tags` json NOT NULL DEFAULT (JSON_ARRAY()),
	`latest_approval_id` varchar(36),
	`created_by` varchar(36),
	`scoring` json,
	`pinned` boolean NOT NULL DEFAULT false,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `sbl_projects_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `sbl_radar_ai_reviews` (
	`cache_key` varchar(64) NOT NULL,
	`source_key` text NOT NULL,
	`content_hash` varchar(64) NOT NULL,
	`prompt_version` varchar(32) NOT NULL,
	`model` varchar(128) NOT NULL,
	`status` varchar(16) NOT NULL,
	`decision` json NOT NULL DEFAULT (JSON_OBJECT()),
	`attempts` int NOT NULL DEFAULT 0,
	`last_error` text,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `sbl_radar_ai_reviews_cache_key` PRIMARY KEY(`cache_key`)
);
--> statement-breakpoint
CREATE TABLE `sbl_radar_sync_state` (
	`id` varchar(64) NOT NULL,
	`backfill_cursor` text,
	`backfill_complete` boolean NOT NULL DEFAULT false,
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `sbl_radar_sync_state_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `sbl_risks` (
	`id` varchar(36) NOT NULL,
	`project_id` varchar(36),
	`project_name` varchar(128) NOT NULL,
	`type` varchar(32) NOT NULL,
	`level` varchar(8) NOT NULL DEFAULT '中',
	`title` varchar(255) NOT NULL,
	`description` text,
	`source` varchar(32) NOT NULL DEFAULT '人工录入',
	`status` varchar(16) NOT NULL DEFAULT '待处置',
	`assignee` varchar(64),
	`detected_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`resolved_at` datetime(3),
	CONSTRAINT `sbl_risks_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `sbl_todos` (
	`id` varchar(36) NOT NULL,
	`project_id` varchar(36),
	`project_name` varchar(128),
	`title` varchar(255) NOT NULL,
	`owner` varchar(64) NOT NULL,
	`due_date` varchar(10),
	`priority` varchar(8) NOT NULL DEFAULT '中',
	`status` varchar(16) NOT NULL DEFAULT '未开始',
	`type` varchar(32) NOT NULL DEFAULT '待办',
	`meeting_id` varchar(36),
	`created_by` varchar(36),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `sbl_todos_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `sbl_users` (
	`id` varchar(36) NOT NULL,
	`email` varchar(255) NOT NULL,
	`name` varchar(64) NOT NULL,
	`role` varchar(32) NOT NULL,
	`department` varchar(64) NOT NULL DEFAULT '投资部',
	`password_hash` text NOT NULL,
	`status` varchar(8) NOT NULL DEFAULT '启用',
	`last_login` datetime(3),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `sbl_users_id` PRIMARY KEY(`id`),
	CONSTRAINT `sbl_users_email_unique` UNIQUE(`email`)
);
--> statement-breakpoint
ALTER TABLE `sbl_ai_artifacts` ADD CONSTRAINT `sbl_ai_artifacts_task_id_sbl_ai_tasks_id_fk` FOREIGN KEY (`task_id`) REFERENCES `sbl_ai_tasks`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `sbl_ai_artifacts` ADD CONSTRAINT `sbl_ai_artifacts_user_id_sbl_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `sbl_users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `sbl_ai_artifacts` ADD CONSTRAINT `sbl_ai_artifacts_project_id_sbl_projects_id_fk` FOREIGN KEY (`project_id`) REFERENCES `sbl_projects`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `sbl_ai_custom_templates` ADD CONSTRAINT `sbl_ai_custom_templates_user_id_sbl_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `sbl_users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `sbl_ai_custom_templates` ADD CONSTRAINT `sbl_ai_custom_templates_project_id_sbl_projects_id_fk` FOREIGN KEY (`project_id`) REFERENCES `sbl_projects`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `sbl_ai_custom_templates` ADD CONSTRAINT `fk_ai_custom_templates_conversation` FOREIGN KEY (`conversation_id`) REFERENCES `sbl_chat_conversations`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `sbl_ai_summaries` ADD CONSTRAINT `sbl_ai_summaries_project_id_sbl_projects_id_fk` FOREIGN KEY (`project_id`) REFERENCES `sbl_projects`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `sbl_ai_task_sources` ADD CONSTRAINT `sbl_ai_task_sources_task_id_sbl_ai_tasks_id_fk` FOREIGN KEY (`task_id`) REFERENCES `sbl_ai_tasks`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `sbl_ai_task_sources` ADD CONSTRAINT `sbl_ai_task_sources_artifact_id_sbl_ai_artifacts_id_fk` FOREIGN KEY (`artifact_id`) REFERENCES `sbl_ai_artifacts`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `sbl_ai_tasks` ADD CONSTRAINT `sbl_ai_tasks_user_id_sbl_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `sbl_users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `sbl_ai_tasks` ADD CONSTRAINT `sbl_ai_tasks_project_id_sbl_projects_id_fk` FOREIGN KEY (`project_id`) REFERENCES `sbl_projects`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `sbl_audit_logs` ADD CONSTRAINT `sbl_audit_logs_user_id_sbl_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `sbl_users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `sbl_chat_conversations` ADD CONSTRAINT `sbl_chat_conversations_user_id_sbl_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `sbl_users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `sbl_chat_conversations` ADD CONSTRAINT `sbl_chat_conversations_project_id_sbl_projects_id_fk` FOREIGN KEY (`project_id`) REFERENCES `sbl_projects`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `sbl_file_chunks` ADD CONSTRAINT `sbl_file_chunks_file_id_sbl_project_files_id_fk` FOREIGN KEY (`file_id`) REFERENCES `sbl_project_files`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `sbl_file_chunks` ADD CONSTRAINT `sbl_file_chunks_project_id_sbl_projects_id_fk` FOREIGN KEY (`project_id`) REFERENCES `sbl_projects`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `sbl_leads` ADD CONSTRAINT `sbl_leads_converted_project_id_sbl_projects_id_fk` FOREIGN KEY (`converted_project_id`) REFERENCES `sbl_projects`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `sbl_meetings` ADD CONSTRAINT `sbl_meetings_project_id_sbl_projects_id_fk` FOREIGN KEY (`project_id`) REFERENCES `sbl_projects`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `sbl_meetings` ADD CONSTRAINT `sbl_meetings_created_by_sbl_users_id_fk` FOREIGN KEY (`created_by`) REFERENCES `sbl_users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `sbl_project_files` ADD CONSTRAINT `sbl_project_files_project_id_sbl_projects_id_fk` FOREIGN KEY (`project_id`) REFERENCES `sbl_projects`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `sbl_projects` ADD CONSTRAINT `sbl_projects_created_by_sbl_users_id_fk` FOREIGN KEY (`created_by`) REFERENCES `sbl_users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `sbl_risks` ADD CONSTRAINT `sbl_risks_project_id_sbl_projects_id_fk` FOREIGN KEY (`project_id`) REFERENCES `sbl_projects`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `sbl_todos` ADD CONSTRAINT `sbl_todos_project_id_sbl_projects_id_fk` FOREIGN KEY (`project_id`) REFERENCES `sbl_projects`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `sbl_todos` ADD CONSTRAINT `sbl_todos_meeting_id_sbl_meetings_id_fk` FOREIGN KEY (`meeting_id`) REFERENCES `sbl_meetings`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `sbl_todos` ADD CONSTRAINT `sbl_todos_created_by_sbl_users_id_fk` FOREIGN KEY (`created_by`) REFERENCES `sbl_users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `idx_ai_artifacts_task` ON `sbl_ai_artifacts` (`task_id`);--> statement-breakpoint
CREATE INDEX `idx_ai_artifacts_user` ON `sbl_ai_artifacts` (`user_id`);--> statement-breakpoint
CREATE INDEX `idx_ai_artifacts_project` ON `sbl_ai_artifacts` (`project_id`);--> statement-breakpoint
CREATE INDEX `idx_ai_custom_templates_user` ON `sbl_ai_custom_templates` (`user_id`);--> statement-breakpoint
CREATE INDEX `idx_ai_custom_templates_project` ON `sbl_ai_custom_templates` (`project_id`);--> statement-breakpoint
CREATE INDEX `idx_ai_custom_templates_conversation` ON `sbl_ai_custom_templates` (`conversation_id`);--> statement-breakpoint
CREATE INDEX `idx_ai_summaries_project` ON `sbl_ai_summaries` (`project_id`);--> statement-breakpoint
CREATE INDEX `idx_ai_task_sources_task` ON `sbl_ai_task_sources` (`task_id`);--> statement-breakpoint
CREATE INDEX `idx_ai_task_sources_artifact` ON `sbl_ai_task_sources` (`artifact_id`);--> statement-breakpoint
CREATE INDEX `idx_ai_tasks_user` ON `sbl_ai_tasks` (`user_id`);--> statement-breakpoint
CREATE INDEX `idx_ai_tasks_project` ON `sbl_ai_tasks` (`project_id`);--> statement-breakpoint
CREATE INDEX `idx_ai_tasks_status` ON `sbl_ai_tasks` (`status`);--> statement-breakpoint
CREATE INDEX `idx_audit_user` ON `sbl_audit_logs` (`user_id`);--> statement-breakpoint
CREATE INDEX `idx_audit_time` ON `sbl_audit_logs` (`created_at`);--> statement-breakpoint
CREATE INDEX `idx_chat_conv_user` ON `sbl_chat_conversations` (`user_id`);--> statement-breakpoint
CREATE INDEX `idx_chat_conv_updated` ON `sbl_chat_conversations` (`updated_at`);--> statement-breakpoint
CREATE INDEX `idx_chat_conv_agent` ON `sbl_chat_conversations` (`agent_id`);--> statement-breakpoint
CREATE INDEX `idx_file_chunks_file` ON `sbl_file_chunks` (`file_id`);--> statement-breakpoint
CREATE INDEX `idx_file_chunks_project` ON `sbl_file_chunks` (`project_id`);--> statement-breakpoint
CREATE INDEX `idx_kc_scope_ref` ON `sbl_knowledge_chunks` (`scope`,`ref_id`);--> statement-breakpoint
CREATE INDEX `idx_kc_scope` ON `sbl_knowledge_chunks` (`scope`);--> statement-breakpoint
CREATE INDEX `idx_kc_source` ON `sbl_knowledge_chunks` (`source_id`);--> statement-breakpoint
CREATE INDEX `idx_meetings_project` ON `sbl_meetings` (`project_id`);--> statement-breakpoint
CREATE INDEX `idx_project_files_project` ON `sbl_project_files` (`project_id`);--> statement-breakpoint
CREATE INDEX `idx_projects_stage` ON `sbl_projects` (`stage`);--> statement-breakpoint
CREATE INDEX `idx_projects_owner` ON `sbl_projects` (`owner`);--> statement-breakpoint
CREATE INDEX `idx_radar_ai_reviews_status` ON `sbl_radar_ai_reviews` (`status`);--> statement-breakpoint
CREATE INDEX `idx_risks_project` ON `sbl_risks` (`project_id`);--> statement-breakpoint
CREATE INDEX `idx_risks_status` ON `sbl_risks` (`status`);--> statement-breakpoint
CREATE INDEX `idx_todos_owner` ON `sbl_todos` (`owner`);--> statement-breakpoint
CREATE INDEX `idx_todos_project` ON `sbl_todos` (`project_id`);
