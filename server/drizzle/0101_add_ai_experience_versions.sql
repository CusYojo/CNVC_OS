CREATE TABLE `sbl_ai_experiences` (
  `id` varchar(36) NOT NULL PRIMARY KEY,
  `owner_user_id` varchar(36) NOT NULL,
  `scope_type` varchar(24) NOT NULL,
  `scope_key` varchar(128) NOT NULL,
  `business_project_id` varchar(36) NULL,
  `active_version_id` varchar(36) NULL,
  `status` varchar(16) NOT NULL,
  `revision` int NOT NULL DEFAULT 1,
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY `idx_evo_experience_owner` (`owner_user_id`, `status`)
);
--> statement-breakpoint
CREATE TABLE `sbl_ai_experience_versions` (
  `id` varchar(36) NOT NULL PRIMARY KEY,
  `experience_id` varchar(36) NOT NULL,
  `proposal_id` varchar(36) NOT NULL,
  `spec` json NOT NULL,
  `content_hash` varchar(64) NOT NULL,
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  FOREIGN KEY (`experience_id`) REFERENCES `sbl_ai_experiences` (`id`),
  FOREIGN KEY (`proposal_id`) REFERENCES `sbl_ai_evolution_proposals` (`id`),
  UNIQUE KEY `uq_evo_experience_proposal` (`proposal_id`)
);
--> statement-breakpoint
CREATE TABLE `sbl_ai_evolution_applications` (
  `id` varchar(36) NOT NULL PRIMARY KEY,
  `owner_user_id` varchar(36) NOT NULL,
  `task_id` varchar(128) NOT NULL,
  `conversation_id` varchar(36) NULL,
  `task_type` varchar(100) NOT NULL,
  `business_project_id` varchar(36) NULL,
  `snapshot_hash` varchar(64) NOT NULL,
  `snapshot` json NOT NULL,
  `check_status` varchar(24) NOT NULL DEFAULT 'not_checked',
  `check_result` json NULL,
  `injected_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY `uq_evo_application_task` (`owner_user_id`, `task_id`),
  KEY `idx_evo_application_owner` (`owner_user_id`, `injected_at`)
);
