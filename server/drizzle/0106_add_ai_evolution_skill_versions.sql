CREATE TABLE `sbl_ai_evolution_skill_versions` (
  `id` varchar(36) NOT NULL PRIMARY KEY,
  `capability_id` varchar(36) NOT NULL,
  `owner_user_id` varchar(36) NOT NULL,
  `run_id` varchar(36) NOT NULL,
  `candidate_id` varchar(36) NULL,
  `content_hash` varchar(64) NOT NULL,
  `content` json NOT NULL,
  `package_hash` varchar(64) NOT NULL,
  `package_artifact` json NOT NULL,
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  FOREIGN KEY (`run_id`) REFERENCES `sbl_ai_evolution_runs` (`id`),
  FOREIGN KEY (`candidate_id`) REFERENCES `sbl_ai_evolution_candidates` (`id`),
  UNIQUE KEY `uq_evo_skill_content` (`capability_id`, `content_hash`, `package_hash`)
);
--> statement-breakpoint
CREATE TABLE `sbl_ai_evolution_skill_bindings` (
  `id` varchar(36) NOT NULL PRIMARY KEY,
  `capability_id` varchar(36) NOT NULL,
  `scope_type` varchar(24) NOT NULL,
  `scope_key` varchar(128) NOT NULL,
  `active_version_id` varchar(36) NOT NULL,
  `fallback_version_id` varchar(36) NULL,
  `trial_expires_at` datetime(3) NULL,
  `revision` int NOT NULL DEFAULT 1,
  `updated_by` varchar(36) NOT NULL,
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  FOREIGN KEY (`active_version_id`) REFERENCES `sbl_ai_evolution_skill_versions` (`id`),
  FOREIGN KEY (`fallback_version_id`) REFERENCES `sbl_ai_evolution_skill_versions` (`id`),
  UNIQUE KEY `uq_evo_skill_scope` (`capability_id`, `scope_type`, `scope_key`)
);
--> statement-breakpoint
CREATE TABLE `sbl_ai_evolution_skill_binding_changes` (
  `id` varchar(36) NOT NULL PRIMARY KEY,
  `binding_id` varchar(36) NOT NULL,
  `actor_user_id` varchar(36) NOT NULL,
  `operation` varchar(24) NOT NULL,
  `idempotency_key` varchar(128) NOT NULL,
  `input_hash` varchar(64) NOT NULL,
  `previous_version_id` varchar(36) NULL,
  `next_version_id` varchar(36) NOT NULL,
  `revision` int NOT NULL,
  `approval_id` varchar(36) NULL,
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  FOREIGN KEY (`binding_id`) REFERENCES `sbl_ai_evolution_skill_bindings` (`id`),
  FOREIGN KEY (`previous_version_id`) REFERENCES `sbl_ai_evolution_skill_versions` (`id`),
  FOREIGN KEY (`next_version_id`) REFERENCES `sbl_ai_evolution_skill_versions` (`id`),
  FOREIGN KEY (`approval_id`) REFERENCES `sbl_ai_evolution_approvals` (`id`),
  UNIQUE KEY `uq_evo_skill_change_request` (`actor_user_id`, `idempotency_key`),
  UNIQUE KEY `uq_evo_skill_change_revision` (`binding_id`, `revision`)
);
