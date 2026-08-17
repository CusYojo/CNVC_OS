ALTER TABLE `sbl_leads`
  ADD COLUMN `field_provenance` json NOT NULL DEFAULT (JSON_OBJECT()) AFTER `radar_source_keys`;
--> statement-breakpoint
UPDATE `sbl_leads`
SET `field_provenance` = JSON_OBJECT(
  '*', JSON_OBJECT(
    'sourceType', CASE
      WHEN `source` LIKE '人工复核%' THEN 'manual_review'
      WHEN `source` LIKE '项目发现雷达%' THEN 'radar'
      WHEN `source` LIKE '公开情报%' THEN 'public_intel'
      ELSE 'legacy_import'
    END,
    'priority', CASE
      WHEN `source` LIKE '人工复核%' THEN 100
      WHEN `source` LIKE '公开情报%' THEN 60
      WHEN `source` LIKE '项目发现雷达%' THEN 50
      ELSE 90
    END,
    'operation', 'preserve_existing'
  )
)
WHERE JSON_LENGTH(`field_provenance`) = 0;
