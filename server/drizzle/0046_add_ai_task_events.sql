CREATE TABLE `sbl_ai_task_events` (
  `id` varchar(36) NOT NULL,
  `task_id` varchar(36) NOT NULL,
  `stage` varchar(64) NOT NULL,
  `progress` int NOT NULL DEFAULT 0,
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT `sbl_ai_task_events_id` PRIMARY KEY (`id`),
  CONSTRAINT `fk_ai_task_events_task` FOREIGN KEY (`task_id`) REFERENCES `sbl_ai_tasks` (`id`) ON DELETE CASCADE,
  CONSTRAINT `uq_ai_task_events_task_stage` UNIQUE (`task_id`, `stage`),
  INDEX `idx_ai_task_events_task` (`task_id`, `created_at`)
);
