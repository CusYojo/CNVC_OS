CREATE TABLE `sbl_lead_agent_runtime_permits` (
	`id` varchar(36) NOT NULL,
	`agent_profile` varchar(64) NOT NULL,
	`state` varchar(16) NOT NULL DEFAULT 'active',
	`reserved_microusd` bigint NOT NULL,
	`actual_microusd` bigint,
	`error_class` varchar(64),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`expires_at` datetime(3) NOT NULL,
	`finished_at` datetime(3),
	CONSTRAINT `sbl_lead_agent_runtime_permits_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `idx_lead_agent_permits_state_expiry` ON `sbl_lead_agent_runtime_permits` (`state`,`expires_at`);
--> statement-breakpoint
CREATE INDEX `idx_lead_agent_permits_created` ON `sbl_lead_agent_runtime_permits` (`created_at`);
--> statement-breakpoint
CREATE INDEX `idx_lead_agent_permits_profile_created` ON `sbl_lead_agent_runtime_permits` (`agent_profile`,`created_at`);
