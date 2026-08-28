CREATE TABLE `sbl_project_timeline_tasks` (
  `task_id` varchar(36) NOT NULL PRIMARY KEY, `project_id` varchar(36) NOT NULL,
  `stage` varchar(16) NOT NULL, `action_key` varchar(96) NOT NULL,
  `due_date` varchar(10) NOT NULL, `due_time` varchar(5) NOT NULL, `owner_user_id` varchar(36) NOT NULL,
  `need_leader` boolean NOT NULL DEFAULT false, `critical` boolean NOT NULL DEFAULT false,
  `retired` boolean NOT NULL DEFAULT false, `version` int NOT NULL DEFAULT 1,
  UNIQUE KEY `uq_project_timeline_task` (`project_id`,`stage`,`action_key`),
  FOREIGN KEY (`task_id`) REFERENCES `sbl_todos` (`id`) ON DELETE RESTRICT,
  FOREIGN KEY (`project_id`) REFERENCES `sbl_projects` (`id`) ON DELETE RESTRICT,
  FOREIGN KEY (`owner_user_id`) REFERENCES `sbl_users` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `chk_timeline_task_version` CHECK (`version`>0)
);
--> statement-breakpoint
CREATE TABLE `sbl_project_timeline_syncs` (
  `id` varchar(36) NOT NULL PRIMARY KEY, `project_id` varchar(36) NOT NULL, `actor_id` varchar(36) NOT NULL,
  `approval_id` varchar(36), `fingerprint` varchar(64) NOT NULL, `changes` json NOT NULL, `issues` json NOT NULL,
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), KEY `idx_project_timeline_sync` (`project_id`,`created_at`),
  FOREIGN KEY (`project_id`) REFERENCES `sbl_projects` (`id`) ON DELETE RESTRICT,
  FOREIGN KEY (`actor_id`) REFERENCES `sbl_users` (`id`) ON DELETE RESTRICT,
  FOREIGN KEY (`approval_id`) REFERENCES `sbl_oa_approval_requests` (`id`) ON DELETE RESTRICT
);
