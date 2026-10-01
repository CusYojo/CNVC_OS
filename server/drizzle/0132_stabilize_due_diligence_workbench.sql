ALTER TABLE `sbl_due_diligence_interviews` ADD COLUMN `summary_transcript_version` int NULL AFTER `summary`;
--> statement-breakpoint
ALTER TABLE `sbl_due_diligence_question_packs` ADD COLUMN `model_profile` varchar(48) NULL AFTER `model_status`;
--> statement-breakpoint
ALTER TABLE `sbl_due_diligence_question_packs` ADD COLUMN `model_name` varchar(255) NULL AFTER `model_profile`;
--> statement-breakpoint
ALTER TABLE `sbl_digital_twins` ADD COLUMN `client_request_id` char(36) NULL AFTER `cases`;
--> statement-breakpoint
ALTER TABLE `sbl_digital_twins` ADD COLUMN `learning_target_at` datetime(3) NULL AFTER `client_request_id`;
--> statement-breakpoint
ALTER TABLE `sbl_digital_twins` ADD UNIQUE KEY `uq_digital_twins_create_request` (`owner_user_id`,`client_request_id`);
--> statement-breakpoint
ALTER TABLE `sbl_digital_twin_invocation_logs` ADD COLUMN `model_profile` varchar(48) NULL AFTER `output_summary`;
--> statement-breakpoint
ALTER TABLE `sbl_digital_twin_invocation_logs` ADD COLUMN `model_name` varchar(255) NULL AFTER `model_profile`;
--> statement-breakpoint
ALTER TABLE `sbl_digital_twin_invocation_logs` ADD COLUMN `model_status` varchar(24) NOT NULL DEFAULT '未调用' AFTER `model_name`;
--> statement-breakpoint
ALTER TABLE `sbl_digital_twin_learning_candidates` MODIFY COLUMN `project_id` char(36) NULL;
--> statement-breakpoint
CREATE TABLE `sbl_due_diligence_transcription_jobs` (
  `id` char(36) NOT NULL,
  `interview_id` char(36) NOT NULL,
  `recording_file_id` char(36) NOT NULL,
  `status` varchar(24) NOT NULL DEFAULT '待处理',
  `provider` varchar(64) NULL,
  `browser_text` longtext NOT NULL,
  `provider_text` longtext NULL,
  `merged_text` longtext NULL,
  `source_transcript_version` int NULL,
  `attempts` int NOT NULL DEFAULT 0,
  `error_message` text NULL,
  `created_by` char(36) NULL,
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_dd_transcription_job_recording` (`interview_id`,`recording_file_id`),
  KEY `idx_dd_transcription_jobs_interview` (`interview_id`,`created_at`),
  CONSTRAINT `fk_dd_transcription_job_interview` FOREIGN KEY (`interview_id`) REFERENCES `sbl_due_diligence_interviews` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_dd_transcription_job_file` FOREIGN KEY (`recording_file_id`) REFERENCES `sbl_project_files` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_dd_transcription_job_creator` FOREIGN KEY (`created_by`) REFERENCES `sbl_users` (`id`) ON DELETE SET NULL
);
--> statement-breakpoint
CREATE TABLE `sbl_digital_twin_private_assets` (
  `id` char(36) NOT NULL,
  `twin_id` char(36) NOT NULL,
  `owner_user_id` char(36) NOT NULL,
  `source_type` varchar(32) NOT NULL,
  `source_name` varchar(255) NOT NULL,
  `mime_type` varchar(128) NULL,
  `source_file_id` char(36) NULL,
  `source_note_id` char(36) NULL,
  `storage_path` text NULL,
  `content_text` longtext NULL,
  `parse_status` varchar(24) NOT NULL DEFAULT '待解析',
  `trait_suggestion` longtext NULL,
  `parse_error` text NULL,
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  KEY `idx_digital_twin_private_assets_twin` (`twin_id`,`created_at`),
  CONSTRAINT `fk_digital_twin_private_asset_twin` FOREIGN KEY (`twin_id`) REFERENCES `sbl_digital_twins` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_digital_twin_private_asset_owner` FOREIGN KEY (`owner_user_id`) REFERENCES `sbl_users` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_digital_twin_private_asset_file` FOREIGN KEY (`source_file_id`) REFERENCES `sbl_project_files` (`id`) ON DELETE RESTRICT
);
