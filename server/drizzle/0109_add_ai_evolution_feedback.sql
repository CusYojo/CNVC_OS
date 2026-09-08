CREATE TABLE `sbl_ai_evolution_feedback` (
  `id` varchar(36) NOT NULL PRIMARY KEY,
  `owner_user_id` varchar(36) NOT NULL,
  `candidate_id` varchar(36) NULL,
  `application_id` varchar(36) NULL,
  `feedback_type` varchar(32) NOT NULL,
  `comment` text NOT NULL,
  `evidence_refs` json NOT NULL DEFAULT (JSON_ARRAY()),
  `content_hash` varchar(64) NOT NULL,
  `idempotency_key` varchar(128) NOT NULL,
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT `chk_evo_feedback_subject` CHECK ((`candidate_id` IS NULL) <> (`application_id` IS NULL)),
  CONSTRAINT `fk_evo_feedback_candidate` FOREIGN KEY (`candidate_id`) REFERENCES `sbl_ai_evolution_candidates` (`id`),
  CONSTRAINT `fk_evo_feedback_application` FOREIGN KEY (`application_id`) REFERENCES `sbl_ai_evolution_applications` (`id`),
  UNIQUE KEY `uq_evo_feedback_request` (`owner_user_id`, `idempotency_key`),
  KEY `idx_evo_feedback_candidate` (`candidate_id`, `created_at`),
  KEY `idx_evo_feedback_application` (`application_id`, `created_at`)
);
