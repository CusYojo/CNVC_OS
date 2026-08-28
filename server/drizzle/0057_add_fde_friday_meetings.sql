ALTER TABLE `sbl_meetings`
  ADD COLUMN `ends_at` datetime(3) NULL,
  ADD COLUMN `workflow_kind` varchar(24) NOT NULL DEFAULT 'legacy',
  ADD COLUMN `workflow_status` varchar(24) NOT NULL DEFAULT 'recorded',
  ADD COLUMN `weekly_review` json NULL,
  ADD COLUMN `confirmed_by` varchar(36) NULL,
  ADD COLUMN `confirmed_at` datetime(3) NULL,
  ADD CONSTRAINT `sbl_meeting_confirmed_user_fk` FOREIGN KEY (`confirmed_by`) REFERENCES `sbl_users` (`id`) ON DELETE RESTRICT,
  ADD CONSTRAINT `sbl_meeting_workflow_state_ck` CHECK ((`workflow_kind`='legacy' AND `workflow_status`='recorded') OR (`workflow_kind`='friday' AND `workflow_status` IN ('draft','scheduled','completed','cancelled')));
--> statement-breakpoint
CREATE TABLE `sbl_meeting_workflow_events` (
  `id` varchar(36) NOT NULL PRIMARY KEY,
  `meeting_id` varchar(36) NOT NULL,
  `request_id` varchar(36) NOT NULL,
  `request_hash` varchar(64) NOT NULL,
  `actor_id` varchar(36) NOT NULL,
  `action` varchar(24) NOT NULL,
  `version` int NOT NULL,
  `reason` text NOT NULL,
  `snapshot` json NOT NULL,
  `result` json NOT NULL,
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY `uq_meeting_workflow_request` (`request_id`),
  KEY `idx_meeting_workflow_event` (`meeting_id`,`version`),
  FOREIGN KEY (`meeting_id`) REFERENCES `sbl_meetings` (`id`) ON DELETE RESTRICT,
  FOREIGN KEY (`actor_id`) REFERENCES `sbl_users` (`id`) ON DELETE RESTRICT
);
--> statement-breakpoint
CREATE TABLE `sbl_meeting_workflow_notices` (
  `id` varchar(36) NOT NULL PRIMARY KEY,
  `meeting_id` varchar(36) NOT NULL,
  `recipient_id` varchar(36) NOT NULL,
  `kind` varchar(24) NOT NULL,
  `version` int NOT NULL,
  `closed_at` datetime(3) NULL,
  `read_at` datetime(3) NULL,
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY `uq_meeting_workflow_notice` (`meeting_id`,`recipient_id`,`version`),
  FOREIGN KEY (`meeting_id`) REFERENCES `sbl_meetings` (`id`) ON DELETE RESTRICT,
  FOREIGN KEY (`recipient_id`) REFERENCES `sbl_users` (`id`) ON DELETE RESTRICT
);
--> statement-breakpoint
ALTER TABLE `sbl_project_weekly_plans`
  ADD COLUMN `source_meeting_id` varchar(36) NULL,
  ADD COLUMN `source_meeting_version` int NULL,
  ADD CONSTRAINT `sbl_weekly_source_meeting_fk` FOREIGN KEY (`source_meeting_id`) REFERENCES `sbl_meetings` (`id`) ON DELETE RESTRICT,
  ADD KEY `idx_weekly_source_meeting` (`source_meeting_id`);
