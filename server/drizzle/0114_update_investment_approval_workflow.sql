-- Publish the revised investment approval workflow for all FDE investment projects.
-- Existing approval requests keep their persisted node snapshots and are not rewritten.
INSERT INTO `sbl_fde_workflow_policy_versions` (`id`,`policy_id`,`revision`,`status`,`configuration`,`sha256`,`reason`,`published_at`)
VALUES (
  'b236f88b-7154-4551-a6f5-000000000114',
  'b236f88b-7154-4551-a6f5-000000000001',
  2,
  'published',
  '{"schemaVersion":1,"cycleDays":[15,30,40],"stages":[{"stage":"入库","materials":[],"allowWaiver":true,"requiresFund":false,"approvals":[{"duty":"boss","name":"董事长/总裁审批 · 入库","mode":"或签"}]},{"stage":"立项","materials":[{"key":"business_plan","label":"商业计划书"},{"key":"initial_meeting","label":"初次交流纪要"}],"allowWaiver":true,"requiresFund":false,"approvals":[]},{"stage":"尽调计划制定","materials":[],"allowWaiver":true,"requiresFund":false,"approvals":[{"duty":"boss","name":"董事长/总裁审批 · 尽调计划制定","mode":"或签"}]},{"stage":"尽调计划审核","materials":[],"allowWaiver":true,"requiresFund":false,"approvals":[]},{"stage":"启动尽调","materials":[{"key":"business_dd","label":"业务尽调材料"},{"key":"financial_dd","label":"财务尽调材料"},{"key":"legal_dd","label":"法律尽调材料"}],"allowWaiver":true,"requiresFund":false,"approvals":[{"duty":"boss","name":"董事长/总裁审批 · 启动尽调","mode":"或签"}]},{"stage":"内核","materials":[{"key":"memo_draft","label":"投资说明书初稿"},{"key":"loi_draft","label":"投资意向书初稿"}],"allowWaiver":true,"requiresFund":true,"approvals":[{"duty":"finance","name":"财务复核 · 内核","mode":"或签"},{"duty":"legal","name":"法务/风控复核 · 内核","mode":"或签"},{"duty":"boss","name":"董事长/总裁审批 · 内核","mode":"或签"}]},{"stage":"投决","materials":[{"key":"memo_final","label":"投资说明书终稿"},{"key":"dd_report","label":"尽调报告"},{"key":"qa","label":"项目 Q&A"},{"key":"loi_final","label":"投资意向书终稿"}],"allowWaiver":true,"requiresFund":false,"approvals":[{"duty":"chairman","name":"董事长审批职责 · 投决","mode":"会签"},{"duty":"president","name":"总裁/计划审核职责 · 投决","mode":"会签"}]},{"stage":"打款","materials":[{"key":"ic_resolution","label":"投委会决议"},{"key":"payment_order","label":"打款单"}],"allowWaiver":true,"requiresFund":false,"approvals":[{"duty":"finance","name":"财务复核 · 打款","mode":"或签"}]}]}',
  '25baaada056a9743055eda3f6b50e108b568d5bd59e28d34418b30e050a9920a',
  '投资项目审批规则调整：老板或签、投决双签、内核串行、打款财务审批',
  CURRENT_TIMESTAMP(3)
);
--> statement-breakpoint

UPDATE `sbl_fde_workflow_policies`
SET `active_version_id`='b236f88b-7154-4551-a6f5-000000000114', `next_revision`=3, `version`=`version`+1, `updated_at`=CURRENT_TIMESTAMP(3)
WHERE `id`='b236f88b-7154-4551-a6f5-000000000001';
--> statement-breakpoint

UPDATE `sbl_projects`
SET `workflow_policy_version_id`='b236f88b-7154-4551-a6f5-000000000114', `version`=`version`+1, `updated_at`=CURRENT_TIMESTAMP(3)
WHERE `workflow_model`='fde-v1' AND `project_type`='投资项目';
