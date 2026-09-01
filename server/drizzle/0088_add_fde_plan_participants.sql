ALTER TABLE `sbl_project_plan_actions`
  ADD COLUMN `participant_user_ids` json NOT NULL DEFAULT (JSON_ARRAY());
--> statement-breakpoint
UPDATE `sbl_project_plan_actions`
SET `participant_user_ids` = JSON_ARRAY(`owner_user_id`)
WHERE JSON_LENGTH(`participant_user_ids`) = 0;
