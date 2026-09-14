-- The policy integrity check hashes canonical JSON (recursively sorted object keys).
-- Correct the hash produced by the stage-rename migration for both existing and fresh databases.
UPDATE `sbl_fde_workflow_policy_versions`
SET `sha256`='19bcf749e8b981f94b6ced1969dac8f35cdd751b80b2970174c9c97ff32b556e', `updated_at`=CURRENT_TIMESTAMP(3)
WHERE `id`='b236f88b-7154-4551-a6f5-000000000115';
