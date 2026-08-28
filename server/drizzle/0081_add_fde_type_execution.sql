ALTER TABLE `sbl_project_plan_actions` MODIFY `deliverable` text NOT NULL;
--> statement-breakpoint
ALTER TABLE `sbl_project_plans`
  ADD COLUMN `execution_kind` varchar(16) NOT NULL DEFAULT 'investment',
  DROP CHECK `ck_fde_plan_cycle`,
  ADD CONSTRAINT `ck_fde_plan_cycle` CHECK ((`execution_kind`='investment' AND `cycle_days` IN (15,30,40)) OR (`execution_kind`='noninvestment' AND `cycle_days` IN (15,30,40,50)));
--> statement-breakpoint
CREATE TABLE `sbl_fde_type_instances` (
  `project_id` varchar(36) NOT NULL PRIMARY KEY, `policy_version_id` varchar(36) NOT NULL, `plan_id` varchar(36),
  `plan` json NOT NULL, `plan_hash` varchar(64) NOT NULL, `stage_key` varchar(48) NOT NULL, `status` varchar(24) NOT NULL,
  `version` int NOT NULL DEFAULT 1, `created_by` varchar(36) NOT NULL,
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), `updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT `fk_type_instance_project` FOREIGN KEY (`project_id`) REFERENCES `sbl_projects` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_type_instance_policy` FOREIGN KEY (`policy_version_id`) REFERENCES `sbl_fde_workflow_policy_versions` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_type_instance_plan` FOREIGN KEY (`plan_id`) REFERENCES `sbl_project_plans` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_type_instance_author` FOREIGN KEY (`created_by`) REFERENCES `sbl_users` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `ck_type_instance_status` CHECK (`status` IN ('draft','plan_review','active','stage_review','closed')),
  CONSTRAINT `ck_type_instance_version` CHECK (`version` > 0)
);
--> statement-breakpoint
CREATE TABLE `sbl_fde_type_execution_reviews` (
  `id` varchar(36) NOT NULL PRIMARY KEY, `project_id` varchar(36) NOT NULL, `kind` varchar(16) NOT NULL, `active_key` varchar(36),
  `snapshot` json NOT NULL, `plan_snapshot` json NOT NULL, `status` varchar(16) NOT NULL, `version` int NOT NULL DEFAULT 1,
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), `updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT `fk_type_execution_review_project` FOREIGN KEY (`project_id`) REFERENCES `sbl_fde_type_instances` (`project_id`) ON DELETE RESTRICT,
  CONSTRAINT `ck_type_execution_review_kind` CHECK (`kind` IN ('plan','stage')),
  CONSTRAINT `ck_type_execution_review_status` CHECK (`status` IN ('reviewing','returned','approved','withdrawn')),
  CONSTRAINT `ck_type_execution_review_active` CHECK ((`status`='reviewing' AND `active_key` IS NOT NULL AND `active_key`=`project_id`) OR (`status`<>'reviewing' AND `active_key` IS NULL)),
  UNIQUE KEY `uq_type_execution_active` (`active_key`), KEY `idx_type_execution_history` (`project_id`,`created_at`,`id`)
);
--> statement-breakpoint
CREATE TABLE `sbl_fde_type_execution_files` (
  `id` varchar(36) NOT NULL PRIMARY KEY, `review_id` varchar(36) NOT NULL, `file_id` varchar(36) NOT NULL, `file_version_id` varchar(36) NOT NULL,
  CONSTRAINT `fk_type_execution_file_review` FOREIGN KEY (`review_id`) REFERENCES `sbl_fde_type_execution_reviews` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_type_execution_file` FOREIGN KEY (`file_id`) REFERENCES `sbl_project_files` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_type_execution_file_version` FOREIGN KEY (`file_version_id`) REFERENCES `sbl_project_file_versions` (`id`) ON DELETE RESTRICT,
  UNIQUE KEY `uq_type_execution_file` (`review_id`,`file_version_id`), KEY `idx_type_execution_file` (`file_id`)
);
--> statement-breakpoint
CREATE TABLE `sbl_fde_type_execution_commands` (
  `id` varchar(36) NOT NULL PRIMARY KEY, `project_id` varchar(36) NOT NULL, `actor_id` varchar(36) NOT NULL, `command_id` varchar(36) NOT NULL,
  `command_hash` varchar(64), `receipt` json, `closed_at` datetime(3), `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT `fk_type_execution_command_project` FOREIGN KEY (`project_id`) REFERENCES `sbl_projects` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_type_execution_command_actor` FOREIGN KEY (`actor_id`) REFERENCES `sbl_users` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `ck_type_execution_command_complete` CHECK ((`closed_at` IS NULL AND `command_hash` IS NOT NULL AND `receipt` IS NOT NULL) OR (`closed_at` IS NOT NULL AND `command_hash` IS NULL AND `receipt` IS NULL)),
  UNIQUE KEY `uq_type_execution_command` (`project_id`,`actor_id`,`command_id`)
);
--> statement-breakpoint
CREATE TABLE `sbl_fde_type_execution_events` (
  `id` varchar(36) NOT NULL PRIMARY KEY, `project_id` varchar(36) NOT NULL, `actor_id` varchar(36) NOT NULL, `command_id` varchar(36) NOT NULL,
  `action` varchar(24) NOT NULL, `version` int NOT NULL, `reason` text NOT NULL, `snapshot` json NOT NULL,
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT `fk_type_execution_event_project` FOREIGN KEY (`project_id`) REFERENCES `sbl_fde_type_instances` (`project_id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_type_execution_event_actor` FOREIGN KEY (`actor_id`) REFERENCES `sbl_users` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `ck_type_execution_event_action` CHECK (`action` IN ('save_plan','submit_plan','submit_stage','decide')),
  UNIQUE KEY `uq_type_execution_event` (`project_id`,`version`)
);
