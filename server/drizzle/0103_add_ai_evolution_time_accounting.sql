ALTER TABLE `sbl_ai_evolution_runs` ADD COLUMN `time_accounted_at` datetime(3) NULL;
UPDATE `sbl_ai_evolution_runs` SET `time_accounted_at` = `updated_at`
WHERE `status` IN ('preparing', 'executing', 'evaluating');
