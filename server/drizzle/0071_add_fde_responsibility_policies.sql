CREATE TABLE `sbl_responsibility_policies` (
  `code` varchar(32) NOT NULL PRIMARY KEY,
  `active_version_id` varchar(36) NULL,
  `enabled` boolean NOT NULL DEFAULT false,
  `next_revision` int NOT NULL DEFAULT 1,
  `version` int NOT NULL DEFAULT 1
);
--> statement-breakpoint
CREATE TABLE `sbl_responsibility_policy_versions` (
  `id` varchar(36) NOT NULL PRIMARY KEY,
  `policy_code` varchar(32) NOT NULL,
  `revision` int NOT NULL,
  `status` varchar(16) NOT NULL DEFAULT 'draft',
  `configuration` json NOT NULL,
  `sha256` varchar(64) NOT NULL,
  `reason` text NOT NULL,
  `created_by` varchar(36) NOT NULL,
  `last_edited_by` varchar(36) NOT NULL,
  `approved_by` varchar(36) NULL,
  `approved_at` datetime(3) NULL,
  `published_by` varchar(36) NULL,
  `published_at` datetime(3) NULL,
  `version` int NOT NULL DEFAULT 1,
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY `uq_resp_policy_revision` (`policy_code`,`revision`),
  FOREIGN KEY (`policy_code`) REFERENCES `sbl_responsibility_policies` (`code`) ON DELETE RESTRICT,
  FOREIGN KEY (`created_by`) REFERENCES `sbl_users` (`id`) ON DELETE RESTRICT,
  FOREIGN KEY (`last_edited_by`) REFERENCES `sbl_users` (`id`) ON DELETE RESTRICT,
  FOREIGN KEY (`approved_by`) REFERENCES `sbl_users` (`id`) ON DELETE RESTRICT,
  FOREIGN KEY (`published_by`) REFERENCES `sbl_users` (`id`) ON DELETE RESTRICT
);
--> statement-breakpoint
CREATE TABLE `sbl_responsibility_policy_commands` (
  `id` varchar(36) NOT NULL PRIMARY KEY,
  `actor_id` varchar(36) NOT NULL,
  `command_id` varchar(36) NOT NULL,
  `command_hash` varchar(64) NULL,
  `receipt` json NULL,
  `closed_at` datetime(3) NULL,
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY `uq_resp_policy_command` (`actor_id`,`command_id`),
  FOREIGN KEY (`actor_id`) REFERENCES `sbl_users` (`id`) ON DELETE RESTRICT
);
--> statement-breakpoint
CREATE TABLE `sbl_responsibility_policy_events` (
  `id` varchar(36) NOT NULL PRIMARY KEY,
  `policy_code` varchar(32) NOT NULL,
  `version_id` varchar(36) NULL,
  `actor_id` varchar(36) NOT NULL,
  `command_id` varchar(36) NOT NULL,
  `action` varchar(16) NOT NULL,
  `reason` text NOT NULL,
  `snapshot` json NOT NULL,
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY `uq_resp_policy_event_command` (`actor_id`,`command_id`),
  KEY `idx_resp_policy_event_time` (`policy_code`,`created_at`,`id`),
  FOREIGN KEY (`policy_code`) REFERENCES `sbl_responsibility_policies` (`code`) ON DELETE RESTRICT,
  FOREIGN KEY (`version_id`) REFERENCES `sbl_responsibility_policy_versions` (`id`) ON DELETE RESTRICT,
  FOREIGN KEY (`actor_id`) REFERENCES `sbl_users` (`id`) ON DELETE RESTRICT
);
