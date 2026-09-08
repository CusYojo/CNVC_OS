CREATE TABLE `sbl_ai_evolution_candidates` (
  `id` varchar(36) NOT NULL PRIMARY KEY,
  `run_id` varchar(36) NOT NULL,
  `kind` varchar(16) NOT NULL,
  `base_ref` varchar(128) NOT NULL,
  `content_hash` varchar(64) NOT NULL,
  `manifest` json NOT NULL,
  `summary` text NOT NULL,
  `status` varchar(24) NOT NULL,
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  FOREIGN KEY (`run_id`) REFERENCES `sbl_ai_evolution_runs` (`id`),
  UNIQUE KEY `uq_evo_candidate_run` (`run_id`)
);
CREATE TABLE `sbl_ai_evolution_evaluations` (
  `id` varchar(36) NOT NULL PRIMARY KEY,
  `candidate_id` varchar(36) NOT NULL,
  `candidate_hash` varchar(64) NOT NULL,
  `evaluation_hash` varchar(64) NOT NULL,
  `report` json NOT NULL,
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  FOREIGN KEY (`candidate_id`) REFERENCES `sbl_ai_evolution_candidates` (`id`),
  UNIQUE KEY `uq_evo_evaluation_candidate` (`candidate_id`)
);
CREATE TABLE `sbl_ai_evolution_approvals` (
  `id` varchar(36) NOT NULL PRIMARY KEY,
  `candidate_id` varchar(36) NOT NULL,
  `actor_user_id` varchar(36) NOT NULL,
  `candidate_hash` varchar(64) NOT NULL,
  `evaluation_hash` varchar(64) NOT NULL,
  `scope` json NOT NULL,
  `environment` varchar(128) NOT NULL,
  `decision` varchar(16) NOT NULL,
  `expires_at` datetime(3) NOT NULL,
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  FOREIGN KEY (`candidate_id`) REFERENCES `sbl_ai_evolution_candidates` (`id`),
  KEY `idx_evo_approval_candidate` (`candidate_id`, `created_at`)
);
