CREATE TABLE `sbl_departments` (
	`id` varchar(36) NOT NULL,
	`code` varchar(64) NOT NULL,
	`name` varchar(64) NOT NULL,
	`parent_id` varchar(36),
	`manager_user_id` varchar(36),
	`description` text,
	`status` varchar(8) NOT NULL DEFAULT '启用',
	`sort_order` int NOT NULL DEFAULT 0,
	`version` int NOT NULL DEFAULT 1,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `sbl_departments_id` PRIMARY KEY(`id`),
	CONSTRAINT `fk_departments_parent` FOREIGN KEY (`parent_id`) REFERENCES `sbl_departments`(`id`) ON DELETE restrict ON UPDATE no action,
	CONSTRAINT `fk_departments_manager` FOREIGN KEY (`manager_user_id`) REFERENCES `sbl_users`(`id`) ON DELETE set null ON UPDATE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_departments_code` ON `sbl_departments` (`code`);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_departments_name` ON `sbl_departments` (`name`);
--> statement-breakpoint
CREATE INDEX `idx_departments_parent` ON `sbl_departments` (`parent_id`,`sort_order`);
--> statement-breakpoint
CREATE TABLE `sbl_roles` (
	`id` varchar(36) NOT NULL,
	`code` varchar(64) NOT NULL,
	`name` varchar(64) NOT NULL,
	`description` text,
	`data_scope` varchar(16) NOT NULL DEFAULT 'self',
	`built_in` boolean NOT NULL DEFAULT false,
	`status` varchar(8) NOT NULL DEFAULT '启用',
	`version` int NOT NULL DEFAULT 1,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `sbl_roles_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_roles_code` ON `sbl_roles` (`code`);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_roles_name` ON `sbl_roles` (`name`);
--> statement-breakpoint
CREATE TABLE `sbl_permissions` (
	`id` varchar(36) NOT NULL,
	`code` varchar(96) NOT NULL,
	`name` varchar(64) NOT NULL,
	`module` varchar(32) NOT NULL,
	`action` varchar(32) NOT NULL,
	`description` text,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `sbl_permissions_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_permissions_code` ON `sbl_permissions` (`code`);
--> statement-breakpoint
CREATE INDEX `idx_permissions_module` ON `sbl_permissions` (`module`,`action`);
--> statement-breakpoint
CREATE TABLE `sbl_role_permissions` (
	`role_id` varchar(36) NOT NULL,
	`permission_id` varchar(36) NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `fk_role_permissions_role` FOREIGN KEY (`role_id`) REFERENCES `sbl_roles`(`id`) ON DELETE cascade ON UPDATE no action,
	CONSTRAINT `fk_role_permissions_permission` FOREIGN KEY (`permission_id`) REFERENCES `sbl_permissions`(`id`) ON DELETE cascade ON UPDATE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_role_permissions_binding` ON `sbl_role_permissions` (`role_id`,`permission_id`);
--> statement-breakpoint
CREATE INDEX `idx_role_permissions_permission` ON `sbl_role_permissions` (`permission_id`,`role_id`);
--> statement-breakpoint
CREATE TABLE `sbl_user_roles` (
	`user_id` varchar(36) NOT NULL,
	`role_id` varchar(36) NOT NULL,
	`is_primary` boolean NOT NULL DEFAULT true,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `fk_user_roles_user` FOREIGN KEY (`user_id`) REFERENCES `sbl_users`(`id`) ON DELETE cascade ON UPDATE no action,
	CONSTRAINT `fk_user_roles_role` FOREIGN KEY (`role_id`) REFERENCES `sbl_roles`(`id`) ON DELETE restrict ON UPDATE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_user_roles_binding` ON `sbl_user_roles` (`user_id`,`role_id`);
--> statement-breakpoint
CREATE INDEX `idx_user_roles_role` ON `sbl_user_roles` (`role_id`,`user_id`);
--> statement-breakpoint
CREATE TABLE `sbl_user_departments` (
	`user_id` varchar(36) NOT NULL,
	`department_id` varchar(36) NOT NULL,
	`is_primary` boolean NOT NULL DEFAULT true,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `fk_user_departments_user` FOREIGN KEY (`user_id`) REFERENCES `sbl_users`(`id`) ON DELETE cascade ON UPDATE no action,
	CONSTRAINT `fk_user_departments_department` FOREIGN KEY (`department_id`) REFERENCES `sbl_departments`(`id`) ON DELETE restrict ON UPDATE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_user_departments_binding` ON `sbl_user_departments` (`user_id`,`department_id`);
--> statement-breakpoint
CREATE INDEX `idx_user_departments_department` ON `sbl_user_departments` (`department_id`,`user_id`);
--> statement-breakpoint
CREATE TABLE `sbl_dictionary_groups` (
	`id` varchar(36) NOT NULL,
	`code` varchar(64) NOT NULL,
	`name` varchar(64) NOT NULL,
	`description` text,
	`status` varchar(8) NOT NULL DEFAULT '启用',
	`version` int NOT NULL DEFAULT 1,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `sbl_dictionary_groups_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_dictionary_groups_code` ON `sbl_dictionary_groups` (`code`);
--> statement-breakpoint
CREATE TABLE `sbl_dictionary_items` (
	`id` varchar(36) NOT NULL,
	`group_id` varchar(36) NOT NULL,
	`value` varchar(128) NOT NULL,
	`label` varchar(128) NOT NULL,
	`sort_order` int NOT NULL DEFAULT 0,
	`status` varchar(8) NOT NULL DEFAULT '启用',
	`built_in` boolean NOT NULL DEFAULT false,
	`version` int NOT NULL DEFAULT 1,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `sbl_dictionary_items_id` PRIMARY KEY(`id`),
	CONSTRAINT `fk_dictionary_items_group` FOREIGN KEY (`group_id`) REFERENCES `sbl_dictionary_groups`(`id`) ON DELETE restrict ON UPDATE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_dictionary_items_group_value` ON `sbl_dictionary_items` (`group_id`,`value`);
--> statement-breakpoint
CREATE INDEX `idx_dictionary_items_group_order` ON `sbl_dictionary_items` (`group_id`,`sort_order`);
--> statement-breakpoint

INSERT INTO `sbl_departments` (`id`,`code`,`name`,`sort_order`)
SELECT UUID(), CONCAT('LEGACY_', UPPER(SUBSTRING(SHA2(`department`,256),1,16))), `department`, ROW_NUMBER() OVER (ORDER BY `department`)
FROM (SELECT DISTINCT `department` FROM `sbl_users` WHERE TRIM(`department`) <> '') legacy_departments;
--> statement-breakpoint
INSERT IGNORE INTO `sbl_roles` (`id`,`code`,`name`,`description`,`data_scope`,`built_in`)
VALUES
  (UUID(),'INVESTMENT_MANAGER','投资经理','项目执行与AI业务使用','self',true),
  (UUID(),'INVESTMENT_DIRECTOR','投资总监','团队项目管理与审批','department',true),
  (UUID(),'RISK_LEGAL','风控与法务','风险与合规管理','department',true),
  (UUID(),'IC_SECRETARY','投委会秘书','投委会流程管理','all',true),
  (UUID(),'POST_INVESTMENT','投后管理组','投后业务管理','department',true),
  (UUID(),'AI_PLATFORM_ADMIN','AI 平台管理员','模型与能力配置','all',true),
  (UUID(),'SYSTEM_ADMIN','系统管理员','系统全局管理','all',true);
--> statement-breakpoint
INSERT IGNORE INTO `sbl_roles` (`id`,`code`,`name`,`description`,`data_scope`,`built_in`)
SELECT UUID(), CONCAT('LEGACY_', UPPER(SUBSTRING(SHA2(`role`,256),1,16))), `role`, '从 users.role 回填的迁移角色', 'self', true
FROM (SELECT DISTINCT `role` FROM `sbl_users` WHERE TRIM(`role`) <> '') legacy_roles;
--> statement-breakpoint
INSERT INTO `sbl_permissions` (`id`,`code`,`name`,`module`,`action`) VALUES
  (UUID(),'project.read','项目查看','项目','read'),
  (UUID(),'project.write','项目新增与编辑','项目','write'),
  (UUID(),'project.valuation.read','敏感估值字段','项目','valuation_read'),
  (UUID(),'ai.use','AI 问答与摘要','AI','use'),
  (UUID(),'material.manage','材料生成与下载','材料','manage'),
  (UUID(),'risk.manage','风险处置','风险','manage'),
  (UUID(),'system.manage','系统配置','系统','manage');
--> statement-breakpoint
INSERT INTO `sbl_role_permissions` (`role_id`,`permission_id`)
SELECT r.id, p.id FROM `sbl_roles` r CROSS JOIN `sbl_permissions` p WHERE r.name='系统管理员';
--> statement-breakpoint
INSERT IGNORE INTO `sbl_role_permissions` (`role_id`,`permission_id`)
SELECT r.id, p.id FROM `sbl_roles` r JOIN `sbl_permissions` p ON p.code IN ('project.read','project.write','ai.use','material.manage')
WHERE r.name IN ('投资经理','投资总监');
--> statement-breakpoint
INSERT IGNORE INTO `sbl_role_permissions` (`role_id`,`permission_id`)
SELECT r.id, p.id FROM `sbl_roles` r JOIN `sbl_permissions` p ON p.code IN ('project.read','project.valuation.read','risk.manage')
WHERE r.name='风控与法务';
--> statement-breakpoint
INSERT INTO `sbl_user_roles` (`user_id`,`role_id`,`is_primary`)
SELECT u.id, r.id, true FROM `sbl_users` u JOIN `sbl_roles` r ON r.name=u.role;
--> statement-breakpoint
INSERT INTO `sbl_user_departments` (`user_id`,`department_id`,`is_primary`)
SELECT u.id, d.id, true FROM `sbl_users` u JOIN `sbl_departments` d ON d.name=u.department;
--> statement-breakpoint
INSERT INTO `sbl_dictionary_groups` (`id`,`code`,`name`,`description`) VALUES
  (UUID(),'PROJECT_STAGE','项目阶段','项目生命周期阶段'),
  (UUID(),'FINANCING_ROUND','融资轮次','企业融资轮次'),
  (UUID(),'RISK_LEVEL','风险等级','项目风险等级'),
  (UUID(),'PROJECT_SOURCE','项目来源','项目获取渠道'),
  (UUID(),'MEETING_TYPE','会议类型','业务会议分类');
--> statement-breakpoint
INSERT INTO `sbl_dictionary_items` (`id`,`group_id`,`value`,`label`,`sort_order`,`built_in`)
SELECT UUID(), g.id, seed.value, seed.label, seed.sort_order, true
FROM `sbl_dictionary_groups` g JOIN (
  SELECT 'PROJECT_STAGE' code,'线索' value,'线索' label,10 sort_order UNION ALL
  SELECT 'PROJECT_STAGE','初筛','初筛',20 UNION ALL SELECT 'PROJECT_STAGE','立项','立项',30 UNION ALL
  SELECT 'PROJECT_STAGE','尽调','尽调',40 UNION ALL SELECT 'PROJECT_STAGE','上会','上会',50 UNION ALL
  SELECT 'PROJECT_STAGE','投决','投决',60 UNION ALL SELECT 'PROJECT_STAGE','投后','投后',70 UNION ALL
  SELECT 'PROJECT_STAGE','退出','退出',80 UNION ALL SELECT 'PROJECT_STAGE','放弃','放弃',90 UNION ALL
  SELECT 'FINANCING_ROUND','天使轮','天使轮',10 UNION ALL SELECT 'FINANCING_ROUND','Pre-A','Pre-A',20 UNION ALL
  SELECT 'FINANCING_ROUND','A 轮','A 轮',30 UNION ALL SELECT 'FINANCING_ROUND','B 轮','B 轮',40 UNION ALL
  SELECT 'FINANCING_ROUND','C 轮','C 轮',50 UNION ALL SELECT 'FINANCING_ROUND','Pre-IPO','Pre-IPO',60 UNION ALL
  SELECT 'RISK_LEVEL','低','低',10 UNION ALL SELECT 'RISK_LEVEL','中','中',20 UNION ALL SELECT 'RISK_LEVEL','高','高',30 UNION ALL
  SELECT 'PROJECT_SOURCE','机构推荐','机构推荐',10 UNION ALL SELECT 'PROJECT_SOURCE','FA','FA',20 UNION ALL
  SELECT 'PROJECT_SOURCE','BP 邮箱','BP 邮箱',30 UNION ALL SELECT 'PROJECT_SOURCE','行业会议','行业会议',40 UNION ALL
  SELECT 'PROJECT_SOURCE','产业方推荐','产业方推荐',50 UNION ALL SELECT 'PROJECT_SOURCE','手工录入','手工录入',60 UNION ALL
  SELECT 'MEETING_TYPE','项目沟通会','项目沟通会',10 UNION ALL SELECT 'MEETING_TYPE','立项会','立项会',20 UNION ALL
  SELECT 'MEETING_TYPE','尽调会','尽调会',30 UNION ALL SELECT 'MEETING_TYPE','投委会','投委会',40 UNION ALL
  SELECT 'MEETING_TYPE','董事会','董事会',50 UNION ALL SELECT 'MEETING_TYPE','专家访谈','专家访谈',60
) seed ON seed.code=g.code;
