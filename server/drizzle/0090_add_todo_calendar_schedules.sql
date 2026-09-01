CREATE TABLE `sbl_todo_calendar_schedules` (
  `task_id` varchar(36) NOT NULL,
  `owner_user_id` varchar(36) NOT NULL,
  `starts_at` datetime(3) NOT NULL,
  `ends_at` datetime(3) NOT NULL,
  `hidden` boolean NOT NULL DEFAULT false,
  `version` int NOT NULL DEFAULT 1,
  `updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT `sbl_todo_calendar_schedules_task_id_pk` PRIMARY KEY (`task_id`),
  CONSTRAINT `fk_todo_calendar_schedule_task` FOREIGN KEY (`task_id`) REFERENCES `sbl_todos` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_todo_calendar_schedule_owner` FOREIGN KEY (`owner_user_id`) REFERENCES `sbl_users` (`id`) ON DELETE RESTRICT,
  KEY `idx_todo_calendar_owner_time` (`owner_user_id`,`starts_at`),
  CHECK (`ends_at` > `starts_at`)
);
--> statement-breakpoint
CREATE TABLE `sbl_todo_calendar_schedule_history` (
  `id` varchar(36) NOT NULL,
  `task_id` varchar(36) NOT NULL,
  `request_id` varchar(36) NOT NULL,
  `request_hash` varchar(64) NOT NULL,
  `actor_id` varchar(36) NOT NULL,
  `action` varchar(16) NOT NULL,
  `reason` text NOT NULL,
  `version` int NOT NULL,
  `snapshot` json NOT NULL,
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT `sbl_todo_calendar_schedule_history_id_pk` PRIMARY KEY (`id`),
  CONSTRAINT `fk_todo_calendar_history_task` FOREIGN KEY (`task_id`) REFERENCES `sbl_todos` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_todo_calendar_history_actor` FOREIGN KEY (`actor_id`) REFERENCES `sbl_users` (`id`) ON DELETE RESTRICT,
  UNIQUE KEY `uq_todo_calendar_history_request` (`request_id`),
  KEY `idx_todo_calendar_history_task` (`task_id`,`version`)
);
