ALTER TABLE `sbl_fde_type_policy_events` DROP CHECK `ck_type_policy_event_action`;
--> statement-breakpoint
ALTER TABLE `sbl_fde_type_policy_events` ADD CONSTRAINT `ck_type_policy_event_action` CHECK (`action` IN ('create','save','approve','publish','activate','deactivate'));
--> statement-breakpoint
CREATE TABLE `sbl_fde_type_registration_commands` (
  `id` varchar(36) NOT NULL PRIMARY KEY, `actor_id` varchar(36) NOT NULL,
  `command_id` varchar(36) NOT NULL, `command_hash` varchar(64), `receipt` json, `closed_at` datetime(3),
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT `fk_type_registration_actor` FOREIGN KEY (`actor_id`) REFERENCES `sbl_users` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `ck_type_registration_complete` CHECK ((`closed_at` IS NULL AND `command_hash` IS NOT NULL AND `receipt` IS NOT NULL) OR (`closed_at` IS NOT NULL AND `command_hash` IS NULL AND `receipt` IS NULL)),
  UNIQUE KEY `uq_type_registration_command` (`actor_id`,`command_id`)
);
