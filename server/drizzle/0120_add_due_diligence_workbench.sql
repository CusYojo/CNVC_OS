CREATE TABLE `sbl_due_diligence_questions` (
  `id` varchar(36) NOT NULL,
  `project_id` varchar(36) NOT NULL,
  `title` varchar(255) NOT NULL,
  `category` varchar(32) NOT NULL DEFAULT '业务',
  `priority` varchar(8) NOT NULL DEFAULT '中',
  `status` varchar(16) NOT NULL DEFAULT '待核查',
  `evidence_requirement` text,
  `assignee_name` varchar(64),
  `assignee_user_id` varchar(36),
  `risk_id` varchar(36),
  `file_id` varchar(36),
  `source` varchar(32) NOT NULL DEFAULT '人工创建',
  `created_by` varchar(36),
  `version` int NOT NULL DEFAULT 1,
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  KEY `idx_dd_questions_project` (`project_id`,`status`,`priority`),
  KEY `idx_dd_questions_risk` (`risk_id`),
  KEY `idx_dd_questions_assignee` (`assignee_user_id`,`status`),
  CONSTRAINT `sbl_dd_questions_project_fk` FOREIGN KEY (`project_id`) REFERENCES `sbl_projects` (`id`) ON DELETE CASCADE,
  CONSTRAINT `sbl_dd_questions_assignee_fk` FOREIGN KEY (`assignee_user_id`) REFERENCES `sbl_users` (`id`) ON DELETE SET NULL,
  CONSTRAINT `sbl_dd_questions_risk_fk` FOREIGN KEY (`risk_id`) REFERENCES `sbl_risks` (`id`) ON DELETE SET NULL,
  CONSTRAINT `sbl_dd_questions_file_fk` FOREIGN KEY (`file_id`) REFERENCES `sbl_project_files` (`id`) ON DELETE SET NULL,
  CONSTRAINT `sbl_dd_questions_creator_fk` FOREIGN KEY (`created_by`) REFERENCES `sbl_users` (`id`) ON DELETE SET NULL
);
--> statement-breakpoint
CREATE TABLE `sbl_due_diligence_interviews` (
  `id` varchar(36) NOT NULL,
  `project_id` varchar(36) NOT NULL,
  `title` varchar(255) NOT NULL,
  `mode` varchar(16) NOT NULL DEFAULT '现场',
  `status` varchar(16) NOT NULL DEFAULT '筹备中',
  `scheduled_at` datetime(3),
  `agenda` text,
  `notes` longtext,
  `summary` longtext,
  `created_by` varchar(36),
  `version` int NOT NULL DEFAULT 1,
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  KEY `idx_dd_interviews_project` (`project_id`,`scheduled_at`),
  CONSTRAINT `sbl_dd_interviews_project_fk` FOREIGN KEY (`project_id`) REFERENCES `sbl_projects` (`id`) ON DELETE CASCADE,
  CONSTRAINT `sbl_dd_interviews_creator_fk` FOREIGN KEY (`created_by`) REFERENCES `sbl_users` (`id`) ON DELETE SET NULL
);
--> statement-breakpoint
CREATE TABLE `sbl_due_diligence_interview_prompts` (
  `id` varchar(36) NOT NULL,
  `interview_id` varchar(36) NOT NULL,
  `question_id` varchar(36),
  `content` text NOT NULL,
  `status` varchar(16) NOT NULL DEFAULT '待确认',
  `created_by` varchar(36),
  `created_by_name` varchar(64) NOT NULL,
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  KEY `idx_dd_interview_prompts_interview` (`interview_id`,`created_at`),
  CONSTRAINT `sbl_dd_prompts_interview_fk` FOREIGN KEY (`interview_id`) REFERENCES `sbl_due_diligence_interviews` (`id`) ON DELETE CASCADE,
  CONSTRAINT `sbl_dd_prompts_question_fk` FOREIGN KEY (`question_id`) REFERENCES `sbl_due_diligence_questions` (`id`) ON DELETE SET NULL,
  CONSTRAINT `sbl_dd_prompts_creator_fk` FOREIGN KEY (`created_by`) REFERENCES `sbl_users` (`id`) ON DELETE SET NULL
);
--> statement-breakpoint
CREATE TABLE `sbl_digital_twins` (
  `id` varchar(36) NOT NULL,
  `owner_user_id` varchar(36) NOT NULL,
  `name` varchar(64) NOT NULL,
  `role` varchar(64) NOT NULL,
  `rules` longtext NOT NULL,
  `cases` longtext NOT NULL,
  `active_version` int NOT NULL DEFAULT 1,
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  KEY `idx_digital_twins_owner` (`owner_user_id`,`updated_at`),
  CONSTRAINT `sbl_digital_twins_owner_fk` FOREIGN KEY (`owner_user_id`) REFERENCES `sbl_users` (`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `sbl_digital_twin_versions` (
  `id` varchar(36) NOT NULL,
  `twin_id` varchar(36) NOT NULL,
  `owner_user_id` varchar(36) NOT NULL,
  `version` int NOT NULL,
  `rules` longtext NOT NULL,
  `cases` longtext NOT NULL,
  `source` varchar(16) NOT NULL DEFAULT 'manual',
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_digital_twin_versions` (`twin_id`,`version`),
  KEY `idx_digital_twin_versions_owner` (`owner_user_id`,`created_at`),
  CONSTRAINT `sbl_digital_twin_versions_twin_fk` FOREIGN KEY (`twin_id`) REFERENCES `sbl_digital_twins` (`id`) ON DELETE CASCADE,
  CONSTRAINT `sbl_digital_twin_versions_owner_fk` FOREIGN KEY (`owner_user_id`) REFERENCES `sbl_users` (`id`) ON DELETE CASCADE
);
