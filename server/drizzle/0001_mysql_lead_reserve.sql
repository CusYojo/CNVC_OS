CREATE TABLE `sbl_lead_reserve` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`seq` int,
	`src_id` text,
	`name` text,
	`detail_url` text,
	`detail_json` json,
	`imported` boolean NOT NULL DEFAULT false,
	`imported_at` datetime(3),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `sbl_lead_reserve_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `idx_reserve_imported_seq` ON `sbl_lead_reserve` (`imported`,`seq`);