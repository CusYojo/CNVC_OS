-- Restore boss approval for the FDE transition from 立项 to 尽调计划制定.
-- Existing approval requests keep their persisted node snapshots.
INSERT INTO `sbl_fde_workflow_policy_versions`
  (`id`,`policy_id`,`revision`,`status`,`configuration`,`sha256`,`reason`,`version`,`created_by`,`published_by`,`published_at`)
SELECT
  'b236f88b-7154-4551-a6f5-000000000119',
  `policy_id`,
  5,
  'published',
  '{"schemaVersion":1,"cycleDays":[15,30,40],"stages":[{"stage":"入库","materials":[],"allowWaiver":true,"requiresFund":false,"approvals":[{"duty":"boss","name":"董事长/总裁审批 · 入库","mode":"或签"}]},{"stage":"立项","materials":[{"key":"business_plan","label":"商业计划书"},{"key":"initial_meeting","label":"初次交流纪要"}],"allowWaiver":true,"requiresFund":false,"approvals":[{"duty":"boss","name":"董事长/总裁审批 · 立项","mode":"或签"}]},{"stage":"尽调计划制定","materials":[],"allowWaiver":true,"requiresFund":false,"approvals":[{"duty":"boss","name":"董事长/总裁审批 · 尽调计划制定","mode":"或签"}]},{"stage":"尽调计划审核","materials":[],"allowWaiver":true,"requiresFund":false,"approvals":[]},{"stage":"尽调","materials":[{"key":"business_dd","label":"业务尽调材料"},{"key":"financial_dd","label":"财务尽调材料"},{"key":"legal_dd","label":"法律尽调材料"}],"allowWaiver":true,"requiresFund":false,"approvals":[{"duty":"boss","name":"董事长/总裁审批 · 尽调","mode":"或签"}]},{"stage":"内核","materials":[{"key":"memo_draft","label":"投资说明书初稿"},{"key":"loi_draft","label":"投资意向书初稿"}],"allowWaiver":true,"requiresFund":true,"approvals":[{"duty":"finance","name":"财务复核 · 内核","mode":"或签"},{"duty":"legal","name":"法务/风控复核 · 内核","mode":"或签"},{"duty":"boss","name":"董事长/总裁审批 · 内核","mode":"或签"}]},{"stage":"投决","materials":[{"key":"memo_final","label":"投资说明书终稿"},{"key":"dd_report","label":"尽调报告"},{"key":"qa","label":"项目 Q&A"},{"key":"loi_final","label":"投资意向书终稿"}],"allowWaiver":true,"requiresFund":false,"approvals":[{"duty":"chairman","name":"董事长审批职责 · 投决","mode":"会签"},{"duty":"president","name":"总裁/计划审核职责 · 投决","mode":"会签"}]},{"stage":"打款","materials":[{"key":"ic_resolution","label":"投委会决议"},{"key":"payment_order","label":"打款单"}],"allowWaiver":true,"requiresFund":false,"approvals":[{"duty":"finance","name":"财务复核 · 打款","mode":"或签"}]},{"stage":"投后","materials":[],"allowWaiver":true,"requiresFund":false,"approvals":[]}]}',
  '10d1f28b8e1a9bd01e20e1ee70df0877aecf55d8bb50abb37b742f56fabe8a64',
  '恢复立项进入尽调计划制定前的老板审批',
  `version` + 1,
  `created_by`,
  `published_by`,
  CURRENT_TIMESTAMP(3)
FROM `sbl_fde_workflow_policy_versions`
WHERE `id`='b236f88b-7154-4551-a6f5-000000000117';
--> statement-breakpoint

UPDATE `sbl_fde_workflow_policies`
SET `active_version_id`='b236f88b-7154-4551-a6f5-000000000119', `next_revision`=6, `version`=`version`+1
WHERE `id`='b236f88b-7154-4551-a6f5-000000000001';
--> statement-breakpoint

UPDATE `sbl_projects`
SET `workflow_policy_version_id`='b236f88b-7154-4551-a6f5-000000000119', `version`=`version`+1, `updated_at`=CURRENT_TIMESTAMP(3)
WHERE `workflow_model`='fde-v1' AND `project_type`='投资项目';
