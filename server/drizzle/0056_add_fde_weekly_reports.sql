CREATE TABLE `sbl_personal_weekly_reports` (
  `id` varchar(36) NOT NULL PRIMARY KEY,
  `author_id` varchar(36) NOT NULL,
  `week_start` varchar(10) NOT NULL,
  `revision` int NOT NULL,
  `version` int NOT NULL DEFAULT 1,
  `status` varchar(16) NOT NULL DEFAULT 'draft',
  `active_key` varchar(64),
  `body` longtext NOT NULL,
  `facts` json NOT NULL,
  `source_hash` varchar(64) NOT NULL,
  `published_at` datetime(3),
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY `uq_weekly_report_revision` (`author_id`,`week_start`,`revision`),
  UNIQUE KEY `uq_weekly_report_active` (`active_key`),
  CONSTRAINT `fk_weekly_report_author` FOREIGN KEY (`author_id`) REFERENCES `sbl_users` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `ck_weekly_report_state` CHECK (`status` IN ('draft','published','withdrawn','discarded')),
  CONSTRAINT `ck_weekly_report_version` CHECK (`version` > 0 AND `revision` > 0)
);
--> statement-breakpoint
CREATE TABLE `sbl_personal_weekly_report_events` (
  `id` varchar(36) NOT NULL PRIMARY KEY,
  `report_id` varchar(36) NOT NULL,
  `request_id` varchar(36) NOT NULL,
  `request_hash` varchar(64) NOT NULL,
  `actor_id` varchar(36) NOT NULL,
  `action` varchar(16) NOT NULL,
  `version` int NOT NULL,
  `reason` text NOT NULL,
  `snapshot` json NOT NULL,
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY `uq_weekly_report_request` (`request_id`),
  KEY `idx_weekly_report_event` (`report_id`,`version`),
  CONSTRAINT `fk_weekly_report_event_report` FOREIGN KEY (`report_id`) REFERENCES `sbl_personal_weekly_reports` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_weekly_report_event_actor` FOREIGN KEY (`actor_id`) REFERENCES `sbl_users` (`id`) ON DELETE RESTRICT
);
--> statement-breakpoint
CREATE TABLE `sbl_personal_weekly_report_recipients` (
  `id` varchar(36) NOT NULL PRIMARY KEY,
  `report_id` varchar(36) NOT NULL,
  `user_id` varchar(36) NOT NULL,
  `read_at` datetime(3),
  `closed_at` datetime(3),
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY `uq_weekly_report_recipient` (`report_id`,`user_id`),
  CONSTRAINT `fk_weekly_report_recipient_report` FOREIGN KEY (`report_id`) REFERENCES `sbl_personal_weekly_reports` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_weekly_report_recipient_user` FOREIGN KEY (`user_id`) REFERENCES `sbl_users` (`id`) ON DELETE RESTRICT
);
