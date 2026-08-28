ALTER TABLE `sbl_leader_time_requests`
 ADD COLUMN `reason` text NULL,
 ADD COLUMN `outcome` text NULL,
 ADD COLUMN `impact` text NULL,
 ADD COLUMN `scheduled_start` datetime(3) NULL,
 ADD COLUMN `confirmed_at` datetime(3) NULL,
 ADD COLUMN `confirmed_by` varchar(36) NULL,
 ADD COLUMN `supplement_note` text NULL,
 ADD FOREIGN KEY (`confirmed_by`) REFERENCES `sbl_users` (`id`) ON DELETE RESTRICT,
 ADD CHECK (`status` IN ('draft','requested','pending','supplement','confirmed','rejected','withdrawn','cancelled')),
 ADD CHECK (`status` <> 'confirmed' OR (`confirmed_at` IS NOT NULL AND `confirmed_by` IS NOT NULL AND `confirmed_by`=`leader_id` AND `scheduled_start` IS NOT NULL));
--> statement-breakpoint
CREATE TABLE `sbl_leader_time_events` (
 `id` varchar(36) NOT NULL PRIMARY KEY,
 `time_request_id` varchar(36) NOT NULL,
 `request_id` varchar(36) NOT NULL,
 `request_hash` varchar(64) NOT NULL,
 `actor_id` varchar(36) NOT NULL,
 `action` varchar(32) NOT NULL,
 `reason` text NOT NULL,
 `version` int NOT NULL,
 `snapshot` json NOT NULL,
 `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
 UNIQUE KEY `uq_leader_time_event_request` (`request_id`),
 KEY `idx_leader_time_event` (`time_request_id`,`version`),
 FOREIGN KEY (`time_request_id`) REFERENCES `sbl_leader_time_requests` (`id`) ON DELETE RESTRICT,
 FOREIGN KEY (`actor_id`) REFERENCES `sbl_users` (`id`) ON DELETE RESTRICT
);
--> statement-breakpoint
CREATE TABLE `sbl_leader_time_notices` (
 `id` varchar(36) NOT NULL PRIMARY KEY,
 `time_request_id` varchar(36) NOT NULL,
 `recipient_id` varchar(36) NOT NULL,
 `kind` varchar(32) NOT NULL,
 `version` int NOT NULL,
 `read_at` datetime(3) NULL,
 `closed_at` datetime(3) NULL,
 `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
 UNIQUE KEY `uq_leader_time_notice` (`time_request_id`,`recipient_id`,`version`),
 FOREIGN KEY (`time_request_id`) REFERENCES `sbl_leader_time_requests` (`id`) ON DELETE RESTRICT,
 FOREIGN KEY (`recipient_id`) REFERENCES `sbl_users` (`id`) ON DELETE RESTRICT
);
--> statement-breakpoint
CREATE TABLE `sbl_personal_calendar_events` (
 `id` varchar(36) NOT NULL PRIMARY KEY,
 `owner_id` varchar(36) NOT NULL,
 `title` varchar(255) NOT NULL,
 `detail` text NOT NULL,
 `starts_at` datetime(3) NOT NULL,
 `ends_at` datetime(3) NOT NULL,
 `visibility` varchar(16) NOT NULL DEFAULT 'private',
 `status` varchar(16) NOT NULL DEFAULT 'active',
 `version` int NOT NULL DEFAULT 1,
 `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
 KEY `idx_calendar_owner_time` (`owner_id`,`starts_at`),
 FOREIGN KEY (`owner_id`) REFERENCES `sbl_users` (`id`) ON DELETE RESTRICT,
 CHECK (`ends_at` > `starts_at`),
 CHECK (`visibility` IN ('private','company')),
 CHECK (`status` IN ('active','cancelled'))
);
--> statement-breakpoint
CREATE TABLE `sbl_personal_calendar_history` (
 `id` varchar(36) NOT NULL PRIMARY KEY,
 `event_id` varchar(36) NOT NULL,
 `request_id` varchar(36) NOT NULL,
 `request_hash` varchar(64) NOT NULL,
 `actor_id` varchar(36) NOT NULL,
 `action` varchar(16) NOT NULL,
 `reason` text NOT NULL,
 `version` int NOT NULL,
 `snapshot` json NOT NULL,
 `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
 UNIQUE KEY `uq_calendar_history_request` (`request_id`),
 FOREIGN KEY (`event_id`) REFERENCES `sbl_personal_calendar_events` (`id`) ON DELETE RESTRICT,
 FOREIGN KEY (`actor_id`) REFERENCES `sbl_users` (`id`) ON DELETE RESTRICT
);
