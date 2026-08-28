CREATE TABLE `sbl_project_stage_materials` (
  `id` varchar(36) NOT NULL,
  `project_id` varchar(36) NOT NULL,
  `stage` varchar(32) NOT NULL,
  `requirement_key` varchar(64) NOT NULL,
  `file_id` varchar(36),
  `file_version` int,
  `waiver_reason` text,
  `updated_by` varchar(36) NOT NULL,
  `version` int NOT NULL DEFAULT 1,
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  CONSTRAINT `fk_fde_material_project` FOREIGN KEY (`project_id`) REFERENCES `sbl_projects` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_fde_material_file` FOREIGN KEY (`file_id`) REFERENCES `sbl_project_files` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_fde_material_actor` FOREIGN KEY (`updated_by`) REFERENCES `sbl_users` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `ck_fde_material_evidence` CHECK ((`file_id` IS NOT NULL AND `file_version` IS NOT NULL AND `waiver_reason` IS NULL) OR (`file_id` IS NULL AND `file_version` IS NULL AND `waiver_reason` IS NOT NULL AND CHAR_LENGTH(TRIM(`waiver_reason`)) >= 5)),
  UNIQUE KEY `uq_project_stage_material` (`project_id`,`stage`,`requirement_key`),
  KEY `idx_project_stage_material_file` (`file_id`)
);
--> statement-breakpoint
CREATE TABLE `sbl_project_plans` (
  `id` varchar(36) NOT NULL,
  `project_id` varchar(36) NOT NULL,
  `revision` int NOT NULL DEFAULT 1,
  `status` varchar(16) NOT NULL DEFAULT 'draft',
  `cycle_days` int NOT NULL,
  `target_date` varchar(10) NOT NULL,
  `created_by` varchar(36) NOT NULL,
  `locked_at` datetime(3),
  `version` int NOT NULL DEFAULT 1,
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  CONSTRAINT `fk_fde_plan_project` FOREIGN KEY (`project_id`) REFERENCES `sbl_projects` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_fde_plan_actor` FOREIGN KEY (`created_by`) REFERENCES `sbl_users` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `ck_fde_plan_cycle` CHECK (`cycle_days` IN (15,30,40)),
  CONSTRAINT `ck_fde_plan_status` CHECK (`status` IN ('draft','review','locked','archived')),
  UNIQUE KEY `uq_project_plan_revision` (`project_id`,`revision`)
);
--> statement-breakpoint
CREATE TABLE `sbl_project_plan_actions` (
  `id` varchar(36) NOT NULL,
  `plan_id` varchar(36) NOT NULL,
  `action_key` varchar(64) NOT NULL,
  `title` varchar(128) NOT NULL,
  `owner_user_id` varchar(36) NOT NULL,
  `due_date` varchar(10) NOT NULL,
  `deliverable` varchar(255) NOT NULL,
  `status` varchar(16) NOT NULL DEFAULT '未开始',
  `sort_order` int NOT NULL,
  `version` int NOT NULL DEFAULT 1,
  PRIMARY KEY (`id`),
  CONSTRAINT `fk_fde_action_plan` FOREIGN KEY (`plan_id`) REFERENCES `sbl_project_plans` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_fde_action_owner` FOREIGN KEY (`owner_user_id`) REFERENCES `sbl_users` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `ck_fde_action_status` CHECK (`status` IN ('未开始','进行中','已完成')),
  UNIQUE KEY `uq_project_plan_action` (`plan_id`,`action_key`),
  KEY `idx_project_plan_action_owner_date` (`owner_user_id`,`due_date`)
);
--> statement-breakpoint
ALTER TABLE `sbl_oa_approval_requests`
  ADD COLUMN `material_snapshot` json NOT NULL DEFAULT (JSON_ARRAY()),
  ADD COLUMN `plan_id` varchar(36),
  ADD CONSTRAINT `fk_oa_fde_plan` FOREIGN KEY (`plan_id`) REFERENCES `sbl_project_plans` (`id`) ON DELETE RESTRICT;
--> statement-breakpoint
CREATE TABLE `sbl_oa_approval_revisions` (
  `id` varchar(36) NOT NULL,
  `request_id` varchar(36) NOT NULL,
  `revision` int NOT NULL,
  `snapshot` json NOT NULL,
  `submitted_by` varchar(36) NOT NULL,
  `submitted_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  CONSTRAINT `fk_oa_revision_request` FOREIGN KEY (`request_id`) REFERENCES `sbl_oa_approval_requests` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_oa_revision_actor` FOREIGN KEY (`submitted_by`) REFERENCES `sbl_users` (`id`) ON DELETE RESTRICT,
  UNIQUE KEY `uq_oa_approval_revision` (`request_id`,`revision`)
);
