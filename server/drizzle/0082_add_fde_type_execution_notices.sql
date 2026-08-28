CREATE TABLE `sbl_fde_type_execution_notices` (
  `id` varchar(36) NOT NULL,
  `review_id` varchar(36) NOT NULL,
  `node_key` varchar(48) NOT NULL,
  `recipient_id` varchar(36) NOT NULL,
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `read_at` datetime(3) NULL,
  `closed_at` datetime(3) NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_type_notice_node_recipient` (`review_id`,`node_key`,`recipient_id`),
  KEY `idx_type_notice_recipient` (`recipient_id`,`closed_at`),
  CONSTRAINT `fk_type_notice_review` FOREIGN KEY (`review_id`) REFERENCES `sbl_fde_type_execution_reviews` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_type_notice_recipient` FOREIGN KEY (`recipient_id`) REFERENCES `sbl_users` (`id`) ON DELETE RESTRICT
);
