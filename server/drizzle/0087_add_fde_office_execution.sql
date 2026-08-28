CREATE TABLE `sbl_oa_office_executions` (
  `id` varchar(36) NOT NULL PRIMARY KEY,
  `request_id` varchar(36) NOT NULL,
  `request_version` int NOT NULL,
  `office_revision` int NOT NULL,
  `policy_version_id` varchar(36) NOT NULL,
  `action` varchar(16) NOT NULL,
  `outcome` varchar(16) NOT NULL,
  `supersedes_id` varchar(36) NULL,
  `actor_id` varchar(36) NOT NULL,
  `actor_name` varchar(64) NOT NULL,
  `occurred_at` datetime(3) NOT NULL,
  `recorded_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `facts` json NOT NULL,
  `reason` text NOT NULL,
  UNIQUE KEY `uq_office_execution_version` (`request_id`,`request_version`),
  UNIQUE KEY `uq_office_execution_predecessor` (`supersedes_id`),
  FOREIGN KEY (`request_id`) REFERENCES `sbl_oa_approval_requests` (`id`) ON DELETE RESTRICT,
  FOREIGN KEY (`policy_version_id`) REFERENCES `sbl_oa_office_policy_versions` (`id`) ON DELETE RESTRICT,
  FOREIGN KEY (`actor_id`) REFERENCES `sbl_users` (`id`) ON DELETE RESTRICT,
  FOREIGN KEY (`supersedes_id`) REFERENCES `sbl_oa_office_executions` (`id`) ON DELETE RESTRICT
);
--> statement-breakpoint
CREATE TABLE `sbl_oa_office_execution_files` (
  `id` varchar(36) NOT NULL PRIMARY KEY,
  `execution_id` varchar(36) NOT NULL,
  `file_id` varchar(36) NOT NULL,
  `version` int NOT NULL DEFAULT 1,
  `sha256` varchar(64) NOT NULL,
  `name` varchar(255) NOT NULL,
  UNIQUE KEY `uq_office_execution_file` (`execution_id`,`file_id`),
  FOREIGN KEY (`execution_id`) REFERENCES `sbl_oa_office_executions` (`id`) ON DELETE RESTRICT,
  FOREIGN KEY (`file_id`) REFERENCES `sbl_oa_office_attachments` (`id`) ON DELETE RESTRICT
);
