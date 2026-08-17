ALTER TABLE `sbl_audit_logs`
	ADD COLUMN `result` varchar(16),
	ADD COLUMN `request_id` varchar(64);
--> statement-breakpoint
UPDATE `sbl_audit_logs`
SET `result` = 'success',
	`request_id` = CONCAT('legacy-', `id`)
WHERE `result` IS NULL OR `request_id` IS NULL;
--> statement-breakpoint
ALTER TABLE `sbl_audit_logs`
	MODIFY COLUMN `result` varchar(16) NOT NULL DEFAULT 'success',
	MODIFY COLUMN `request_id` varchar(64) NOT NULL;
--> statement-breakpoint
CREATE INDEX `idx_audit_request` ON `sbl_audit_logs` (`request_id`);
