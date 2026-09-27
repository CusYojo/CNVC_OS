ALTER TABLE `sbl_due_diligence_question_packs` ADD COLUMN `template_version` varchar(32) NOT NULL DEFAULT '2026.1' AFTER `title`;
--> statement-breakpoint
ALTER TABLE `sbl_due_diligence_question_packs` ADD COLUMN `generation_mode` varchar(16) NOT NULL DEFAULT 'baseline' AFTER `template_version`;
--> statement-breakpoint
ALTER TABLE `sbl_due_diligence_question_packs` ADD COLUMN `model_status` varchar(24) NOT NULL DEFAULT '未调用' AFTER `generation_mode`;
--> statement-breakpoint
ALTER TABLE `sbl_due_diligence_question_packs` ADD COLUMN `warning` text NULL AFTER `model_status`;
--> statement-breakpoint
ALTER TABLE `sbl_digital_twin_learning_candidates` ADD COLUMN `engine` varchar(16) NOT NULL DEFAULT 'rules' AFTER `confidence`;
--> statement-breakpoint
ALTER TABLE `sbl_digital_twin_learning_candidates` ADD COLUMN `evidence_count` int NOT NULL DEFAULT 1 AFTER `engine`;
--> statement-breakpoint
CREATE TABLE `sbl_digital_twin_experience_events` (
  `id` char(36) NOT NULL,
  `owner_user_id` char(36) NOT NULL,
  `twin_id` char(36),
  `project_id` char(36),
  `event_type` varchar(48) NOT NULL,
  `entity_type` varchar(32) NOT NULL,
  `entity_id` char(36),
  `topic` varchar(128) NOT NULL DEFAULT '尽调判断',
  `source_hash` varchar(64) NOT NULL,
  `payload` json NOT NULL DEFAULT (JSON_OBJECT()),
  `model_status` varchar(16) NOT NULL DEFAULT '待处理',
  `model_attempts` int NOT NULL DEFAULT 0,
  `last_model_error` text NULL,
  `model_processed_at` datetime(3) NULL,
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_twin_experience_event_source` (`owner_user_id`,`source_hash`),
  KEY `idx_twin_experience_event_topic` (`owner_user_id`,`topic`,`created_at`),
  CONSTRAINT `fk_twin_experience_event_owner` FOREIGN KEY (`owner_user_id`) REFERENCES `sbl_users` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_twin_experience_event_twin` FOREIGN KEY (`twin_id`) REFERENCES `sbl_digital_twins` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_twin_experience_event_project` FOREIGN KEY (`project_id`) REFERENCES `sbl_projects` (`id`) ON DELETE SET NULL
);
