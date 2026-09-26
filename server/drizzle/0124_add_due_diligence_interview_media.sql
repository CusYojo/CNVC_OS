CREATE TABLE `sbl_due_diligence_interview_artifacts` (
  `id` char(36) NOT NULL,
  `interview_id` char(36) NOT NULL,
  `file_id` char(36) NOT NULL,
  `kind` varchar(16) NOT NULL,
  `source` varchar(32) NOT NULL DEFAULT 'manual',
  `duration_seconds` int,
  `created_by` char(36),
  `created_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_dd_interview_artifact_file` (`file_id`),
  KEY `idx_dd_interview_artifacts_interview` (`interview_id`, `created_at`),
  CONSTRAINT `fk_dd_interview_artifacts_interview` FOREIGN KEY (`interview_id`) REFERENCES `sbl_due_diligence_interviews` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_dd_interview_artifacts_file` FOREIGN KEY (`file_id`) REFERENCES `sbl_project_files` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_dd_interview_artifacts_creator` FOREIGN KEY (`created_by`) REFERENCES `sbl_users` (`id`) ON DELETE SET NULL
);
--> statement-breakpoint
CREATE TABLE `sbl_due_diligence_interview_transcripts` (
  `id` char(36) NOT NULL,
  `interview_id` char(36) NOT NULL,
  `content` longtext NOT NULL,
  `source` varchar(32) NOT NULL DEFAULT 'browser',
  `status` varchar(16) NOT NULL DEFAULT '草稿',
  `version` int NOT NULL DEFAULT 1,
  `created_by` char(36),
  `created_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_dd_interview_transcript_interview` (`interview_id`),
  CONSTRAINT `fk_dd_interview_transcripts_interview` FOREIGN KEY (`interview_id`) REFERENCES `sbl_due_diligence_interviews` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_dd_interview_transcripts_creator` FOREIGN KEY (`created_by`) REFERENCES `sbl_users` (`id`) ON DELETE SET NULL
);
