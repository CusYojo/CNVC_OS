ALTER TABLE `sbl_due_diligence_interview_artifacts`
  ADD INDEX `idx_dd_interview_artifacts_file` (`file_id`),
  DROP INDEX `uq_dd_interview_artifact_file`,
  ADD CONSTRAINT `uq_dd_interview_artifact_file` UNIQUE (`interview_id`, `file_id`);
