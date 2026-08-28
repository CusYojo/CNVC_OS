CREATE TABLE `sbl_project_agent_schedule_requests` (
  `request_id` varchar(36) NOT NULL PRIMARY KEY, `recommendation_id` varchar(36) NOT NULL,
  `project_id` varchar(36) NOT NULL, `stage` varchar(16) NOT NULL,
  `previous_date` varchar(10) NOT NULL, `requested_date` varchar(10) NOT NULL, `timeline_hash` varchar(64) NOT NULL,
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY `uq_agent_schedule_recommendation` (`recommendation_id`), KEY `idx_agent_schedule_project` (`project_id`,`created_at`),
  FOREIGN KEY (`request_id`) REFERENCES `sbl_oa_approval_requests` (`id`) ON DELETE RESTRICT,
  FOREIGN KEY (`recommendation_id`) REFERENCES `sbl_project_agent_recommendations` (`id`) ON DELETE RESTRICT,
  FOREIGN KEY (`project_id`) REFERENCES `sbl_projects` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `chk_agent_schedule_dates` CHECK (`previous_date`<>`requested_date`)
);
--> statement-breakpoint
CREATE TABLE `sbl_project_stage_dates` (
  `id` varchar(36) NOT NULL PRIMARY KEY, `project_id` varchar(36) NOT NULL, `stage` varchar(16) NOT NULL,
  `planned_date` varchar(10) NOT NULL, `approval_id` varchar(36) NOT NULL, `version` int NOT NULL DEFAULT 1,
  `updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), UNIQUE KEY `uq_project_stage_date` (`project_id`,`stage`),
  FOREIGN KEY (`project_id`) REFERENCES `sbl_projects` (`id`) ON DELETE RESTRICT,
  FOREIGN KEY (`approval_id`) REFERENCES `sbl_oa_approval_requests` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `chk_project_stage_date_version` CHECK (`version`>0)
);
