CREATE TABLE `sbl_project_replan_policies` (
  `project_id` varchar(36) NOT NULL PRIMARY KEY,
  `version` int NOT NULL, `enabled` boolean NOT NULL DEFAULT false,
  `configuration` json NOT NULL, `configuration_hash` varchar(64) NOT NULL,
  `approval_evidence` text NOT NULL, `created_by` varchar(36) NOT NULL, `approved_by` varchar(36),
  `updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  FOREIGN KEY (`project_id`) REFERENCES `sbl_projects` (`id`) ON DELETE RESTRICT,
  FOREIGN KEY (`created_by`) REFERENCES `sbl_users` (`id`) ON DELETE RESTRICT,
  FOREIGN KEY (`approved_by`) REFERENCES `sbl_users` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `chk_replan_policy_version` CHECK (`version` > 0),
  CONSTRAINT `chk_replan_policy_independent` CHECK (`enabled` = false OR (`approved_by` IS NOT NULL AND `approved_by` <> `created_by`))
);
--> statement-breakpoint
CREATE TABLE `sbl_project_replan_requests` (
  `request_id` varchar(36) NOT NULL PRIMARY KEY, `project_id` varchar(36) NOT NULL,
  `revision` int NOT NULL, `policy_version` int NOT NULL,
  `fingerprint` varchar(64) NOT NULL, `impact` json NOT NULL,
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY `uq_project_replan_revision` (`project_id`, `revision`),
  FOREIGN KEY (`request_id`) REFERENCES `sbl_oa_approval_requests` (`id`) ON DELETE RESTRICT,
  FOREIGN KEY (`project_id`) REFERENCES `sbl_projects` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `chk_replan_request_revision` CHECK (`revision` > 0 AND `policy_version` > 0)
);
