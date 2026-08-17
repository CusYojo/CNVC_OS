CREATE TABLE IF NOT EXISTS `sbl_auth_legacy_bearer_policy` (
  `id` varchar(32) NOT NULL,
  `revoked_before` datetime(3) NOT NULL,
  `version` bigint NOT NULL DEFAULT 1,
  `reason` text NOT NULL,
  `updated_by` varchar(36) DEFAULT NULL,
  `updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  KEY `idx_auth_legacy_bearer_updated_by` (`updated_by`),
  CONSTRAINT `sbl_auth_legacy_bearer_updated_by_fk` FOREIGN KEY (`updated_by`) REFERENCES `sbl_users` (`id`) ON DELETE SET NULL,
  CONSTRAINT `ck_auth_legacy_bearer_global` CHECK (`id` = 'global'),
  CONSTRAINT `ck_auth_legacy_bearer_version` CHECK (`version` > 0)
);--> statement-breakpoint

INSERT IGNORE INTO `sbl_auth_legacy_bearer_policy`
  (`id`,`revoked_before`,`version`,`reason`,`updated_by`,`updated_at`)
VALUES ('global',CURRENT_TIMESTAMP(3),1,'schema initialization',NULL,CURRENT_TIMESTAMP(3));
