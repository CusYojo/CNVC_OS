ALTER TABLE `sbl_todos`
  ADD COLUMN `execution_model` varchar(16) NOT NULL DEFAULT 'legacy',
  ADD COLUMN `creation_fingerprint` varchar(64),
  ADD COLUMN `plan_action_id` varchar(36),
  ADD COLUMN `progress` int NOT NULL DEFAULT 0,
  ADD COLUMN `deliverable` text,
  ADD COLUMN `closure_reason` text,
  ADD COLUMN `completed_at` datetime(3),
  ADD UNIQUE KEY `uq_todo_plan_action` (`plan_action_id`),
  ADD CONSTRAINT `fk_todo_plan_action` FOREIGN KEY (`plan_action_id`) REFERENCES `sbl_project_plan_actions` (`id`) ON DELETE RESTRICT,
  ADD CONSTRAINT `ck_todo_progress` CHECK (`progress` BETWEEN 0 AND 100);
--> statement-breakpoint
CREATE TABLE `sbl_todo_feedbacks` (
  `id` varchar(36) NOT NULL PRIMARY KEY,
  `todo_id` varchar(36) NOT NULL,
  `task_version` int NOT NULL,
  `kind` varchar(16) NOT NULL,
  `progress` int NOT NULL,
  `result` text NOT NULL,
  `blocker` text NOT NULL,
  `estimated_date` varchar(10),
  `submitted_by` varchar(36) NOT NULL,
  `submitted_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY `uq_todo_feedback_revision` (`todo_id`,`task_version`),
  CONSTRAINT `fk_todo_feedback_task` FOREIGN KEY (`todo_id`) REFERENCES `sbl_todos` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_todo_feedback_actor` FOREIGN KEY (`submitted_by`) REFERENCES `sbl_users` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `ck_todo_feedback_kind` CHECK (`kind` IN ('progress','submission')),
  CONSTRAINT `ck_todo_feedback_progress` CHECK ((`kind`='progress' AND `progress` BETWEEN 0 AND 99) OR (`kind`='submission' AND `progress`=100))
);
--> statement-breakpoint
CREATE TABLE `sbl_todo_feedback_evidence` (
  `id` varchar(36) NOT NULL PRIMARY KEY,
  `feedback_id` varchar(36) NOT NULL,
  `file_id` varchar(36) NOT NULL,
  `file_version_id` varchar(36) NOT NULL,
  `version` int NOT NULL,
  `sha256` varchar(64) NOT NULL,
  `byte_size` bigint NOT NULL,
  UNIQUE KEY `uq_todo_feedback_file` (`feedback_id`,`file_id`),
  CONSTRAINT `fk_todo_evidence_feedback` FOREIGN KEY (`feedback_id`) REFERENCES `sbl_todo_feedbacks` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_todo_evidence_file` FOREIGN KEY (`file_id`) REFERENCES `sbl_project_files` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_todo_evidence_version` FOREIGN KEY (`file_version_id`) REFERENCES `sbl_project_file_versions` (`id`) ON DELETE RESTRICT
);
--> statement-breakpoint
CREATE TABLE `sbl_todo_acceptances` (
  `id` varchar(36) NOT NULL PRIMARY KEY,
  `todo_id` varchar(36) NOT NULL,
  `feedback_id` varchar(36) NOT NULL,
  `decision` varchar(16) NOT NULL,
  `reason` text NOT NULL,
  `decided_by` varchar(36) NOT NULL,
  `decided_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY `uq_todo_acceptance_feedback` (`feedback_id`),
  CONSTRAINT `fk_todo_acceptance_task` FOREIGN KEY (`todo_id`) REFERENCES `sbl_todos` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_todo_acceptance_feedback` FOREIGN KEY (`feedback_id`) REFERENCES `sbl_todo_feedbacks` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_todo_acceptance_actor` FOREIGN KEY (`decided_by`) REFERENCES `sbl_users` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `ck_todo_acceptance_decision` CHECK (`decision` IN ('accept','return'))
);
--> statement-breakpoint
ALTER TABLE `sbl_oa_approval_requests`
  ADD COLUMN `business_type` varchar(32) NOT NULL DEFAULT 'project_stage',
  ADD COLUMN `task_id` varchar(36),
  ADD COLUMN `business_payload` json NOT NULL DEFAULT (JSON_OBJECT()),
  ADD CONSTRAINT `fk_oa_task_subject` FOREIGN KEY (`task_id`) REFERENCES `sbl_todos` (`id`) ON DELETE RESTRICT;
