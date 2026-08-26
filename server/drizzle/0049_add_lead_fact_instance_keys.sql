ALTER TABLE `sbl_lead_facts`
  ADD COLUMN `instance_key` varchar(128) NOT NULL DEFAULT 'singleton' AFTER `fact_key`,
  DROP INDEX `uq_lead_facts_version`,
  ADD CONSTRAINT `uq_lead_facts_instance_version`
    UNIQUE (`lead_id`, `subject_id`, `fact_key`, `instance_key`, `version`),
  ADD INDEX `idx_lead_facts_instance` (`lead_id`, `fact_key`, `instance_key`, `is_current`);
--> statement-breakpoint
ALTER TABLE `sbl_lead_fact_conflicts`
  ADD COLUMN `instance_key` varchar(128) NOT NULL DEFAULT 'singleton' AFTER `fact_key`,
  ADD INDEX `idx_lead_fact_conflicts_instance`
    (`lead_id`, `topic_key`, `fact_key`, `instance_key`, `status`);
