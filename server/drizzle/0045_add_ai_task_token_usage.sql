ALTER TABLE `sbl_ai_tasks` ADD `model_calls` int NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE `sbl_ai_tasks` ADD `usage_calls` int NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE `sbl_ai_tasks` ADD `input_tokens` bigint NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE `sbl_ai_tasks` ADD `output_tokens` bigint NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE `sbl_ai_tasks` ADD `cache_creation_input_tokens` bigint NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE `sbl_ai_tasks` ADD `cache_read_input_tokens` bigint NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE `sbl_ai_tasks` ADD `reasoning_tokens` bigint NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE `sbl_ai_tasks` ADD `total_tokens` bigint NOT NULL DEFAULT 0;
