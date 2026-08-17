CREATE TABLE `sbl_im_lead_push_rules` (
	`id` varchar(36) NOT NULL,
	`name` varchar(128) NOT NULL,
	`bot_id` varchar(36) NOT NULL,
	`binding_id` varchar(36) NOT NULL,
	`lead_status` varchar(32),
	`project_id` varchar(36),
	`min_score` int,
	`message_template` text NOT NULL,
	`enabled` boolean NOT NULL DEFAULT true,
	`version` int NOT NULL DEFAULT 1,
	`created_by` varchar(36),
	`updated_by` varchar(36),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `sbl_im_lead_push_rules_id` PRIMARY KEY(`id`),
	CONSTRAINT `fk_im_lead_push_rules_bot` FOREIGN KEY (`bot_id`) REFERENCES `sbl_im_bots`(`id`) ON DELETE restrict ON UPDATE no action,
	CONSTRAINT `fk_im_lead_push_rules_binding` FOREIGN KEY (`binding_id`) REFERENCES `sbl_im_bot_bindings`(`id`) ON DELETE restrict ON UPDATE no action,
	CONSTRAINT `fk_im_lead_push_rules_project` FOREIGN KEY (`project_id`) REFERENCES `sbl_projects`(`id`) ON DELETE set null ON UPDATE no action,
	CONSTRAINT `fk_im_lead_push_rules_created_by` FOREIGN KEY (`created_by`) REFERENCES `sbl_users`(`id`) ON DELETE set null ON UPDATE no action,
	CONSTRAINT `fk_im_lead_push_rules_updated_by` FOREIGN KEY (`updated_by`) REFERENCES `sbl_users`(`id`) ON DELETE set null ON UPDATE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_im_lead_push_rules_name` ON `sbl_im_lead_push_rules` (`name`);
--> statement-breakpoint
CREATE INDEX `idx_im_lead_push_rules_enabled` ON `sbl_im_lead_push_rules` (`enabled`,`lead_status`,`min_score`);
--> statement-breakpoint
CREATE INDEX `idx_im_lead_push_rules_target` ON `sbl_im_lead_push_rules` (`bot_id`,`binding_id`);
--> statement-breakpoint
CREATE INDEX `idx_im_lead_push_rules_project` ON `sbl_im_lead_push_rules` (`project_id`,`enabled`);
