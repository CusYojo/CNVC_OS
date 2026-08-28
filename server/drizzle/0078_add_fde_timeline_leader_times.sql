ALTER TABLE `sbl_leader_time_requests`
  ADD COLUMN `source_timeline_task_id` varchar(36),
  ADD COLUMN `source_fingerprint` varchar(64),
  ADD COLUMN `source_version` int,
  ADD COLUMN `source_retired` boolean NOT NULL DEFAULT false,
  ADD UNIQUE KEY `uq_leader_time_timeline` (`source_timeline_task_id`, `leader_id`),
  ADD CONSTRAINT `fk_time_timeline_task` FOREIGN KEY (`source_timeline_task_id`) REFERENCES `sbl_project_timeline_tasks` (`task_id`) ON DELETE RESTRICT;
