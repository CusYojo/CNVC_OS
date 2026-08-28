CREATE TABLE `sbl_company_knowledge_commands` (
  `id` varchar(36) NOT NULL PRIMARY KEY,
  `actor_id` varchar(36) NOT NULL,
  `command_id` varchar(36) NOT NULL,
  `entry_id` varchar(36) NOT NULL,
  `action` varchar(16) NOT NULL,
  `comment_id` varchar(36) NULL,
  `command_hash` varchar(64) NULL,
  `receipt` json NULL,
  `closed_at` datetime(3) NULL,
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `completed_at` datetime(3) NULL,
  UNIQUE KEY `uq_knowledge_actor_command` (`actor_id`,`command_id`),
  FOREIGN KEY (`actor_id`) REFERENCES `sbl_users` (`id`) ON DELETE RESTRICT
);
