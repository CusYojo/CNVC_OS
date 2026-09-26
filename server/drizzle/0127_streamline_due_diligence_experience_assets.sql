ALTER TABLE `sbl_digital_twin_learning_candidates`
  DROP INDEX `uq_twin_learning_source`,
  MODIFY COLUMN `source_file_id` char(36) NULL,
  ADD COLUMN `source_type` varchar(32) NOT NULL DEFAULT '正式材料' AFTER `source_name`,
  ADD COLUMN `source_key` varchar(128) NOT NULL DEFAULT '' AFTER `source_type`,
  ADD COLUMN `topic` varchar(128) NOT NULL DEFAULT '尽调判断' AFTER `project_id`,
  ADD COLUMN `confidence` int NOT NULL DEFAULT 80 AFTER `topic`,
  ADD UNIQUE KEY `uq_twin_learning_source` (`twin_id`,`source_key`,`source_hash`);
