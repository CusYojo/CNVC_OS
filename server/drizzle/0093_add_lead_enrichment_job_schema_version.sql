ALTER TABLE `sbl_lead_enrichment_jobs`
  ADD COLUMN `schema_version` varchar(64) NOT NULL DEFAULT 'lead-enrichment-v3' AFTER `lead_id`;
--> statement-breakpoint
CREATE INDEX `idx_lead_enrichment_jobs_schema_due`
  ON `sbl_lead_enrichment_jobs` (`schema_version`,`status`,`priority`,`next_attempt_at`);
--> statement-breakpoint
ALTER TABLE `sbl_lead_investment_profile_projections`
  ADD COLUMN `projection_version` varchar(64) NOT NULL DEFAULT 'lead-investment-profile-projection-v2' AFTER `dictionary_hash`,
  ADD COLUMN `dictionary_binding` json NOT NULL DEFAULT (JSON_OBJECT()) AFTER `projection_version`,
  ADD COLUMN `profile_payload` json NULL AFTER `dictionary_binding`,
  ADD COLUMN `stale_reason` varchar(64) NULL AFTER `profile_payload`,
  ADD COLUMN `snapshot_created_at` datetime(3) NULL AFTER `stale_reason`,
  ADD COLUMN `projected_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) AFTER `snapshot_created_at`,
  ADD COLUMN `product_total_count` int NOT NULL DEFAULT 0 AFTER `products`,
  ADD COLUMN `institution_total_count` int NOT NULL DEFAULT 0 AFTER `institutions`,
  ADD COLUMN `academic_link_total_count` int NOT NULL DEFAULT 0 AFTER `academic_links`,
  ADD COLUMN `customer_total_count` int NOT NULL DEFAULT 0 AFTER `customer_representatives`,
  ADD COLUMN `mentioned_customer_count` int NOT NULL DEFAULT 0 AFTER `customer_total_count`,
  ADD COLUMN `engaged_customer_count` int NOT NULL DEFAULT 0 AFTER `mentioned_customer_count`,
  ADD COLUMN `trial_customer_count` int NOT NULL DEFAULT 0 AFTER `engaged_customer_count`,
  ADD COLUMN `contracted_customer_count` int NOT NULL DEFAULT 0 AFTER `trial_customer_count`,
  ADD COLUMN `delivered_customer_count` int NOT NULL DEFAULT 0 AFTER `contracted_customer_count`,
  ADD COLUMN `paying_customer_count` int NOT NULL DEFAULT 0 AFTER `delivered_customer_count`;
