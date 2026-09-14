-- Rename the persisted FDE workflow stage from “启动尽调” to “尽调”.
-- Keep completed and in-flight approvals operational by updating their stage keys only.
INSERT INTO `sbl_fde_workflow_policy_versions`
  (`id`,`policy_id`,`revision`,`status`,`configuration`,`sha256`,`reason`,`version`,`created_by`,`published_by`,`published_at`)
SELECT
  'b236f88b-7154-4551-a6f5-000000000115',
  `policy_id`,
  `revision` + 1,
  'published',
  REPLACE(CAST(`configuration` AS CHAR), '启动尽调', '尽调'),
  SHA2(REPLACE(CAST(`configuration` AS CHAR), '启动尽调', '尽调'), 256),
  '统一 FDE 尽调阶段名称',
  `version` + 1,
  `created_by`,
  `published_by`,
  CURRENT_TIMESTAMP(3)
FROM `sbl_fde_workflow_policy_versions`
WHERE `id`='b236f88b-7154-4551-a6f5-000000000114';
--> statement-breakpoint

UPDATE `sbl_fde_workflow_policies`
SET `active_version_id`='b236f88b-7154-4551-a6f5-000000000115', `next_revision`=`next_revision`+1, `version`=`version`+1
WHERE `id`='b236f88b-7154-4551-a6f5-000000000001';
--> statement-breakpoint

UPDATE `sbl_projects`
SET `workflow_policy_version_id`='b236f88b-7154-4551-a6f5-000000000115', `version`=`version`+1, `updated_at`=CURRENT_TIMESTAMP(3)
WHERE `workflow_model`='fde-v1' AND `project_type`='投资项目';
--> statement-breakpoint

UPDATE `sbl_projects`
SET `stage`='尽调', `version`=`version`+1, `updated_at`=CURRENT_TIMESTAMP(3)
WHERE `workflow_model`='fde-v1' AND `stage`='启动尽调';
--> statement-breakpoint

UPDATE `sbl_oa_approval_requests`
SET `from_stage`='尽调'
WHERE `from_stage`='启动尽调';
--> statement-breakpoint

UPDATE `sbl_oa_approval_requests`
SET `target_stage`='尽调'
WHERE `target_stage`='启动尽调';
--> statement-breakpoint

UPDATE `sbl_project_stage_dates`
SET `stage`='尽调'
WHERE `stage`='启动尽调';
--> statement-breakpoint

UPDATE `sbl_project_agent_schedule_requests`
SET `stage`='尽调'
WHERE `stage`='启动尽调';
--> statement-breakpoint

UPDATE `sbl_project_material_submissions`
SET `stage`='尽调'
WHERE `stage`='启动尽调';
--> statement-breakpoint

UPDATE `sbl_project_stage_materials`
SET `stage`='尽调'
WHERE `stage`='启动尽调';
--> statement-breakpoint

UPDATE `sbl_project_timeline_tasks`
SET `stage`='尽调'
WHERE `stage`='启动尽调';
