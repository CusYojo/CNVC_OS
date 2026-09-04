CREATE TABLE `sbl_personal_notes` (
  `id` varchar(36) NOT NULL PRIMARY KEY,
  `owner_id` varchar(36) NOT NULL,
  `title` varchar(120) NOT NULL,
  `note_date` date NOT NULL,
  `content` json NOT NULL,
  `plain_text` text NOT NULL,
  `version` int NOT NULL DEFAULT 1,
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT `fk_personal_notes_owner` FOREIGN KEY (`owner_id`) REFERENCES `sbl_users` (`id`) ON DELETE RESTRICT,
  INDEX `idx_personal_notes_owner_date` (`owner_id`, `note_date`, `updated_at`)
);
