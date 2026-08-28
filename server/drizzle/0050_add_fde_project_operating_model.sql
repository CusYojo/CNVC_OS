ALTER TABLE `sbl_projects`
  ADD COLUMN `classification` varchar(16) NOT NULL DEFAULT 'normal' AFTER `stage_source`,
  ADD COLUMN `lifecycle` varchar(16) NOT NULL DEFAULT 'active' AFTER `classification`,
  ADD COLUMN `workflow_model` varchar(16) NOT NULL DEFAULT 'legacy' AFTER `lifecycle`,
  ADD COLUMN `project_type` varchar(32) NOT NULL DEFAULT '投资项目' AFTER `lifecycle`,
  ADD COLUMN `health_status` varchar(16) NOT NULL DEFAULT '正常' AFTER `project_type`,
  ADD COLUMN `target_date` varchar(10) AFTER `health_status`,
  ADD COLUMN `cycle_days` int NOT NULL DEFAULT 40 AFTER `target_date`,
  ADD COLUMN `requirements` text AFTER `cycle_days`,
  ADD COLUMN `investment_fund` varchar(128) AFTER `requirements`,
  ADD COLUMN `leader_priority` varchar(8) NOT NULL DEFAULT '中' AFTER `requirements`,
  ADD COLUMN `confidentiality` varchar(16) NOT NULL DEFAULT '项目成员' AFTER `leader_priority`,
  ADD CONSTRAINT `ck_projects_classification` CHECK (`classification` IN ('pool','normal','key')),
  ADD CONSTRAINT `ck_projects_lifecycle` CHECK (`lifecycle` IN ('active','closed','archived','deleted')),
  ADD CONSTRAINT `ck_projects_cycle_days` CHECK (`cycle_days` BETWEEN 7 AND 90),
  ADD INDEX `idx_projects_classification_lifecycle` (`classification`,`lifecycle`,`updated_at`),
  ADD INDEX `idx_projects_target_date` (`target_date`,`lifecycle`);
--> statement-breakpoint
UPDATE `sbl_projects` p
LEFT JOIN `sbl_leads` l ON l.`converted_project_id` = p.`id`
SET
  p.`classification` = CASE WHEN l.`id` IS NOT NULL AND p.`stage` = '线索' AND p.`latest_approval_id` IS NULL THEN 'pool' ELSE 'normal' END,
  p.`workflow_model` = CASE WHEN p.`classification` = 'pool' THEN 'fde-v1' ELSE 'legacy' END,
  p.`lifecycle` = CASE WHEN p.`stage` IN ('退出','放弃') THEN 'archived' ELSE 'active' END,
  p.`stage` = CASE WHEN p.`workflow_model` = 'fde-v1' THEN '入库' ELSE p.`stage` END,
  p.`progress` = CASE WHEN p.`workflow_model` = 'fde-v1' THEN 0 ELSE p.`progress` END;
--> statement-breakpoint
CREATE TABLE `sbl_project_classification_history` (
  `id` varchar(36) NOT NULL,
  `project_id` varchar(36) NOT NULL,
  `from_classification` varchar(16),
  `to_classification` varchar(16) NOT NULL,
  `reason` text NOT NULL,
  `changed_by` varchar(36),
  `changed_by_name` varchar(64) NOT NULL,
  `request_id` varchar(64),
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT `sbl_project_classification_history_id` PRIMARY KEY (`id`),
  CONSTRAINT `fk_project_classification_history_project` FOREIGN KEY (`project_id`) REFERENCES `sbl_projects` (`id`) ON DELETE cascade ON UPDATE no action,
  CONSTRAINT `fk_project_classification_history_actor` FOREIGN KEY (`changed_by`) REFERENCES `sbl_users` (`id`) ON DELETE set null ON UPDATE no action,
  CONSTRAINT `ck_project_classification_history_from` CHECK (`from_classification` IS NULL OR `from_classification` IN ('pool','normal','key')),
  CONSTRAINT `ck_project_classification_history_to` CHECK (`to_classification` IN ('pool','normal','key'))
);
--> statement-breakpoint
CREATE INDEX `idx_project_classification_history_project_time`
  ON `sbl_project_classification_history` (`project_id`,`created_at`);
--> statement-breakpoint
INSERT INTO `sbl_project_classification_history`
  (`id`,`project_id`,`from_classification`,`to_classification`,`reason`,`changed_by`,`changed_by_name`,`request_id`)
SELECT UUID(), p.`id`, NULL, p.`classification`, 'FDE 项目分类模型初始化', p.`created_by`, '系统迁移', NULL
FROM `sbl_projects` p;
--> statement-breakpoint
INSERT IGNORE INTO `sbl_permissions` (`id`,`code`,`name`,`module`,`action`) VALUES
  (UUID(),'project.classify','普通/重点项目分类','项目','classify');
--> statement-breakpoint
INSERT IGNORE INTO `sbl_role_permissions` (`role_id`,`permission_id`)
SELECT r.`id`, p.`id`
FROM `sbl_roles` r CROSS JOIN `sbl_permissions` p
WHERE r.`name` IN ('系统管理员','投资总监','董事长','总裁','投委会委员')
  AND p.`code`='project.classify';
--> statement-breakpoint
INSERT IGNORE INTO `sbl_dictionary_items` (`id`,`group_id`,`value`,`label`,`sort_order`,`built_in`)
SELECT UUID(), g.`id`, seed.`value`, seed.`label`, seed.`sort_order`, true
FROM `sbl_dictionary_groups` g JOIN (
  SELECT '入库' `value`, '入库' `label`, 5 `sort_order` UNION ALL
  SELECT '尽调计划制定', '尽调计划制定', 25 UNION ALL
  SELECT '尽调计划审核', '尽调计划审核', 30 UNION ALL
  SELECT '启动尽调', '启动尽调', 40 UNION ALL
  SELECT '内核', '内核', 50 UNION ALL
  SELECT '打款', '打款', 70 UNION ALL
  SELECT '已 Close', '已 Close', 80
) seed ON g.`code`='PROJECT_STAGE';
