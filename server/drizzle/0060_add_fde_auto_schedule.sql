ALTER TABLE `sbl_leader_time_requests`
 ADD COLUMN `priority` varchar(4) NULL,
 ADD COLUMN `schedule_note` text NULL,
 ADD CHECK (`priority` IS NULL OR `priority` IN ('P0','P1','P2','P3'));
--> statement-breakpoint
CREATE TABLE `sbl_leader_time_batches` (
 `id` varchar(36) NOT NULL PRIMARY KEY,
 `actor_id` varchar(36) NOT NULL,
 `request_hash` varchar(64) NOT NULL,
 `result` json NOT NULL,
 `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
 FOREIGN KEY (`actor_id`) REFERENCES `sbl_users` (`id`) ON DELETE RESTRICT
);
