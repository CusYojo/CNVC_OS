CREATE TABLE `sbl_ai_evolution_skill_applications` (
  `id` varchar(36) NOT NULL PRIMARY KEY,
  `owner_user_id` varchar(36) NOT NULL,
  `task_id` varchar(128) NOT NULL,
  `task_type` varchar(100) NOT NULL,
  `conversation_id` varchar(36) NULL,
  `business_project_id` varchar(36) NULL,
  `context_hash` varchar(64) NOT NULL,
  `snapshot_hash` varchar(64) NOT NULL,
  `snapshot` json NOT NULL,
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY `uq_evo_skill_application_task` (`owner_user_id`, `task_id`)
);
