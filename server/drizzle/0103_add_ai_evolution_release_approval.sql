ALTER TABLE `sbl_ai_evolution_approvals`
  ADD COLUMN `purpose` varchar(24) NOT NULL DEFAULT 'candidate_review',
  ADD COLUMN `consumed_at` datetime(3) NULL;
