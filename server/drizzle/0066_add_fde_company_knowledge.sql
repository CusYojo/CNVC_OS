CREATE TABLE `sbl_company_knowledge` (
  `id` varchar(36) NOT NULL PRIMARY KEY, `author_id` varchar(36) NOT NULL,
  `kind` varchar(24) NOT NULL, `title` varchar(120) NOT NULL, `summary` text NOT NULL, `link` text NOT NULL,
  `audience` varchar(16) NOT NULL DEFAULT 'selected', `status` varchar(16) NOT NULL DEFAULT 'draft',
  `file_id` varchar(36) NULL, `file_version_id` varchar(36) NULL, `version` int NOT NULL DEFAULT 1,
  `published_at` datetime(3) NULL, `archived_at` datetime(3) NULL,
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), `updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY `idx_company_knowledge_list` (`status`,`updated_at`), KEY `idx_company_knowledge_file` (`file_id`),
  FOREIGN KEY (`author_id`) REFERENCES `sbl_users` (`id`) ON DELETE RESTRICT,
  FOREIGN KEY (`file_id`) REFERENCES `sbl_project_files` (`id`) ON DELETE RESTRICT,
  FOREIGN KEY (`file_version_id`) REFERENCES `sbl_project_file_versions` (`id`) ON DELETE RESTRICT,
  CHECK (`status` IN ('draft','published','archived')), CHECK (`audience` IN ('selected','company')), CHECK (`version` > 0),
  CHECK ((`file_id` IS NULL AND `file_version_id` IS NULL) OR (`file_id` IS NOT NULL AND `file_version_id` IS NOT NULL)),
  CHECK ((`status`='draft' AND `published_at` IS NULL AND `archived_at` IS NULL) OR (`status`='published' AND `published_at` IS NOT NULL AND `archived_at` IS NULL) OR (`status`='archived' AND `archived_at` IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE `sbl_company_knowledge_grants` (
  `id` varchar(36) NOT NULL PRIMARY KEY, `entry_id` varchar(36) NOT NULL, `user_id` varchar(36) NOT NULL, `can_edit` boolean NOT NULL DEFAULT false,
  UNIQUE KEY `uq_company_knowledge_grant` (`entry_id`,`user_id`),
  FOREIGN KEY (`entry_id`) REFERENCES `sbl_company_knowledge` (`id`) ON DELETE RESTRICT,
  FOREIGN KEY (`user_id`) REFERENCES `sbl_users` (`id`) ON DELETE RESTRICT
);
--> statement-breakpoint
CREATE TABLE `sbl_company_knowledge_comments` (
  `id` varchar(36) NOT NULL PRIMARY KEY, `entry_id` varchar(36) NOT NULL, `author_id` varchar(36) NOT NULL, `content` text NOT NULL,
  `withdrawn_at` datetime(3) NULL, `withdrawal_reason` text NULL, `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY `idx_company_knowledge_comment` (`entry_id`,`created_at`),
  FOREIGN KEY (`entry_id`) REFERENCES `sbl_company_knowledge` (`id`) ON DELETE RESTRICT,
  FOREIGN KEY (`author_id`) REFERENCES `sbl_users` (`id`) ON DELETE RESTRICT,
  CHECK ((`withdrawn_at` IS NULL AND `withdrawal_reason` IS NULL) OR (`withdrawn_at` IS NOT NULL AND CHAR_LENGTH(`withdrawal_reason`)>=5 AND `withdrawal_reason` IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE `sbl_company_knowledge_ratings` (
  `id` varchar(36) NOT NULL PRIMARY KEY, `entry_id` varchar(36) NOT NULL, `user_id` varchar(36) NOT NULL, `score` int NULL, `updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY `uq_company_knowledge_rating` (`entry_id`,`user_id`),
  FOREIGN KEY (`entry_id`) REFERENCES `sbl_company_knowledge` (`id`) ON DELETE RESTRICT,
  FOREIGN KEY (`user_id`) REFERENCES `sbl_users` (`id`) ON DELETE RESTRICT,
  CHECK (`score` IS NULL OR `score` BETWEEN 2 AND 5)
);
--> statement-breakpoint
CREATE TABLE `sbl_company_knowledge_events` (
  `id` varchar(36) NOT NULL PRIMARY KEY, `entry_id` varchar(36) NOT NULL, `actor_id` varchar(36) NOT NULL,
  `request_id` varchar(36) NOT NULL, `request_hash` varchar(64) NOT NULL, `action` varchar(32) NOT NULL, `version` int NOT NULL, `reason` text NOT NULL, `snapshot` json NOT NULL,
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY `uq_company_knowledge_request` (`request_id`), UNIQUE KEY `uq_company_knowledge_event` (`entry_id`,`version`),
  FOREIGN KEY (`entry_id`) REFERENCES `sbl_company_knowledge` (`id`) ON DELETE RESTRICT,
  FOREIGN KEY (`actor_id`) REFERENCES `sbl_users` (`id`) ON DELETE RESTRICT
);
