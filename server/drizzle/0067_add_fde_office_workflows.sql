CREATE TABLE `sbl_oa_office_policies` (
 `id` varchar(36) NOT NULL PRIMARY KEY, `kind` varchar(16) NOT NULL, `enabled` boolean NOT NULL DEFAULT false,
 `active_version_id` varchar(36), `next_revision` int NOT NULL DEFAULT 1, `version` int NOT NULL DEFAULT 1,
 UNIQUE KEY `uq_office_policy_kind` (`kind`)
);
--> statement-breakpoint
CREATE TABLE `sbl_oa_office_policy_versions` (
 `id` varchar(36) NOT NULL PRIMARY KEY, `policy_id` varchar(36) NOT NULL, `revision` int NOT NULL,
 `status` varchar(16) NOT NULL DEFAULT 'draft', `configuration` json NOT NULL, `sha256` varchar(64) NOT NULL,
 `version` int NOT NULL DEFAULT 1, `reason` text NOT NULL, `created_by` varchar(36) NOT NULL, `published_by` varchar(36),
 `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), `published_at` datetime(3),
 UNIQUE KEY `uq_office_policy_revision` (`policy_id`,`revision`),
 FOREIGN KEY (`policy_id`) REFERENCES `sbl_oa_office_policies` (`id`) ON DELETE RESTRICT,
 FOREIGN KEY (`created_by`) REFERENCES `sbl_users` (`id`) ON DELETE RESTRICT,
 FOREIGN KEY (`published_by`) REFERENCES `sbl_users` (`id`) ON DELETE RESTRICT
);
--> statement-breakpoint
ALTER TABLE `sbl_oa_approval_requests` MODIFY COLUMN `project_id` varchar(36) NULL,
 ADD COLUMN `office_policy_version_id` varchar(36) NULL,
 ADD COLUMN `office_revision` int NOT NULL DEFAULT 0,
 ADD CONSTRAINT `fk_office_request_policy` FOREIGN KEY (`office_policy_version_id`) REFERENCES `sbl_oa_office_policy_versions` (`id`) ON DELETE RESTRICT,
 ADD CONSTRAINT `chk_oa_project_ownership` CHECK (`business_type` = 'office' OR `project_id` IS NOT NULL),
 ADD CONSTRAINT `chk_office_no_stage_mutation` CHECK (`business_type` <> 'office' OR (`from_stage` = '' AND `target_stage` = '' AND `active_key` IS NULL AND `task_id` IS NULL));
--> statement-breakpoint
ALTER TABLE `sbl_oa_approval_nodes` ADD COLUMN `office_revision` int NULL, ADD COLUMN `office_rule` json NOT NULL DEFAULT (JSON_OBJECT());
--> statement-breakpoint
CREATE TABLE `sbl_oa_office_events` (
 `id` varchar(36) NOT NULL PRIMARY KEY, `request_id` varchar(36) NOT NULL, `command_id` varchar(36) NOT NULL,
 `command_hash` varchar(64) NOT NULL, `version` int NOT NULL, `actor_id` varchar(36) NOT NULL, `action` varchar(32) NOT NULL,
 `reason` text NOT NULL, `snapshot` json NOT NULL, `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
 UNIQUE KEY `uq_office_command` (`command_id`), UNIQUE KEY `uq_office_event_version` (`request_id`,`version`),
 FOREIGN KEY (`request_id`) REFERENCES `sbl_oa_approval_requests` (`id`) ON DELETE RESTRICT,
 FOREIGN KEY (`actor_id`) REFERENCES `sbl_users` (`id`) ON DELETE RESTRICT
);
--> statement-breakpoint
CREATE TABLE `sbl_oa_office_attachments` (
 `id` varchar(36) NOT NULL PRIMARY KEY, `request_id` varchar(36) NOT NULL, `name` varchar(255) NOT NULL,
 `mime` varchar(128) NOT NULL, `byte_size` bigint NOT NULL, `sha256` varchar(64) NOT NULL, `storage_path` text NOT NULL,
 `purpose` varchar(16) NOT NULL DEFAULT 'application', `uploaded_by` varchar(36) NOT NULL,
 `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), KEY `idx_office_attachment_request` (`request_id`),
 FOREIGN KEY (`request_id`) REFERENCES `sbl_oa_approval_requests` (`id`) ON DELETE RESTRICT,
 FOREIGN KEY (`uploaded_by`) REFERENCES `sbl_users` (`id`) ON DELETE RESTRICT,
 CONSTRAINT `chk_office_attachment_size` CHECK (`byte_size` > 0)
);
--> statement-breakpoint
CREATE TABLE `sbl_oa_office_attachment_grants` (
 `id` varchar(36) NOT NULL PRIMARY KEY, `attachment_id` varchar(36) NOT NULL, `user_id` varchar(36) NOT NULL,
 `can_download` boolean NOT NULL DEFAULT false, UNIQUE KEY `uq_office_attachment_grant` (`attachment_id`,`user_id`),
 FOREIGN KEY (`attachment_id`) REFERENCES `sbl_oa_office_attachments` (`id`) ON DELETE RESTRICT,
 FOREIGN KEY (`user_id`) REFERENCES `sbl_users` (`id`) ON DELETE RESTRICT
);
--> statement-breakpoint
CREATE TABLE `sbl_oa_office_notices` (
 `id` varchar(36) NOT NULL PRIMARY KEY, `request_id` varchar(36) NOT NULL, `recipient_id` varchar(36) NOT NULL,
 `node_id` varchar(36), `dedupe_key` varchar(200) NOT NULL, `status` varchar(16) NOT NULL DEFAULT 'pending',
 `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), `read_at` datetime(3), `closed_at` datetime(3),
 UNIQUE KEY `uq_office_notice_dedupe` (`dedupe_key`), KEY `idx_office_notice_recipient` (`recipient_id`,`status`),
 FOREIGN KEY (`request_id`) REFERENCES `sbl_oa_approval_requests` (`id`) ON DELETE RESTRICT,
 FOREIGN KEY (`recipient_id`) REFERENCES `sbl_users` (`id`) ON DELETE RESTRICT,
 FOREIGN KEY (`node_id`) REFERENCES `sbl_oa_approval_nodes` (`id`) ON DELETE RESTRICT
);
