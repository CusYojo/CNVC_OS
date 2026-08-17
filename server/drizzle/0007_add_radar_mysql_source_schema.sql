CREATE TABLE `sbl_radar_candidates` (
	`source_key_hash` varchar(64) NOT NULL,
	`source_key` text NOT NULL,
	`content_hash` varchar(64) NOT NULL,
	`source` varchar(64) NOT NULL,
	`source_group` varchar(64),
	`attention_score` int NOT NULL DEFAULT 0,
	`worth_attention` boolean NOT NULL DEFAULT false,
	`collected_at` datetime(3),
	`published_at` datetime(3),
	`cursor_timestamp` bigint NOT NULL,
	`cursor_digest` varchar(64) NOT NULL,
	`payload` json NOT NULL,
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `sbl_radar_candidates_source_key_hash` PRIMARY KEY(`source_key_hash`)
);
--> statement-breakpoint
CREATE TABLE `sbl_radar_collector_states` (
	`id` varchar(64) NOT NULL,
	`state_kind` varchar(32) NOT NULL,
	`content_hash` varchar(64) NOT NULL,
	`state` json NOT NULL DEFAULT (JSON_OBJECT()),
	`source_path` text,
	`captured_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `sbl_radar_collector_states_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `sbl_radar_raw_events` (
	`id` varchar(64) NOT NULL,
	`source_key` text NOT NULL,
	`source_key_hash` varchar(64) NOT NULL,
	`content_hash` varchar(64) NOT NULL,
	`source` varchar(64) NOT NULL,
	`source_group` varchar(64),
	`collected_at` datetime(3),
	`published_at` datetime(3),
	`cursor_timestamp` bigint NOT NULL,
	`cursor_digest` varchar(64) NOT NULL,
	`payload` json NOT NULL,
	`source_file` text,
	`source_line` int,
	`ingested_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `sbl_radar_raw_events_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_radar_raw_source_content` UNIQUE(`source_key_hash`,`content_hash`)
);
--> statement-breakpoint
CREATE TABLE `sbl_radar_source_registry` (
	`id` varchar(64) NOT NULL,
	`source_kind` varchar(32) NOT NULL,
	`source_group` varchar(64),
	`display_name` varchar(255) NOT NULL,
	`external_key` varchar(255),
	`content_hash` varchar(64) NOT NULL,
	`config` json NOT NULL DEFAULT (JSON_OBJECT()),
	`enabled` boolean NOT NULL DEFAULT true,
	`imported_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `sbl_radar_source_registry_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `idx_radar_candidates_cursor` ON `sbl_radar_candidates` (`cursor_timestamp`,`cursor_digest`);--> statement-breakpoint
CREATE INDEX `idx_radar_candidates_source` ON `sbl_radar_candidates` (`source`,`source_group`);--> statement-breakpoint
CREATE INDEX `idx_radar_candidates_attention` ON `sbl_radar_candidates` (`worth_attention`,`attention_score`);--> statement-breakpoint
CREATE INDEX `idx_radar_collector_states_kind` ON `sbl_radar_collector_states` (`state_kind`);--> statement-breakpoint
CREATE INDEX `idx_radar_raw_cursor` ON `sbl_radar_raw_events` (`cursor_timestamp`,`cursor_digest`);--> statement-breakpoint
CREATE INDEX `idx_radar_raw_source` ON `sbl_radar_raw_events` (`source`,`source_group`);--> statement-breakpoint
CREATE INDEX `idx_radar_source_registry_kind` ON `sbl_radar_source_registry` (`source_kind`,`source_group`);
