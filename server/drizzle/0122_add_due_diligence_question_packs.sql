CREATE TABLE `sbl_due_diligence_question_packs` (
  `id` varchar(36) NOT NULL,
  `project_id` varchar(36) NOT NULL,
  `created_by` varchar(36) NOT NULL,
  `title` varchar(255) NOT NULL,
  `source_file_ids` json NOT NULL,
  `questions` json NOT NULL,
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  KEY `idx_dd_question_packs_project` (`project_id`,`created_at`),
  CONSTRAINT `sbl_dd_question_packs_project_fk` FOREIGN KEY (`project_id`) REFERENCES `sbl_projects` (`id`) ON DELETE CASCADE,
  CONSTRAINT `sbl_dd_question_packs_creator_fk` FOREIGN KEY (`created_by`) REFERENCES `sbl_users` (`id`) ON DELETE RESTRICT
);
