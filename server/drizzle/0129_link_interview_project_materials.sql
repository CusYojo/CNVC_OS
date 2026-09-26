ALTER TABLE `sbl_due_diligence_interview_artifacts` DROP INDEX `uq_dd_interview_artifact_file`;
--> statement-breakpoint
ALTER TABLE `sbl_due_diligence_interview_artifacts` ADD CONSTRAINT `uq_dd_interview_artifact_file` UNIQUE(`interview_id`,`file_id`);
