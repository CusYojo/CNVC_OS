CREATE TABLE `sbl_project_agent_configs` (
  `project_id` varchar(36) NOT NULL PRIMARY KEY, `configuration` json NOT NULL, `version` int NOT NULL,
  `updated_by` varchar(36) NOT NULL, `updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  FOREIGN KEY (`project_id`) REFERENCES `sbl_projects` (`id`) ON DELETE RESTRICT,
  FOREIGN KEY (`updated_by`) REFERENCES `sbl_users` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `chk_agent_config_version` CHECK (`version`>0)
);
--> statement-breakpoint
CREATE TABLE `sbl_project_agent_runs` (
  `id` varchar(36) NOT NULL PRIMARY KEY, `project_id` varchar(36) NOT NULL, `actor_id` varchar(36) NOT NULL,
  `configuration` json NOT NULL, `config_version` int NOT NULL, `input_hash` varchar(64) NOT NULL, `facts` json NOT NULL,
  `status` varchar(16) NOT NULL, `provider` varchar(16) NOT NULL DEFAULT 'rules', `fallback_reason` varchar(64) NULL,
  `started_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), `completed_at` datetime(3) NULL,
  KEY `idx_project_agent_run` (`project_id`,`started_at`,`id`),
  FOREIGN KEY (`project_id`) REFERENCES `sbl_projects` (`id`) ON DELETE RESTRICT,
  FOREIGN KEY (`actor_id`) REFERENCES `sbl_users` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `chk_agent_run_status` CHECK (`status` IN ('running','succeeded','stale','failed')),
  CONSTRAINT `chk_agent_run_provider` CHECK (`provider` IN ('rules','model')),
  CONSTRAINT `chk_agent_run_completion` CHECK ((`status`='running' AND `completed_at` IS NULL) OR (`status`<>'running' AND `completed_at` IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE `sbl_project_agent_recommendations` (
  `id` varchar(36) NOT NULL PRIMARY KEY, `run_id` varchar(36) NOT NULL, `project_id` varchar(36) NOT NULL,
  `recommendation` json NOT NULL, `status` varchar(32) NOT NULL DEFAULT 'open', `version` int NOT NULL DEFAULT 1,
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), UNIQUE KEY `uq_project_agent_recommendation_run` (`run_id`),
  FOREIGN KEY (`run_id`) REFERENCES `sbl_project_agent_runs` (`id`) ON DELETE RESTRICT,
  FOREIGN KEY (`project_id`) REFERENCES `sbl_projects` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `chk_agent_recommendation_status` CHECK (`status` IN ('open','accepted','accepted_with_changes','rejected','dismissed')),
  CONSTRAINT `chk_agent_recommendation_version` CHECK (`version`>0)
);
--> statement-breakpoint
CREATE TABLE `sbl_project_agent_decisions` (
  `id` varchar(36) NOT NULL PRIMARY KEY, `recommendation_id` varchar(36) NOT NULL, `actor_id` varchar(36) NOT NULL,
  `decision` varchar(32) NOT NULL, `note` text NOT NULL, `schedule_draft` json NULL, `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY `uq_project_agent_decision` (`recommendation_id`),
  FOREIGN KEY (`recommendation_id`) REFERENCES `sbl_project_agent_recommendations` (`id`) ON DELETE RESTRICT,
  FOREIGN KEY (`actor_id`) REFERENCES `sbl_users` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `chk_agent_decision_status` CHECK (`decision` IN ('accepted','accepted_with_changes','rejected','dismissed'))
);
--> statement-breakpoint
CREATE TABLE `sbl_project_agent_commands` (
  `id` varchar(36) NOT NULL PRIMARY KEY, `actor_id` varchar(36) NOT NULL, `project_id` varchar(36) NOT NULL,
  `request_id` varchar(36) NOT NULL, `request_hash` varchar(64) NULL, `receipt` json NULL, `closed_at` datetime(3) NULL,
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), UNIQUE KEY `uq_project_agent_command` (`actor_id`,`request_id`),
  FOREIGN KEY (`actor_id`) REFERENCES `sbl_users` (`id`) ON DELETE RESTRICT,
  FOREIGN KEY (`project_id`) REFERENCES `sbl_projects` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `chk_agent_command_receipt` CHECK ((`closed_at` IS NOT NULL AND `receipt` IS NULL AND `request_hash` IS NULL) OR (`closed_at` IS NULL AND `receipt` IS NOT NULL AND `request_hash` IS NOT NULL))
);
