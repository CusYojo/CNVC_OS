-- Execute only through the existing explicit migration workflow; never on application startup.
CREATE TABLE `sbl_ai_evolution_proposals` (
  `id` varchar(36) NOT NULL PRIMARY KEY,
  `owner_user_id` varchar(36) NOT NULL,
  `kind` varchar(16) NOT NULL,
  `spec` json NOT NULL,
  `spec_hash` varchar(64) NOT NULL,
  `status` varchar(24) NOT NULL,
  `revision` int NOT NULL DEFAULT 1,
  `idempotency_key` varchar(128) NOT NULL,
  `create_input_hash` varchar(64) NOT NULL,
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY `uq_evo_proposal_create` (`owner_user_id`, `idempotency_key`),
  KEY `idx_evo_proposal_owner` (`owner_user_id`, `created_at`)
);
--> statement-breakpoint
CREATE TABLE `sbl_ai_evolution_runs` (
  `id` varchar(36) NOT NULL PRIMARY KEY,
  `proposal_id` varchar(36) NOT NULL,
  `owner_user_id` varchar(36) NOT NULL,
  `input_hash` varchar(64) NOT NULL,
  `frozen_spec` json NOT NULL,
  `idempotency_key` varchar(128) NOT NULL,
  `status` varchar(24) NOT NULL,
  `stage` varchar(64) NOT NULL,
  `attempt` int NOT NULL DEFAULT 0,
  `lease_token` int NOT NULL DEFAULT 0,
  `lease_owner` varchar(128) NULL,
  `lease_expires_at` datetime(3) NULL,
  `budget` json NOT NULL,
  `model_tokens` int NULL,
  `elapsed_seconds` int NOT NULL DEFAULT 0,
  `repair_rounds` int NOT NULL DEFAULT 0,
  `checkpoint` json NULL,
  `cancel_requested_at` datetime(3) NULL,
  `error` json NULL,
  `next_event_sequence` int NOT NULL DEFAULT 1,
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  FOREIGN KEY (`proposal_id`) REFERENCES `sbl_ai_evolution_proposals` (`id`),
  UNIQUE KEY `uq_evo_run_execute` (`owner_user_id`, `idempotency_key`),
  KEY `idx_evo_run_queue` (`status`, `created_at`),
  KEY `idx_evo_run_lease` (`status`, `lease_expires_at`),
  KEY `idx_evo_run_proposal` (`proposal_id`)
);
--> statement-breakpoint
CREATE TABLE `sbl_ai_evolution_events` (
  `id` varchar(36) NOT NULL PRIMARY KEY,
  `run_id` varchar(36) NOT NULL,
  `sequence` int NOT NULL,
  `event_type` varchar(64) NOT NULL,
  `payload` json NOT NULL,
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  FOREIGN KEY (`run_id`) REFERENCES `sbl_ai_evolution_runs` (`id`),
  UNIQUE KEY `uq_evo_event_sequence` (`run_id`, `sequence`)
);
--> statement-breakpoint
CREATE TABLE `sbl_ai_evolution_audits` (
  `id` varchar(36) NOT NULL PRIMARY KEY,
  `actor_user_id` varchar(36) NOT NULL,
  `proposal_id` varchar(36) NOT NULL,
  `action` varchar(64) NOT NULL,
  `content_hash` varchar(64) NOT NULL,
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  FOREIGN KEY (`proposal_id`) REFERENCES `sbl_ai_evolution_proposals` (`id`),
  KEY `idx_evo_audit_proposal` (`proposal_id`, `created_at`)
);
