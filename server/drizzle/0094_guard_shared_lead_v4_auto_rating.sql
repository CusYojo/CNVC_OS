ALTER TABLE `sbl_lead_score_jobs`
  ADD COLUMN `request_mode` varchar(24) NOT NULL DEFAULT 'automatic' AFTER `rating_schema_version`,
  ADD CONSTRAINT `ck_lead_score_jobs_request_mode`
    CHECK (`request_mode` IN ('automatic','manual','dedicated_project'));
--> statement-breakpoint
DROP TRIGGER IF EXISTS `sbl_guard_v4_auto_rating_insert`;
--> statement-breakpoint
CREATE TRIGGER `sbl_guard_v4_auto_rating_insert`
BEFORE INSERT ON `sbl_lead_score_jobs`
FOR EACH ROW
BEGIN
  IF NEW.`request_mode` = 'automatic'
    AND NEW.`status` IN ('queued','running','retrying')
    AND NEW.`enrichment_snapshot_id` IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM `sbl_lead_enrichment_snapshots` s
      WHERE s.`id` = NEW.`enrichment_snapshot_id`
        AND s.`schema_version` = 'lead-enrichment-v4-investment-profile'
    )
  THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'automatic V3 rating is disabled for shared-lead V4 snapshots';
  END IF;
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `sbl_guard_v4_auto_rating_update`;
--> statement-breakpoint
CREATE TRIGGER `sbl_guard_v4_auto_rating_update`
BEFORE UPDATE ON `sbl_lead_score_jobs`
FOR EACH ROW
BEGIN
  IF NEW.`request_mode` = 'automatic'
    AND NEW.`status` IN ('queued','running','retrying')
    AND NEW.`enrichment_snapshot_id` IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM `sbl_lead_enrichment_snapshots` s
      WHERE s.`id` = NEW.`enrichment_snapshot_id`
        AND s.`schema_version` = 'lead-enrichment-v4-investment-profile'
    )
  THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'automatic V3 rating is disabled for shared-lead V4 snapshots';
  END IF;
END;
