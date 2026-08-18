CREATE TABLE `sbl_radar_wechat_chat_messages` (
	`id` varchar(64) NOT NULL,
	`content_hash` varchar(64) NOT NULL,
	`merchant_no` varchar(128) NOT NULL DEFAULT '',
	`msg_key` varchar(191) NOT NULL DEFAULT '',
	`group_name` varchar(255) NOT NULL,
	`group_serial_no` varchar(191) NOT NULL,
	`sender_name` varchar(255) NOT NULL,
	`sender_serial_no` varchar(191) NOT NULL DEFAULT '',
	`cite_content` text NOT NULL,
	`message_content` longtext NOT NULL,
	`message_date` varchar(10) NOT NULL,
	`message_time` datetime(3),
	`message_time_raw` varchar(64) NOT NULL DEFAULT '',
	`pushed_at` datetime(3),
	`pushed_at_raw` varchar(64) NOT NULL DEFAULT '',
	`msg_type` varchar(32) NOT NULL DEFAULT '',
	`file` json NOT NULL DEFAULT (JSON_OBJECT()),
	`raw_payload` json NOT NULL DEFAULT (JSON_OBJECT()),
	`received_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `sbl_radar_wechat_chat_messages_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `idx_radar_chat_group_time` ON `sbl_radar_wechat_chat_messages` (`message_date`,`group_serial_no`,`message_time`);
--> statement-breakpoint
CREATE INDEX `idx_radar_chat_merchant_time` ON `sbl_radar_wechat_chat_messages` (`merchant_no`,`message_time`);
--> statement-breakpoint
CREATE INDEX `idx_radar_chat_content` ON `sbl_radar_wechat_chat_messages` (`content_hash`);
