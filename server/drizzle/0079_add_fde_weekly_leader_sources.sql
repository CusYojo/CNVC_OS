ALTER TABLE `sbl_project_weekly_plan_items`
  ADD COLUMN `need_leader` boolean NOT NULL DEFAULT false,
  ADD COLUMN `source_stage` varchar(64),
  ADD CONSTRAINT `ck_weekly_leader_time` CHECK (`need_leader` = false OR (`source_kind` = 'manual' AND `due_time` IS NOT NULL));
--> statement-breakpoint
ALTER TABLE `sbl_leader_time_requests`
  ADD COLUMN `source_weekly_item_id` varchar(36),
  ADD UNIQUE KEY `uq_leader_time_weekly` (`source_weekly_item_id`, `leader_id`),
  ADD CONSTRAINT `fk_time_weekly_item` FOREIGN KEY (`source_weekly_item_id`) REFERENCES `sbl_project_weekly_plan_items` (`id`) ON DELETE RESTRICT,
  ADD CONSTRAINT `ck_time_single_source` CHECK (`source_weekly_item_id` IS NULL OR (`source_timeline_task_id` IS NULL AND `source_directive_id` IS NULL));
