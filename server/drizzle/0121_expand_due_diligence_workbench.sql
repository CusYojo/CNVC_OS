ALTER TABLE `sbl_due_diligence_questions`
  ADD COLUMN `due_date` varchar(10),
  ADD COLUMN `conclusion` text,
  ADD COLUMN `follow_up_note` text;
--> statement-breakpoint
CREATE TABLE `sbl_due_diligence_question_evidence` (
  `id` varchar(36) NOT NULL, `question_id` varchar(36) NOT NULL, `file_id` varchar(36) NOT NULL,
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), PRIMARY KEY (`id`),
  UNIQUE KEY `uq_dd_question_evidence` (`question_id`,`file_id`), KEY `idx_dd_question_evidence_question` (`question_id`),
  CONSTRAINT `sbl_dd_question_evidence_question_fk` FOREIGN KEY (`question_id`) REFERENCES `sbl_due_diligence_questions` (`id`) ON DELETE CASCADE,
  CONSTRAINT `sbl_dd_question_evidence_file_fk` FOREIGN KEY (`file_id`) REFERENCES `sbl_project_files` (`id`) ON DELETE RESTRICT
);
--> statement-breakpoint
ALTER TABLE `sbl_due_diligence_interviews`
  ADD COLUMN `counterparty` varchar(255), ADD COLUMN `location` varchar(512), ADD COLUMN `participant_names` json NOT NULL DEFAULT (JSON_ARRAY());
--> statement-breakpoint
CREATE TABLE `sbl_due_diligence_interview_actions` (
  `id` varchar(36) NOT NULL, `interview_id` varchar(36) NOT NULL, `title` varchar(255) NOT NULL,
  `owner_user_id` varchar(36), `owner_name` varchar(64), `due_date` varchar(10), `status` varchar(16) NOT NULL DEFAULT '草稿', `todo_id` varchar(36), `created_by` varchar(36),
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), `updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), PRIMARY KEY (`id`),
  UNIQUE KEY `uq_dd_interview_action_todo` (`todo_id`), KEY `idx_dd_interview_actions_interview` (`interview_id`,`status`),
  CONSTRAINT `sbl_dd_interview_actions_interview_fk` FOREIGN KEY (`interview_id`) REFERENCES `sbl_due_diligence_interviews` (`id`) ON DELETE CASCADE,
  CONSTRAINT `sbl_dd_interview_actions_owner_fk` FOREIGN KEY (`owner_user_id`) REFERENCES `sbl_users` (`id`) ON DELETE SET NULL,
  CONSTRAINT `sbl_dd_interview_actions_creator_fk` FOREIGN KEY (`created_by`) REFERENCES `sbl_users` (`id`) ON DELETE SET NULL
);
--> statement-breakpoint
ALTER TABLE `sbl_due_diligence_interview_prompts`
  ADD COLUMN `response` text, ADD COLUMN `handled_by` varchar(36), ADD COLUMN `handled_at` datetime(3),
  ADD CONSTRAINT `sbl_dd_prompts_handler_fk` FOREIGN KEY (`handled_by`) REFERENCES `sbl_users` (`id`) ON DELETE SET NULL;
--> statement-breakpoint
CREATE TABLE `sbl_digital_twin_conversations` (
  `id` varchar(36) NOT NULL, `twin_id` varchar(36) NOT NULL, `owner_user_id` varchar(36) NOT NULL, `project_id` varchar(36),
  `conversation_id` varchar(36) NOT NULL, `agent_id` varchar(128) NOT NULL, `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), `updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), PRIMARY KEY (`id`),
  UNIQUE KEY `uq_digital_twin_conversation_scope` (`twin_id`,`project_id`), KEY `idx_digital_twin_conversations_owner` (`owner_user_id`,`updated_at`),
  CONSTRAINT `sbl_digital_twin_conversations_twin_fk` FOREIGN KEY (`twin_id`) REFERENCES `sbl_digital_twins` (`id`) ON DELETE CASCADE,
  CONSTRAINT `sbl_digital_twin_conversations_owner_fk` FOREIGN KEY (`owner_user_id`) REFERENCES `sbl_users` (`id`) ON DELETE CASCADE,
  CONSTRAINT `sbl_digital_twin_conversations_project_fk` FOREIGN KEY (`project_id`) REFERENCES `sbl_projects` (`id`) ON DELETE SET NULL
);
--> statement-breakpoint
CREATE TABLE `sbl_digital_twin_update_candidates` (
  `id` varchar(36) NOT NULL, `twin_id` varchar(36) NOT NULL, `owner_user_id` varchar(36) NOT NULL, `rules` longtext NOT NULL, `cases` longtext NOT NULL, `source_note` text NOT NULL,
  `status` varchar(16) NOT NULL DEFAULT '待确认', `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), `decided_at` datetime(3), PRIMARY KEY (`id`),
  KEY `idx_digital_twin_candidates_twin` (`twin_id`,`status`,`created_at`),
  CONSTRAINT `sbl_digital_twin_candidates_twin_fk` FOREIGN KEY (`twin_id`) REFERENCES `sbl_digital_twins` (`id`) ON DELETE CASCADE,
  CONSTRAINT `sbl_digital_twin_candidates_owner_fk` FOREIGN KEY (`owner_user_id`) REFERENCES `sbl_users` (`id`) ON DELETE CASCADE
);
