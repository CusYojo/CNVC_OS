ALTER TABLE `sbl_project_duty_assignments`
  DROP CHECK `ck_fde_duty`,
  ADD CONSTRAINT `ck_fde_duty` CHECK (`duty` IN ('secretary','member','coordinator','finance','legal','concerned_leader','executive_lead','chairman','president'));
--> statement-breakpoint
ALTER TABLE `sbl_leader_time_requests`
  ADD COLUMN `source_type_action_id` varchar(36),
  ADD UNIQUE KEY `uq_leader_time_type_action` (`source_type_action_id`, `leader_id`),
  ADD CONSTRAINT `fk_time_type_action` FOREIGN KEY (`source_type_action_id`) REFERENCES `sbl_project_plan_actions` (`id`) ON DELETE RESTRICT,
  ADD CONSTRAINT `ck_time_type_source` CHECK (`source_type_action_id` IS NULL OR (`task_id` IS NOT NULL AND `source_weekly_item_id` IS NULL AND `source_timeline_task_id` IS NULL AND `source_directive_id` IS NULL));
--> statement-breakpoint
ALTER TABLE `sbl_fde_type_execution_events`
  DROP CHECK `ck_type_execution_event_action`,
  ADD CONSTRAINT `ck_type_execution_event_action` CHECK (`action` IN ('save_plan','submit_plan','submit_stage','decide','reconcile_times'));
