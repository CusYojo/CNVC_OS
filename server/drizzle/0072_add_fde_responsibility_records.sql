CREATE TABLE `sbl_responsibility_records` (
  `id` varchar(36) NOT NULL PRIMARY KEY,
  `project_id` varchar(36) NOT NULL, `task_id` varchar(36) NOT NULL, `subject_id` varchar(36) NOT NULL,
  `policy_version_id` varchar(36) NOT NULL, `activation_event_id` varchar(36) NOT NULL, `policy_sha256` varchar(64) NOT NULL,
  `event_code` varchar(32) NOT NULL, `source_key` varchar(64) NOT NULL,
  `source_feedback_id` varchar(36) NULL, `related_feedback_id` varchar(36) NULL, `source_acceptance_id` varchar(36) NULL, `source_risk_id` varchar(36) NULL,
  `deadline_key` varchar(32) NULL, `occurred_at` datetime(3) NOT NULL, `fact_snapshot` json NOT NULL,
  `original_points` int NOT NULL, `effective_points` int NOT NULL DEFAULT 0,
  `status` varchar(32) NOT NULL, `reason` text NOT NULL, `reviewer_id` varchar(36) NULL, `appealed_at` datetime(3) NULL,
  `created_by` varchar(36) NOT NULL, `version` int NOT NULL DEFAULT 1, `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY `uq_resp_record_source` (`source_key`),
  KEY `idx_resp_record_project` (`project_id`,`created_at`,`id`), KEY `idx_resp_record_subject` (`subject_id`,`status`), KEY `idx_resp_record_reviewer` (`reviewer_id`,`status`),
  FOREIGN KEY (`project_id`) REFERENCES `sbl_projects` (`id`) ON DELETE RESTRICT,
  FOREIGN KEY (`task_id`) REFERENCES `sbl_todos` (`id`) ON DELETE RESTRICT,
  FOREIGN KEY (`subject_id`) REFERENCES `sbl_users` (`id`) ON DELETE RESTRICT,
  FOREIGN KEY (`policy_version_id`) REFERENCES `sbl_responsibility_policy_versions` (`id`) ON DELETE RESTRICT,
  FOREIGN KEY (`activation_event_id`) REFERENCES `sbl_responsibility_policy_events` (`id`) ON DELETE RESTRICT,
  FOREIGN KEY (`source_feedback_id`) REFERENCES `sbl_todo_feedbacks` (`id`) ON DELETE RESTRICT,
  FOREIGN KEY (`related_feedback_id`) REFERENCES `sbl_todo_feedbacks` (`id`) ON DELETE RESTRICT,
  FOREIGN KEY (`source_acceptance_id`) REFERENCES `sbl_todo_acceptances` (`id`) ON DELETE RESTRICT,
  FOREIGN KEY (`source_risk_id`) REFERENCES `sbl_risks` (`id`) ON DELETE RESTRICT,
  FOREIGN KEY (`reviewer_id`) REFERENCES `sbl_users` (`id`) ON DELETE RESTRICT,
  FOREIGN KEY (`created_by`) REFERENCES `sbl_users` (`id`) ON DELETE RESTRICT
);
--> statement-breakpoint
CREATE TABLE `sbl_responsibility_evidence` (
  `id` varchar(36) NOT NULL PRIMARY KEY, `record_id` varchar(36) NOT NULL, `file_id` varchar(36) NOT NULL, `file_version_id` varchar(36) NOT NULL,
  `version` int NOT NULL, `sha256` varchar(64) NOT NULL, `byte_size` bigint NOT NULL,
  UNIQUE KEY `uq_resp_evidence_version` (`record_id`,`file_version_id`),
  FOREIGN KEY (`record_id`) REFERENCES `sbl_responsibility_records` (`id`) ON DELETE RESTRICT,
  FOREIGN KEY (`file_id`) REFERENCES `sbl_project_files` (`id`) ON DELETE RESTRICT,
  FOREIGN KEY (`file_version_id`) REFERENCES `sbl_project_file_versions` (`id`) ON DELETE RESTRICT
);
--> statement-breakpoint
CREATE TABLE `sbl_responsibility_events` (
  `id` varchar(36) NOT NULL PRIMARY KEY, `record_id` varchar(36) NOT NULL, `actor_id` varchar(36) NOT NULL,
  `action` varchar(32) NOT NULL, `reason` text NOT NULL, `version` int NOT NULL, `snapshot` json NOT NULL, `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY `uq_resp_event_version` (`record_id`,`version`),
  FOREIGN KEY (`record_id`) REFERENCES `sbl_responsibility_records` (`id`) ON DELETE RESTRICT,
  FOREIGN KEY (`actor_id`) REFERENCES `sbl_users` (`id`) ON DELETE RESTRICT
);
--> statement-breakpoint
CREATE TABLE `sbl_responsibility_commands` (
  `id` varchar(36) NOT NULL PRIMARY KEY, `actor_id` varchar(36) NOT NULL, `command_id` varchar(36) NOT NULL, `project_id` varchar(36) NOT NULL,
  `command_hash` varchar(64) NULL, `receipt` json NULL, `closed_at` datetime(3) NULL, `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY `uq_resp_command_actor` (`actor_id`,`command_id`), FOREIGN KEY (`actor_id`) REFERENCES `sbl_users` (`id`) ON DELETE RESTRICT
);
--> statement-breakpoint
CREATE TABLE `sbl_responsibility_notices` (
  `id` varchar(36) NOT NULL PRIMARY KEY, `record_id` varchar(36) NOT NULL, `recipient_id` varchar(36) NOT NULL, `kind` varchar(32) NOT NULL, `version` int NOT NULL,
  `read_at` datetime(3) NULL, `closed_at` datetime(3) NULL, `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY `uq_resp_notice_version` (`record_id`,`recipient_id`,`version`), KEY `idx_resp_notice_recipient` (`recipient_id`,`closed_at`),
  FOREIGN KEY (`record_id`) REFERENCES `sbl_responsibility_records` (`id`) ON DELETE RESTRICT,
  FOREIGN KEY (`recipient_id`) REFERENCES `sbl_users` (`id`) ON DELETE RESTRICT
);
--> statement-breakpoint
CREATE TABLE `sbl_responsibility_task_markers` (
  `id` varchar(36) NOT NULL PRIMARY KEY, `task_id` varchar(36) NOT NULL, `critical` boolean NOT NULL, `actor_id` varchar(36) NOT NULL,
  `reason` text NOT NULL, `version` int NOT NULL, `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY `uq_resp_marker_version` (`task_id`,`version`),
  FOREIGN KEY (`task_id`) REFERENCES `sbl_todos` (`id`) ON DELETE RESTRICT, FOREIGN KEY (`actor_id`) REFERENCES `sbl_users` (`id`) ON DELETE RESTRICT
);
