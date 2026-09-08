CREATE TABLE `sbl_ai_evolution_model_calls` (
  `id` varchar(36) NOT NULL PRIMARY KEY,
  `run_id` varchar(36) NOT NULL,
  `call_key` varchar(128) NOT NULL,
  `input_hash` varchar(64) NOT NULL,
  `attempt` int NOT NULL,
  `lease_token` int NOT NULL,
  `reserved_tokens` int NOT NULL,
  `actual_tokens` int NULL,
  `status` varchar(16) NOT NULL,
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `completed_at` datetime(3) NULL,
  FOREIGN KEY (`run_id`) REFERENCES `sbl_ai_evolution_runs` (`id`),
  UNIQUE KEY `uq_evo_model_call` (`run_id`, `call_key`)
);
