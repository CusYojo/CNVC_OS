ALTER TABLE `sbl_project_timeline_syncs`
  ADD COLUMN `source` varchar(24) NOT NULL DEFAULT 'manual',
  ADD COLUMN `source_key` varchar(128),
  ADD COLUMN `status` varchar(16) NOT NULL DEFAULT 'completed',
  ADD COLUMN `resolved_by` varchar(36),
  ADD UNIQUE KEY `uq_timeline_event` (`project_id`, `source_key`),
  ADD KEY `idx_timeline_pending` (`project_id`, `status`);
