CREATE TABLE `sbl_auth_sessions` (
	`id` varchar(36) NOT NULL,
	`user_id` varchar(36) NOT NULL,
	`token_hash` varchar(64) NOT NULL,
	`csrf_hash` varchar(64) NOT NULL,
	`expires_at` datetime(3) NOT NULL,
	`revoked_at` datetime(3),
	`last_seen_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`user_agent` text,
	`ip_address` varchar(64),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `sbl_auth_sessions_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_auth_sessions_token_hash` UNIQUE(`token_hash`)
);
--> statement-breakpoint
ALTER TABLE `sbl_auth_sessions` ADD CONSTRAINT `sbl_auth_sessions_user_id_sbl_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `sbl_users`(`id`) ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX `idx_auth_sessions_user` ON `sbl_auth_sessions` (`user_id`,`revoked_at`);
--> statement-breakpoint
CREATE INDEX `idx_auth_sessions_expiry` ON `sbl_auth_sessions` (`expires_at`);
