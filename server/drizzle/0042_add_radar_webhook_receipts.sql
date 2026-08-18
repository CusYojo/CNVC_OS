CREATE TABLE `sbl_radar_webhook_receipts` (
	`receipt_hash` varchar(64) NOT NULL,
	`signed_at` datetime(3) NOT NULL,
	`expires_at` datetime(3) NOT NULL,
	`received_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `sbl_radar_webhook_receipts_receipt_hash` PRIMARY KEY(`receipt_hash`)
);
--> statement-breakpoint
CREATE INDEX `idx_radar_webhook_receipts_expiry` ON `sbl_radar_webhook_receipts` (`expires_at`);
