CREATE TABLE `sbl_assistant_experience_settings` (
  `user_id` varchar(36) NOT NULL PRIMARY KEY,
  `auto_summary_enabled` boolean NOT NULL DEFAULT true,
  `processed_turn_count` int NOT NULL DEFAULT 0,
  `revision` int NOT NULL DEFAULT 1,
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT `fk_assistant_experience_settings_user` FOREIGN KEY (`user_id`) REFERENCES `sbl_users` (`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `sbl_assistant_experience_candidates` (
  `id` varchar(36) NOT NULL PRIMARY KEY,
  `user_id` varchar(36) NOT NULL,
  `conversation_id` varchar(36) NOT NULL,
  `project_id` varchar(36) NULL,
  `trigger_type` varchar(24) NOT NULL,
  `start_turn` int NULL,
  `end_turn` int NULL,
  `source_message_id` varchar(36) NULL,
  `rule` text NOT NULL,
  `evidence` text NOT NULL,
  `example` text NULL,
  `suggested_scope` varchar(16) NOT NULL,
  `content_hash` varchar(64) NOT NULL,
  `status` varchar(16) NOT NULL DEFAULT 'pending',
  `version` int NOT NULL DEFAULT 1,
  `decided_at` datetime(3) NULL,
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY `uq_assistant_experience_candidate_window` (`user_id`,`conversation_id`,`start_turn`,`end_turn`,`trigger_type`),
  UNIQUE KEY `uq_assistant_experience_candidate_source` (`user_id`,`source_message_id`,`trigger_type`),
  KEY `idx_assistant_experience_candidates_user_status` (`user_id`,`status`,`created_at`),
  CONSTRAINT `fk_assistant_experience_candidate_user` FOREIGN KEY (`user_id`) REFERENCES `sbl_users` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_assistant_experience_candidate_conversation` FOREIGN KEY (`conversation_id`) REFERENCES `sbl_agent_conversations` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_assistant_experience_candidate_project` FOREIGN KEY (`project_id`) REFERENCES `sbl_projects` (`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `sbl_assistant_experiences` (
  `id` varchar(36) NOT NULL PRIMARY KEY,
  `user_id` varchar(36) NOT NULL,
  `scope_type` varchar(16) NOT NULL,
  `scope_key` varchar(36) NULL,
  `rule` text NOT NULL,
  `content_hash` varchar(64) NOT NULL,
  `status` varchar(16) NOT NULL DEFAULT 'active',
  `version` int NOT NULL DEFAULT 1,
  `source_candidate_id` varchar(36) NULL,
  `last_used_at` datetime(3) NULL,
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY `uq_assistant_experience_content` (`user_id`,`scope_type`,`scope_key`,`content_hash`),
  KEY `idx_assistant_experiences_user_status` (`user_id`,`status`,`scope_type`,`scope_key`),
  CONSTRAINT `fk_assistant_experience_user` FOREIGN KEY (`user_id`) REFERENCES `sbl_users` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_assistant_experience_project` FOREIGN KEY (`scope_key`) REFERENCES `sbl_projects` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_assistant_experience_source_candidate` FOREIGN KEY (`source_candidate_id`) REFERENCES `sbl_assistant_experience_candidates` (`id`) ON DELETE SET NULL
);
--> statement-breakpoint
CREATE TABLE `sbl_assistant_experience_decisions` (
  `id` varchar(36) NOT NULL PRIMARY KEY,
  `user_id` varchar(36) NOT NULL,
  `candidate_id` varchar(36) NULL,
  `experience_id` varchar(36) NULL,
  `action` varchar(16) NOT NULL,
  `idempotency_key` varchar(36) NOT NULL,
  `from_version` int NULL,
  `to_version` int NULL,
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY `uq_assistant_experience_decision_idempotency` (`user_id`,`idempotency_key`),
  KEY `idx_assistant_experience_decisions_candidate` (`candidate_id`,`created_at`),
  CONSTRAINT `fk_assistant_experience_decision_user` FOREIGN KEY (`user_id`) REFERENCES `sbl_users` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_assistant_experience_decision_candidate` FOREIGN KEY (`candidate_id`) REFERENCES `sbl_assistant_experience_candidates` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_assistant_experience_decision_experience` FOREIGN KEY (`experience_id`) REFERENCES `sbl_assistant_experiences` (`id`) ON DELETE SET NULL
);
