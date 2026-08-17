CREATE TABLE `sbl_oa_approval_requests` (
	`id` varchar(36) NOT NULL,
	`request_no` varchar(40) NOT NULL,
	`project_id` varchar(36) NOT NULL,
	`project_name` varchar(128) NOT NULL,
	`title` varchar(255) NOT NULL,
	`type` varchar(32) NOT NULL,
	`from_stage` varchar(16) NOT NULL,
	`target_stage` varchar(16) NOT NULL,
	`status` varchar(16) NOT NULL DEFAULT '审批中',
	`applicant_user_id` varchar(36) NOT NULL,
	`applicant_name` varchar(64) NOT NULL,
	`department` varchar(64) NOT NULL,
	`priority` varchar(8) NOT NULL DEFAULT '普通',
	`active_key` varchar(36),
	`current_node_id` varchar(36),
	`current_node_name` varchar(128) NOT NULL,
	`reason` text NOT NULL,
	`amount` text,
	`valuation` text,
	`attachments` json NOT NULL DEFAULT (JSON_ARRAY()),
	`checklist` json NOT NULL DEFAULT (JSON_ARRAY()),
	`lock_version` int NOT NULL DEFAULT 1,
	`submitted_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`completed_at` datetime(3),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `sbl_oa_approval_requests_id` PRIMARY KEY(`id`),
	CONSTRAINT `fk_oa_request_project` FOREIGN KEY (`project_id`) REFERENCES `sbl_projects`(`id`) ON DELETE restrict ON UPDATE no action,
	CONSTRAINT `fk_oa_request_applicant` FOREIGN KEY (`applicant_user_id`) REFERENCES `sbl_users`(`id`) ON DELETE restrict ON UPDATE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_oa_request_no` ON `sbl_oa_approval_requests` (`request_no`);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_oa_active_project` ON `sbl_oa_approval_requests` (`active_key`);
--> statement-breakpoint
CREATE INDEX `idx_oa_requests_project_submitted` ON `sbl_oa_approval_requests` (`project_id`,`submitted_at`);
--> statement-breakpoint
CREATE INDEX `idx_oa_requests_applicant_submitted` ON `sbl_oa_approval_requests` (`applicant_user_id`,`submitted_at`);
--> statement-breakpoint
CREATE INDEX `idx_oa_requests_status_updated` ON `sbl_oa_approval_requests` (`status`,`updated_at`);
--> statement-breakpoint
CREATE TABLE `sbl_oa_approval_nodes` (
	`id` varchar(36) NOT NULL,
	`request_id` varchar(36) NOT NULL,
	`name` varchar(128) NOT NULL,
	`approver_role` varchar(128) NOT NULL,
	`mode` varchar(8) NOT NULL,
	`sequence` int NOT NULL,
	`status` varchar(16) NOT NULL,
	`approver_user_ids` json NOT NULL DEFAULT (JSON_ARRAY()),
	`approver_names` json NOT NULL DEFAULT (JSON_ARRAY()),
	`approved_by_user_ids` json NOT NULL DEFAULT (JSON_ARRAY()),
	`approved_by_names` json NOT NULL DEFAULT (JSON_ARRAY()),
	`completed_at` datetime(3),
	`comment` text,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `sbl_oa_approval_nodes_id` PRIMARY KEY(`id`),
	CONSTRAINT `fk_oa_node_request` FOREIGN KEY (`request_id`) REFERENCES `sbl_oa_approval_requests`(`id`) ON DELETE cascade ON UPDATE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_oa_nodes_request_sequence` ON `sbl_oa_approval_nodes` (`request_id`,`sequence`);
--> statement-breakpoint
CREATE INDEX `idx_oa_nodes_request_status` ON `sbl_oa_approval_nodes` (`request_id`,`status`);
--> statement-breakpoint
CREATE TABLE `sbl_oa_approval_records` (
	`id` varchar(36) NOT NULL,
	`request_id` varchar(36) NOT NULL,
	`node_id` varchar(36) NOT NULL,
	`node_name` varchar(128) NOT NULL,
	`operator_user_id` varchar(36) NOT NULL,
	`operator_name` varchar(64) NOT NULL,
	`action` varchar(16) NOT NULL,
	`comment` text NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `sbl_oa_approval_records_id` PRIMARY KEY(`id`),
	CONSTRAINT `fk_oa_record_request` FOREIGN KEY (`request_id`) REFERENCES `sbl_oa_approval_requests`(`id`) ON DELETE cascade ON UPDATE no action,
	CONSTRAINT `fk_oa_record_node` FOREIGN KEY (`node_id`) REFERENCES `sbl_oa_approval_nodes`(`id`) ON DELETE restrict ON UPDATE no action,
	CONSTRAINT `fk_oa_record_operator` FOREIGN KEY (`operator_user_id`) REFERENCES `sbl_users`(`id`) ON DELETE restrict ON UPDATE no action
);
--> statement-breakpoint
CREATE INDEX `idx_oa_records_request_time` ON `sbl_oa_approval_records` (`request_id`,`created_at`);
--> statement-breakpoint
CREATE INDEX `idx_oa_records_operator_time` ON `sbl_oa_approval_records` (`operator_user_id`,`created_at`);
--> statement-breakpoint
CREATE TABLE `sbl_oa_workflow_logs` (
	`id` varchar(36) NOT NULL,
	`project_id` varchar(36) NOT NULL,
	`request_id` varchar(36) NOT NULL,
	`request_no` varchar(40) NOT NULL,
	`from_stage` varchar(16) NOT NULL,
	`to_stage` varchar(16) NOT NULL,
	`operator_user_id` varchar(36) NOT NULL,
	`operator_name` varchar(64) NOT NULL,
	`comment` text NOT NULL,
	`source` varchar(32) NOT NULL DEFAULT 'OA审批',
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `sbl_oa_workflow_logs_id` PRIMARY KEY(`id`),
	CONSTRAINT `fk_oa_workflow_project` FOREIGN KEY (`project_id`) REFERENCES `sbl_projects`(`id`) ON DELETE restrict ON UPDATE no action,
	CONSTRAINT `fk_oa_workflow_request` FOREIGN KEY (`request_id`) REFERENCES `sbl_oa_approval_requests`(`id`) ON DELETE restrict ON UPDATE no action,
	CONSTRAINT `fk_oa_workflow_operator` FOREIGN KEY (`operator_user_id`) REFERENCES `sbl_users`(`id`) ON DELETE restrict ON UPDATE no action
);
--> statement-breakpoint
CREATE INDEX `idx_oa_workflow_logs_project_time` ON `sbl_oa_workflow_logs` (`project_id`,`created_at`);
--> statement-breakpoint
CREATE INDEX `idx_oa_workflow_logs_request` ON `sbl_oa_workflow_logs` (`request_id`);
--> statement-breakpoint
ALTER TABLE `sbl_todos` ADD `approval_request_id` varchar(36);
--> statement-breakpoint
CREATE INDEX `idx_todos_approval` ON `sbl_todos` (`approval_request_id`,`status`);
--> statement-breakpoint
ALTER TABLE `sbl_todos` ADD CONSTRAINT `fk_todos_approval_request` FOREIGN KEY (`approval_request_id`) REFERENCES `sbl_oa_approval_requests`(`id`) ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `sbl_projects` ADD CONSTRAINT `fk_projects_latest_approval` FOREIGN KEY (`latest_approval_id`) REFERENCES `sbl_oa_approval_requests`(`id`) ON DELETE set null ON UPDATE no action;
