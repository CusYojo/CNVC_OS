ALTER TABLE `sbl_ai_evolution_release_jobs`
  ADD COLUMN `operation` varchar(16) NOT NULL DEFAULT 'release' AFTER `status`,
  ADD COLUMN `source_release_job_id` varchar(36) NULL AFTER `operation`,
  ADD CONSTRAINT `fk_evo_release_job_source` FOREIGN KEY (`source_release_job_id`) REFERENCES `sbl_ai_evolution_release_jobs` (`id`),
  ADD UNIQUE KEY `uq_evo_release_job_rollback_source` (`source_release_job_id`);
