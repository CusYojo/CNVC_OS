-- Repair a historical partially applied 0047 deployment. Fresh databases already receive
-- both tables from 0047; IF NOT EXISTS keeps this forward-only repair idempotent.
CREATE TABLE IF NOT EXISTS `sbl_lead_topic_search_cache` (
  `cache_key` varchar(64) NOT NULL,
  `subject_fingerprint` varchar(64) NOT NULL,
  `topic_key` varchar(48) NOT NULL,
  `prompt_version` varchar(64) NOT NULL,
  `query_plan_hash` varchar(64) NOT NULL,
  `model` varchar(128) NOT NULL,
  `result` json NOT NULL,
  `expires_at` datetime(3) NOT NULL,
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT `sbl_lead_topic_search_cache_pk` PRIMARY KEY (`cache_key`),
  INDEX `idx_lead_topic_search_cache_subject` (`subject_fingerprint`,`topic_key`,`expires_at`),
  INDEX `idx_lead_topic_search_cache_expiry` (`expires_at`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `sbl_lead_rating_history` (
  `id` varchar(36) NOT NULL,
  `lead_id` varchar(36) NOT NULL,
  `snapshot_id` varchar(36) NOT NULL,
  `snapshot_hash` varchar(64) NOT NULL,
  `rating_schema_version` varchar(64) NOT NULL,
  `workflow` varchar(64) NOT NULL,
  `prompt_version` varchar(128) NOT NULL,
  `model` varchar(128) NOT NULL,
  `status` varchar(24) NOT NULL,
  `result` json NOT NULL,
  `completed_at` datetime(3) NOT NULL,
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT `sbl_lead_rating_history_pk` PRIMARY KEY (`id`),
  CONSTRAINT `sbl_lead_rating_history_lead_fk` FOREIGN KEY (`lead_id`) REFERENCES `sbl_leads` (`id`) ON DELETE CASCADE,
  CONSTRAINT `sbl_lead_rating_history_snapshot_fk` FOREIGN KEY (`snapshot_id`) REFERENCES `sbl_lead_enrichment_snapshots` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `uq_lead_rating_history_snapshot` UNIQUE (`lead_id`,`snapshot_hash`,`rating_schema_version`),
  INDEX `idx_lead_rating_history_lead` (`lead_id`,`completed_at`),
  INDEX `idx_lead_rating_history_snapshot` (`snapshot_id`)
);
