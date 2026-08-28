ALTER TABLE `sbl_meetings`
  DROP CHECK `sbl_meeting_workflow_state_ck`,
  ADD CONSTRAINT `sbl_meeting_workflow_state_ck` CHECK ((`workflow_kind`='legacy' AND `workflow_status`='recorded') OR (`workflow_kind` IN ('friday','committee') AND `workflow_status` IN ('draft','scheduled','completed','cancelled')));
--> statement-breakpoint
CREATE TABLE `sbl_committee_meetings` (
  `meeting_id` varchar(36) NOT NULL PRIMARY KEY,
  `sequence_year` int NULL, `sequence_number` int NULL, `rule_note` text NOT NULL,
  `material_check_at` datetime(3) NULL, `checked_at` datetime(3) NULL, `checked_by` varchar(36) NULL,
  `check_hash` varchar(64) NULL, `archived_at` datetime(3) NULL,
  UNIQUE KEY `uq_committee_annual_number` (`sequence_year`,`sequence_number`),
  CONSTRAINT `fk_committee_meeting` FOREIGN KEY (`meeting_id`) REFERENCES `sbl_meetings` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_committee_checker` FOREIGN KEY (`checked_by`) REFERENCES `sbl_users` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `ck_committee_sequence` CHECK ((`sequence_year` IS NULL AND `sequence_number` IS NULL) OR (`sequence_year` IS NOT NULL AND `sequence_number` IS NOT NULL AND `sequence_year` BETWEEN 1900 AND 9999 AND `sequence_number` > 0)),
  CONSTRAINT `ck_committee_check` CHECK ((`checked_at` IS NULL AND `checked_by` IS NULL AND `check_hash` IS NULL) OR (`checked_at` IS NOT NULL AND `checked_by` IS NOT NULL AND `check_hash` IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE `sbl_committee_years` (
  `year` int NOT NULL PRIMARY KEY, `next_sequence` int NOT NULL DEFAULT 1,
  CONSTRAINT `ck_committee_year` CHECK (`year` BETWEEN 1900 AND 9999 AND `next_sequence` > 0)
);
--> statement-breakpoint
CREATE TABLE `sbl_committee_agendas` (
  `id` varchar(36) NOT NULL PRIMARY KEY, `meeting_id` varchar(36) NOT NULL, `project_id` varchar(36) NOT NULL,
  `position` int NOT NULL, `title` varchar(255) NOT NULL, `participant_ids` json NOT NULL,
  `active` boolean NOT NULL DEFAULT true, `minutes` text NULL, `resolution_note` text NULL,
  `approval_id` varchar(36) NULL, `recorded_by` varchar(36) NULL, `recorded_at` datetime(3) NULL,
  KEY `idx_committee_agenda_meeting` (`meeting_id`,`active`,`position`), KEY `idx_committee_agenda_project` (`project_id`,`meeting_id`),
  CONSTRAINT `fk_committee_agenda_meeting` FOREIGN KEY (`meeting_id`) REFERENCES `sbl_meetings` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_committee_agenda_project` FOREIGN KEY (`project_id`) REFERENCES `sbl_projects` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_committee_agenda_approval` FOREIGN KEY (`approval_id`) REFERENCES `sbl_oa_approval_requests` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_committee_recorder` FOREIGN KEY (`recorded_by`) REFERENCES `sbl_users` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `ck_committee_recorded` CHECK ((`recorded_by` IS NULL AND `recorded_at` IS NULL) OR (`recorded_by` IS NOT NULL AND `recorded_at` IS NOT NULL AND `minutes` IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE `sbl_committee_files` (
  `id` varchar(36) NOT NULL PRIMARY KEY, `agenda_id` varchar(36) NOT NULL, `file_id` varchar(36) NOT NULL,
  `file_version_id` varchar(36) NOT NULL, `version` int NOT NULL, `sha256` varchar(64) NOT NULL,
  `kind` varchar(16) NOT NULL, `active` boolean NOT NULL DEFAULT true,
  UNIQUE KEY `uq_committee_file_reference` (`agenda_id`,`file_version_id`,`kind`), KEY `idx_committee_file` (`file_id`),
  CONSTRAINT `fk_committee_file_agenda` FOREIGN KEY (`agenda_id`) REFERENCES `sbl_committee_agendas` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_committee_file` FOREIGN KEY (`file_id`) REFERENCES `sbl_project_files` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_committee_file_version` FOREIGN KEY (`file_version_id`) REFERENCES `sbl_project_file_versions` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `ck_committee_file_kind` CHECK (`kind` IN ('material','minutes','resolution','approval') AND `version`>0)
);
--> statement-breakpoint
CREATE TABLE `sbl_committee_commands` (
  `id` varchar(36) NOT NULL PRIMARY KEY, `actor_id` varchar(36) NOT NULL, `command_id` varchar(36) NOT NULL,
  `command_hash` varchar(64) NULL, `receipt` json NULL, `closed_at` datetime(3) NULL,
  UNIQUE KEY `uq_committee_actor_command` (`actor_id`,`command_id`),
  CONSTRAINT `fk_committee_command_actor` FOREIGN KEY (`actor_id`) REFERENCES `sbl_users` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `ck_committee_command` CHECK (`closed_at` IS NULL OR (`command_hash` IS NULL AND `receipt` IS NULL))
);
