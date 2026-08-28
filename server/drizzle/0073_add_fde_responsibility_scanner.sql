CREATE TABLE `sbl_responsibility_scan_cycles` (
  `id` varchar(36) NOT NULL PRIMARY KEY,
  `as_of` datetime(3) NOT NULL, `upper_task_id` varchar(36) NULL, `cursor_task_id` varchar(36) NULL,
  `processed` int NOT NULL DEFAULT 0, `candidates` int NOT NULL DEFAULT 0,
  `last_error_code` varchar(64) NULL, `completed_at` datetime(3) NULL,
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
);
--> statement-breakpoint
CREATE TABLE `sbl_responsibility_scan_state` (
  `name` varchar(64) NOT NULL PRIMARY KEY, `cycle_id` varchar(36) NULL,
  FOREIGN KEY (`cycle_id`) REFERENCES `sbl_responsibility_scan_cycles` (`id`) ON DELETE RESTRICT
);
--> statement-breakpoint
ALTER TABLE `sbl_responsibility_records`
  MODIFY COLUMN `created_by` varchar(36) NULL,
  ADD COLUMN `creation_origin` varchar(16) NOT NULL DEFAULT 'user',
  ADD COLUMN `scan_cycle_id` varchar(36) NULL,
  ADD FOREIGN KEY (`scan_cycle_id`) REFERENCES `sbl_responsibility_scan_cycles` (`id`) ON DELETE RESTRICT,
  ADD CONSTRAINT `ck_resp_creation_origin` CHECK (
    (`creation_origin`='user' AND `created_by` IS NOT NULL AND `scan_cycle_id` IS NULL)
    OR (`creation_origin`='scanner' AND `created_by` IS NULL AND `scan_cycle_id` IS NOT NULL AND `event_code` IN ('no_feedback','unjustified_delay'))
  );
--> statement-breakpoint
ALTER TABLE `sbl_responsibility_events`
  MODIFY COLUMN `actor_id` varchar(36) NULL,
  ADD CONSTRAINT `ck_resp_event_system_actor` CHECK (`actor_id` IS NOT NULL OR `action`='scan_candidate');
