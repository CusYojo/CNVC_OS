CREATE TABLE `sbl_oa_office_commands` (
  `id` varchar(36) NOT NULL PRIMARY KEY,
  `actor_id` varchar(36) NOT NULL,
  `command_id` varchar(36) NOT NULL,
  `request_id` varchar(36) NOT NULL,
  `closed_at` datetime(3) NULL,
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY `uq_office_actor_command` (`actor_id`,`command_id`),
  FOREIGN KEY (`actor_id`) REFERENCES `sbl_users` (`id`) ON DELETE RESTRICT
);
