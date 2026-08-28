ALTER TABLE `sbl_todos`
  ADD COLUMN `due_time` varchar(5) NULL,
  ADD CONSTRAINT `sbl_todo_due_time_ck` CHECK (`due_time` IS NULL OR (`due_date` IS NOT NULL AND `due_time` REGEXP '^([01][0-9]|2[0-3]):[0-5][0-9]$'));
--> statement-breakpoint
ALTER TABLE `sbl_project_weekly_plan_items` ADD COLUMN `due_time` varchar(5) NULL;
--> statement-breakpoint
CREATE TABLE `sbl_project_directives` (
  `id` varchar(36) NOT NULL PRIMARY KEY,
  `project_id` varchar(36) NOT NULL,
  `task_id` varchar(36) NOT NULL,
  `issuer_id` varchar(36) NOT NULL,
  `content` text NOT NULL,
  `conversion` varchar(24) NOT NULL,
  `requires_receipt` boolean NOT NULL DEFAULT TRUE,
  `acknowledged_at` datetime(3) NULL,
  `acknowledged_by` varchar(36) NULL,
  `withdrawn_at` datetime(3) NULL,
  `withdrawal_reason` text NULL,
  `version` int NOT NULL DEFAULT 1,
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY `uq_directive_task` (`task_id`),
  KEY `idx_directive_project` (`project_id`),
  FOREIGN KEY (`project_id`) REFERENCES `sbl_projects` (`id`) ON DELETE RESTRICT,
  FOREIGN KEY (`task_id`) REFERENCES `sbl_todos` (`id`) ON DELETE RESTRICT,
  FOREIGN KEY (`issuer_id`) REFERENCES `sbl_users` (`id`) ON DELETE RESTRICT,
  FOREIGN KEY (`acknowledged_by`) REFERENCES `sbl_users` (`id`) ON DELETE RESTRICT,
  CHECK (`conversion` IN ('action','pending','leadership')),
  CHECK ((`acknowledged_at` IS NULL) = (`acknowledged_by` IS NULL)),
  CHECK (`withdrawn_at` IS NULL OR CHAR_LENGTH(`withdrawal_reason`) >= 5)
);
--> statement-breakpoint
CREATE TABLE `sbl_leader_time_requests` (
  `id` varchar(36) NOT NULL PRIMARY KEY,
  `project_id` varchar(36) NOT NULL,
  `source_directive_id` varchar(36) NULL,
  `task_id` varchar(36) NULL,
  `leader_id` varchar(36) NOT NULL,
  `submitted_by` varchar(36) NOT NULL,
  `title` text NOT NULL,
  `preferred_start` datetime(3) NOT NULL,
  `alternative_start` datetime(3) NULL,
  `duration_minutes` int NOT NULL DEFAULT 30,
  `location` varchar(255) NOT NULL DEFAULT '待确认',
  `status` varchar(24) NOT NULL DEFAULT 'draft',
  `version` int NOT NULL DEFAULT 1,
  `closure_reason` text NULL,
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY `uq_leader_time_directive` (`source_directive_id`),
  KEY `idx_leader_time_owner` (`leader_id`,`status`),
  FOREIGN KEY (`project_id`) REFERENCES `sbl_projects` (`id`) ON DELETE RESTRICT,
  FOREIGN KEY (`source_directive_id`) REFERENCES `sbl_project_directives` (`id`) ON DELETE RESTRICT,
  FOREIGN KEY (`task_id`) REFERENCES `sbl_todos` (`id`) ON DELETE RESTRICT,
  FOREIGN KEY (`leader_id`) REFERENCES `sbl_users` (`id`) ON DELETE RESTRICT,
  FOREIGN KEY (`submitted_by`) REFERENCES `sbl_users` (`id`) ON DELETE RESTRICT,
  CHECK (`duration_minutes` > 0 AND `duration_minutes` <= 780)
);
--> statement-breakpoint
CREATE TABLE `sbl_directive_events` (
  `id` varchar(36) NOT NULL PRIMARY KEY,
  `directive_id` varchar(36) NOT NULL,
  `request_id` varchar(36) NOT NULL,
  `request_hash` varchar(64) NOT NULL,
  `actor_id` varchar(36) NOT NULL,
  `action` varchar(32) NOT NULL,
  `version` int NOT NULL,
  `reason` text NOT NULL,
  `snapshot` json NOT NULL,
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY `uq_directive_request` (`request_id`),
  KEY `idx_directive_event` (`directive_id`,`version`),
  FOREIGN KEY (`directive_id`) REFERENCES `sbl_project_directives` (`id`) ON DELETE RESTRICT,
  FOREIGN KEY (`actor_id`) REFERENCES `sbl_users` (`id`) ON DELETE RESTRICT
);
--> statement-breakpoint
CREATE TABLE `sbl_directive_notices` (
  `id` varchar(36) NOT NULL PRIMARY KEY,
  `directive_id` varchar(36) NOT NULL,
  `recipient_id` varchar(36) NOT NULL,
  `kind` varchar(32) NOT NULL,
  `version` int NOT NULL,
  `read_at` datetime(3) NULL,
  `closed_at` datetime(3) NULL,
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY `uq_directive_notice` (`directive_id`,`recipient_id`,`version`),
  FOREIGN KEY (`directive_id`) REFERENCES `sbl_project_directives` (`id`) ON DELETE RESTRICT,
  FOREIGN KEY (`recipient_id`) REFERENCES `sbl_users` (`id`) ON DELETE RESTRICT
);
