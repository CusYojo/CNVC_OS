CREATE TABLE `sbl_project_weekly_plans` (
  `id` varchar(36) NOT NULL PRIMARY KEY,
  `project_id` varchar(36) NOT NULL,
  `week_start` varchar(10) NOT NULL,
  `revision` int NOT NULL,
  `status` varchar(16) NOT NULL DEFAULT 'draft',
  `active_key` varchar(64),
  `goal` text NOT NULL,
  `source_fingerprint` varchar(64) NOT NULL,
  `version` int NOT NULL DEFAULT 1,
  `created_by` varchar(36) NOT NULL,
  `published_by` varchar(36),
  `published_at` datetime(3),
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY `uq_weekly_plan_revision` (`project_id`,`week_start`,`revision`),
  UNIQUE KEY `uq_weekly_plan_active` (`active_key`),
  CONSTRAINT `fk_weekly_plan_project` FOREIGN KEY (`project_id`) REFERENCES `sbl_projects` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_weekly_plan_author` FOREIGN KEY (`created_by`) REFERENCES `sbl_users` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_weekly_plan_publisher` FOREIGN KEY (`published_by`) REFERENCES `sbl_users` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `ck_weekly_plan_state` CHECK (`status` IN ('draft','submitted','published','discarded')),
  CONSTRAINT `ck_weekly_plan_version` CHECK (`version` > 0 AND `revision` > 0)
);
--> statement-breakpoint
CREATE TABLE `sbl_project_weekly_plan_items` (
  `id` varchar(36) NOT NULL PRIMARY KEY,
  `plan_id` varchar(36) NOT NULL,
  `item_key` varchar(80) NOT NULL,
  `source_kind` varchar(16) NOT NULL,
  `task_id` varchar(36),
  `plan_action_id` varchar(36),
  `source_version` int,
  `title` varchar(255) NOT NULL,
  `owner_user_id` varchar(36) NOT NULL,
  `due_date` varchar(10) NOT NULL,
  `deliverable` text NOT NULL,
  `priority` varchar(8) NOT NULL DEFAULT '中',
  `sort_order` int NOT NULL,
  UNIQUE KEY `uq_weekly_plan_item` (`plan_id`,`item_key`),
  CONSTRAINT `fk_weekly_item_plan` FOREIGN KEY (`plan_id`) REFERENCES `sbl_project_weekly_plans` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_weekly_item_task` FOREIGN KEY (`task_id`) REFERENCES `sbl_todos` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_weekly_item_action` FOREIGN KEY (`plan_action_id`) REFERENCES `sbl_project_plan_actions` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_weekly_item_owner` FOREIGN KEY (`owner_user_id`) REFERENCES `sbl_users` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `ck_weekly_item_kind` CHECK (`source_kind` IN ('task','plan','manual'))
);
--> statement-breakpoint
CREATE TABLE `sbl_project_weekly_plan_events` (
  `id` varchar(36) NOT NULL PRIMARY KEY,
  `plan_id` varchar(36) NOT NULL,
  `request_id` varchar(36) NOT NULL,
  `request_hash` varchar(64) NOT NULL,
  `actor_id` varchar(36) NOT NULL,
  `action` varchar(16) NOT NULL,
  `plan_version` int NOT NULL,
  `reason` text NOT NULL,
  `snapshot` json NOT NULL,
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY `uq_weekly_plan_request` (`request_id`),
  KEY `idx_weekly_plan_event` (`plan_id`,`plan_version`),
  CONSTRAINT `fk_weekly_event_plan` FOREIGN KEY (`plan_id`) REFERENCES `sbl_project_weekly_plans` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_weekly_event_actor` FOREIGN KEY (`actor_id`) REFERENCES `sbl_users` (`id`) ON DELETE RESTRICT
);
--> statement-breakpoint
CREATE TABLE `sbl_project_weekly_plan_notices` (
  `id` varchar(36) NOT NULL PRIMARY KEY,
  `plan_id` varchar(36) NOT NULL,
  `recipient_id` varchar(36) NOT NULL,
  `kind` varchar(16) NOT NULL,
  `plan_version` int NOT NULL,
  `closed_at` datetime(3),
  `read_at` datetime(3),
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY `uq_weekly_plan_notice` (`plan_id`,`recipient_id`,`kind`,`plan_version`),
  CONSTRAINT `fk_weekly_notice_plan` FOREIGN KEY (`plan_id`) REFERENCES `sbl_project_weekly_plans` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_weekly_notice_recipient` FOREIGN KEY (`recipient_id`) REFERENCES `sbl_users` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `ck_weekly_notice_kind` CHECK (`kind` IN ('review','published','returned'))
);
