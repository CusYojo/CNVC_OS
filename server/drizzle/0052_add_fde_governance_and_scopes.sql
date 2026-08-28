ALTER TABLE `sbl_roles` ADD COLUMN `fde_category` varchar(32);
--> statement-breakpoint
ALTER TABLE `sbl_projects` ADD COLUMN `governance_version` int NOT NULL DEFAULT 1;
--> statement-breakpoint
UPDATE `sbl_roles` SET `fde_category` = CASE
  WHEN `code`='INVESTMENT_DIRECTOR' THEN 'project_lead'
  WHEN `code`='INVESTMENT_MANAGER' THEN 'member'
  WHEN `code`='RISK_LEGAL' THEN 'specialist'
  WHEN `code`='IC_SECRETARY' THEN 'secretary'
  WHEN `code`='POST_INVESTMENT' THEN 'member'
  WHEN `code` IN ('SYSTEM_ADMIN','AI_PLATFORM_ADMIN') THEN 'system_admin'
  ELSE NULL END;
--> statement-breakpoint
INSERT IGNORE INTO `sbl_roles` (`id`,`code`,`name`,`description`,`data_scope`,`fde_category`,`built_in`) VALUES
  (UUID(),'FDE_CHAIRMAN','董事长','FDE 机构领导与董事长审批职责','all','institution_leader',true),
  (UUID(),'FDE_PRESIDENT','总裁','FDE 机构领导与计划审核职责','all','institution_leader',true),
  (UUID(),'FDE_PROJECT_LEAD','项目负责人','FDE 项目负责职责','self','project_lead',true),
  (UUID(),'FDE_SECRETARY','推进秘书','FDE 项目协同推进职责','self','secretary',true),
  (UUID(),'FDE_COORDINATOR','时间协调人','FDE 领导时间协调职责','self','coordinator',true),
  (UUID(),'FDE_FINANCE','财务','FDE 被分配项目的财务复核','self','specialist',true),
  (UUID(),'FDE_LEGAL','法务','FDE 被分配项目的法律复核','self','specialist',true);
--> statement-breakpoint
UPDATE `sbl_roles` SET `fde_category`='institution_leader', `data_scope`='all' WHERE `name` IN ('董事长','总裁');
--> statement-breakpoint
UPDATE `sbl_roles` SET `fde_category`='specialist' WHERE `name` IN ('财务','法务');
--> statement-breakpoint
UPDATE `sbl_roles` SET `code`=CASE `name` WHEN '董事长' THEN 'FDE_CHAIRMAN' WHEN '总裁' THEN 'FDE_PRESIDENT' WHEN '财务' THEN 'FDE_FINANCE' WHEN '法务' THEN 'FDE_LEGAL' ELSE `code` END WHERE `name` IN ('董事长','总裁','财务','法务');
--> statement-breakpoint
UPDATE `sbl_roles` SET `data_scope`='self' WHERE `code` IN ('RISK_LEGAL','IC_SECRETARY','POST_INVESTMENT');
--> statement-breakpoint
INSERT IGNORE INTO `sbl_permissions` (`id`,`code`,`name`,`module`,`action`) VALUES
  (UUID(),'fde.project.read','FDE 项目业务查看','FDE 项目','read'),
  (UUID(),'fde.governance.manage','FDE 项目治理与职责','FDE 项目','governance'),
  (UUID(),'fde.time.coordinate','FDE 领导时间协调','FDE 协同','coordinate');
--> statement-breakpoint
INSERT IGNORE INTO `sbl_role_permissions` (`role_id`,`permission_id`)
SELECT r.`id`,p.`id` FROM `sbl_roles` r JOIN `sbl_permissions` p ON p.`code`='fde.project.read'
WHERE r.`fde_category` IS NOT NULL AND r.`fde_category`<>'system_admin';
--> statement-breakpoint
INSERT IGNORE INTO `sbl_role_permissions` (`role_id`,`permission_id`)
SELECT r.`id`,p.`id` FROM `sbl_roles` r JOIN `sbl_permissions` p ON p.`code` IN ('fde.governance.manage','project.classify')
WHERE r.`fde_category`='institution_leader';
--> statement-breakpoint
INSERT IGNORE INTO `sbl_role_permissions` (`role_id`,`permission_id`)
SELECT r.`id`,p.`id` FROM `sbl_roles` r JOIN `sbl_permissions` p ON p.`code`='fde.time.coordinate'
WHERE r.`fde_category`='coordinator';
--> statement-breakpoint
DELETE rp FROM `sbl_role_permissions` rp JOIN `sbl_roles` r ON r.`id`=rp.`role_id` JOIN `sbl_permissions` p ON p.`id`=rp.`permission_id`
WHERE r.`fde_category`='system_admin' AND p.`code`='project.classify';
--> statement-breakpoint
CREATE TABLE `sbl_project_duty_assignments` (
  `id` varchar(36) NOT NULL, `project_id` varchar(36) NOT NULL, `duty` varchar(32) NOT NULL,
  `user_id` varchar(36) NOT NULL, `assigned_by` varchar(36) NOT NULL,
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  CONSTRAINT `fk_fde_duty_project` FOREIGN KEY (`project_id`) REFERENCES `sbl_projects` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_fde_duty_user` FOREIGN KEY (`user_id`) REFERENCES `sbl_users` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_fde_duty_actor` FOREIGN KEY (`assigned_by`) REFERENCES `sbl_users` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `ck_fde_duty` CHECK (`duty` IN ('secretary','member','coordinator','finance','legal','concerned_leader','chairman','president')),
  UNIQUE KEY `uq_project_duty_assignment` (`project_id`,`duty`,`user_id`),
  KEY `idx_project_duty_user` (`user_id`,`project_id`)
);
--> statement-breakpoint
CREATE TABLE `sbl_project_governance_changes` (
  `id` varchar(36) NOT NULL, `project_id` varchar(36) NOT NULL, `base_version` int NOT NULL,
  `proposed_owner_id` varchar(36) NOT NULL, `proposed_assignments` json NOT NULL,
  `previous_snapshot` json NOT NULL, `reason` text NOT NULL, `status` varchar(32) NOT NULL,
  `active_key` varchar(36), `requested_by` varchar(36) NOT NULL,
  `required_confirmers` json NOT NULL, `confirmations` json NOT NULL,
  `version` int NOT NULL DEFAULT 1,
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), `applied_at` datetime(3),
  PRIMARY KEY (`id`),
  CONSTRAINT `fk_fde_governance_project` FOREIGN KEY (`project_id`) REFERENCES `sbl_projects` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_fde_governance_owner` FOREIGN KEY (`proposed_owner_id`) REFERENCES `sbl_users` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_fde_governance_actor` FOREIGN KEY (`requested_by`) REFERENCES `sbl_users` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `ck_fde_governance_status` CHECK (`status` IN ('awaiting_confirmation','applied','rejected','cancelled')),
  UNIQUE KEY `uq_project_governance_pending` (`active_key`),
  KEY `idx_project_governance_history` (`project_id`,`created_at`)
);
--> statement-breakpoint
INSERT INTO `sbl_project_duty_assignments` (`id`,`project_id`,`duty`,`user_id`,`assigned_by`)
SELECT UUID(),m.`project_id`,'member',m.`user_id`,COALESCE(p.`owner_user_id`,p.`created_by`,m.`user_id`)
FROM `sbl_project_members` m JOIN `sbl_projects` p ON p.`id`=m.`project_id`
WHERE p.`workflow_model`='fde-v1' AND m.`member_role`<>'owner';
