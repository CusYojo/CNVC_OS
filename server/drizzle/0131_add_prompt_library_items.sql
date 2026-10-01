-- Standalone Markdown prompt catalog. No capability runtime bindings are created.
CREATE TABLE `sbl_prompt_library_items` (
  `id` varchar(36) NOT NULL,
  `kind` varchar(16) NOT NULL,
  `name` varchar(128) NOT NULL,
  `description` text NOT NULL,
  `markdown` longtext NOT NULL,
  `file_name` varchar(128) NULL,
  `source_url` varchar(2048) NULL,
  `license` varchar(128) NULL,
  `owner_user_id` varchar(36) NOT NULL,
  `visibility` varchar(16) NOT NULL DEFAULT 'private',
  `version` int NOT NULL DEFAULT 1,
  `deleted_at` datetime(3) NULL,
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  KEY `idx_prompt_library_catalog` (`kind`, `visibility`, `deleted_at`, `updated_at`),
  KEY `idx_prompt_library_owner` (`owner_user_id`, `deleted_at`, `updated_at`),
  CONSTRAINT `fk_prompt_library_owner` FOREIGN KEY (`owner_user_id`) REFERENCES `sbl_users` (`id`) ON DELETE CASCADE,
  CONSTRAINT `ck_prompt_library_kind` CHECK (`kind` IN ('skill', 'agent')),
  CONSTRAINT `ck_prompt_library_visibility` CHECK (`visibility` IN ('private', 'organization'))
);
