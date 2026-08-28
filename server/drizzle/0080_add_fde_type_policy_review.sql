CREATE TABLE `sbl_fde_type_policy_reviews` (
  `version_id` varchar(36) NOT NULL PRIMARY KEY,
  `approved_by` varchar(36), `approved_at` datetime(3), `approved_hash` varchar(64),
  CONSTRAINT `fk_type_policy_review_version` FOREIGN KEY (`version_id`) REFERENCES `sbl_fde_workflow_policy_versions` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_type_policy_reviewer` FOREIGN KEY (`approved_by`) REFERENCES `sbl_users` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `ck_type_policy_review_complete` CHECK ((`approved_by` IS NULL AND `approved_at` IS NULL AND `approved_hash` IS NULL) OR (`approved_by` IS NOT NULL AND `approved_at` IS NOT NULL AND `approved_hash` IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE `sbl_fde_type_policy_commands` (
  `id` varchar(36) NOT NULL PRIMARY KEY, `actor_id` varchar(36) NOT NULL,
  `command_id` varchar(36) NOT NULL, `command_hash` varchar(64), `receipt` json, `closed_at` datetime(3),
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT `fk_type_policy_command_actor` FOREIGN KEY (`actor_id`) REFERENCES `sbl_users` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `ck_type_policy_command_complete` CHECK ((`closed_at` IS NULL AND `command_hash` IS NOT NULL AND `receipt` IS NOT NULL) OR (`closed_at` IS NOT NULL AND `command_hash` IS NULL AND `receipt` IS NULL)),
  UNIQUE KEY `uq_type_policy_command` (`actor_id`,`command_id`)
);
--> statement-breakpoint
CREATE TABLE `sbl_fde_type_policy_events` (
  `id` varchar(36) NOT NULL PRIMARY KEY, `policy_id` varchar(36) NOT NULL, `version_id` varchar(36) NOT NULL,
  `actor_id` varchar(36) NOT NULL, `command_id` varchar(36) NOT NULL, `action` varchar(16) NOT NULL,
  `reason` text NOT NULL, `snapshot` json NOT NULL, `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT `fk_type_policy_event_policy` FOREIGN KEY (`policy_id`) REFERENCES `sbl_fde_workflow_policies` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_type_policy_event_version` FOREIGN KEY (`version_id`) REFERENCES `sbl_fde_workflow_policy_versions` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_type_policy_event_actor` FOREIGN KEY (`actor_id`) REFERENCES `sbl_users` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `ck_type_policy_event_action` CHECK (`action` IN ('create','save','approve','publish')),
  UNIQUE KEY `uq_type_policy_event_command` (`actor_id`,`command_id`),
  KEY `idx_type_policy_history` (`policy_id`,`created_at`)
);
