CREATE TABLE `sbl_project_material_request_closures` (
  `id` varchar(36) NOT NULL PRIMARY KEY,
  `request_id` varchar(36) NOT NULL,
  `project_id` varchar(36) NOT NULL,
  `actor_id` varchar(36) NOT NULL,
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY `uq_material_request_closure` (`project_id`,`actor_id`,`request_id`),
  FOREIGN KEY (`project_id`) REFERENCES `sbl_projects` (`id`) ON DELETE RESTRICT,
  FOREIGN KEY (`actor_id`) REFERENCES `sbl_users` (`id`) ON DELETE RESTRICT
);
