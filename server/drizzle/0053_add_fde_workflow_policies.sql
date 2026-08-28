CREATE TABLE `sbl_fde_workflow_policies` (
  `id` varchar(36) NOT NULL PRIMARY KEY, `code` varchar(64) NOT NULL,
  `name` varchar(128) NOT NULL, `active_version_id` varchar(36),
  `enabled` boolean NOT NULL DEFAULT true, `version` int NOT NULL DEFAULT 1,
  `next_revision` int NOT NULL DEFAULT 2,
  UNIQUE KEY `uq_fde_policy_code` (`code`)
);
--> statement-breakpoint
CREATE TABLE `sbl_fde_workflow_policy_versions` (
  `id` varchar(36) NOT NULL PRIMARY KEY, `policy_id` varchar(36) NOT NULL,
  `revision` int NOT NULL, `status` varchar(16) NOT NULL DEFAULT 'draft',
  `configuration` json NOT NULL, `sha256` varchar(64) NOT NULL, `reason` text NOT NULL,
  `version` int NOT NULL DEFAULT 1, `created_by` varchar(36), `published_by` varchar(36),
  `published_at` datetime(3), `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT `fk_fde_policy_version_policy` FOREIGN KEY (`policy_id`) REFERENCES `sbl_fde_workflow_policies` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_fde_policy_version_creator` FOREIGN KEY (`created_by`) REFERENCES `sbl_users` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_fde_policy_version_publisher` FOREIGN KEY (`published_by`) REFERENCES `sbl_users` (`id`) ON DELETE SET NULL,
  CONSTRAINT `ck_fde_policy_status` CHECK (`status` IN ('draft','published')),
  UNIQUE KEY `uq_fde_policy_revision` (`policy_id`,`revision`)
);
--> statement-breakpoint
INSERT INTO `sbl_fde_workflow_policies` (`id`,`code`,`name`) VALUES ('b236f88b-7154-4551-a6f5-000000000001','investment','投资项目 · FDE 八阶段');
--> statement-breakpoint
INSERT INTO `sbl_fde_workflow_policy_versions` (`id`,`policy_id`,`revision`,`status`,`configuration`,`sha256`,`reason`,`published_at`)
VALUES ('b236f88b-7154-4551-a6f5-000000000002','b236f88b-7154-4551-a6f5-000000000001',1,'published','{"schemaVersion":1,"cycleDays":[15,30,40],"stages":[{"stage":"入库","materials":[],"allowWaiver":true,"requiresFund":false,"approvals":[]},{"stage":"立项","materials":[{"key":"business_plan","label":"商业计划书"},{"key":"initial_meeting","label":"初次交流纪要"}],"allowWaiver":true,"requiresFund":false,"approvals":[{"duty":"concerned_leader","name":"关注领导 · 立项","mode":"会签"}]},{"stage":"尽调计划制定","materials":[],"allowWaiver":true,"requiresFund":false,"approvals":[{"duty":"president","name":"总裁/计划审核职责 · 尽调计划制定","mode":"会签"}]},{"stage":"尽调计划审核","materials":[],"allowWaiver":true,"requiresFund":false,"approvals":[]},{"stage":"启动尽调","materials":[{"key":"business_dd","label":"业务尽调材料"},{"key":"financial_dd","label":"财务尽调材料"},{"key":"legal_dd","label":"法律尽调材料"}],"allowWaiver":true,"requiresFund":false,"approvals":[{"duty":"finance","name":"财务复核 · 启动尽调","mode":"会签"},{"duty":"legal","name":"法务/风控复核 · 启动尽调","mode":"会签"},{"duty":"concerned_leader","name":"关注领导 · 启动尽调","mode":"会签"}]},{"stage":"内核","materials":[{"key":"memo_draft","label":"投资说明书初稿"},{"key":"loi_draft","label":"投资意向书初稿"}],"allowWaiver":true,"requiresFund":true,"approvals":[{"duty":"finance","name":"财务复核 · 内核","mode":"会签"},{"duty":"legal","name":"法务/风控复核 · 内核","mode":"会签"},{"duty":"chairman","name":"董事长审批职责 · 内核","mode":"会签"},{"duty":"president","name":"总裁/计划审核职责 · 内核","mode":"会签"}]},{"stage":"投决","materials":[{"key":"memo_final","label":"投资说明书终稿"},{"key":"dd_report","label":"尽调报告"},{"key":"qa","label":"项目 Q&A"},{"key":"loi_final","label":"投资意向书终稿"}],"allowWaiver":true,"requiresFund":false,"approvals":[{"duty":"chairman","name":"董事长审批职责 · 投决","mode":"会签"},{"duty":"president","name":"总裁/计划审核职责 · 投决","mode":"会签"}]},{"stage":"打款","materials":[{"key":"ic_resolution","label":"投委会决议"},{"key":"payment_order","label":"打款单"}],"allowWaiver":true,"requiresFund":false,"approvals":[{"duty":"finance","name":"财务复核 · 打款","mode":"会签"},{"duty":"legal","name":"法务/风控复核 · 打款","mode":"会签"},{"duty":"chairman","name":"董事长审批职责 · 打款","mode":"会签"},{"duty":"president","name":"总裁/计划审核职责 · 打款","mode":"会签"}]}]}','3b2b964b058ade2ac49f88731c4e9b6c231715164de72ea256457db591ef2ff1','FDE 投资流程初始规则基线',CURRENT_TIMESTAMP(3));
--> statement-breakpoint
UPDATE `sbl_fde_workflow_policies` SET `active_version_id`='b236f88b-7154-4551-a6f5-000000000002' WHERE `code`='investment';
--> statement-breakpoint
ALTER TABLE `sbl_fde_workflow_policies` ADD CONSTRAINT `fk_fde_policy_active_version` FOREIGN KEY (`active_version_id`) REFERENCES `sbl_fde_workflow_policy_versions` (`id`) ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE `sbl_projects` ADD COLUMN `workflow_policy_version_id` varchar(36), ADD CONSTRAINT `fk_project_workflow_policy` FOREIGN KEY (`workflow_policy_version_id`) REFERENCES `sbl_fde_workflow_policy_versions` (`id`) ON DELETE RESTRICT;
--> statement-breakpoint
UPDATE `sbl_projects` SET `workflow_policy_version_id`='b236f88b-7154-4551-a6f5-000000000002' WHERE `workflow_model`='fde-v1';
