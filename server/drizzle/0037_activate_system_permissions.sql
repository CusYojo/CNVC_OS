INSERT IGNORE INTO `sbl_permissions` (`id`,`code`,`name`,`module`,`action`) VALUES
  (UUID(),'ai.configure','AI 模型与能力配置','AI','configure'),
  (UUID(),'im.manage','IM 机器人管理','IM','manage');
--> statement-breakpoint
INSERT IGNORE INTO `sbl_role_permissions` (`role_id`,`permission_id`)
SELECT r.id, p.id FROM `sbl_roles` r CROSS JOIN `sbl_permissions` p
WHERE r.name='系统管理员' AND p.code IN ('ai.configure','im.manage');
--> statement-breakpoint
INSERT IGNORE INTO `sbl_role_permissions` (`role_id`,`permission_id`)
SELECT r.id, p.id FROM `sbl_roles` r CROSS JOIN `sbl_permissions` p
WHERE r.name IN ('AI平台管理员','AI 平台管理员') AND p.code='ai.configure';
--> statement-breakpoint
INSERT IGNORE INTO `sbl_role_permissions` (`role_id`,`permission_id`)
SELECT r.id, p.id FROM `sbl_roles` r CROSS JOIN `sbl_permissions` p
WHERE r.name IN ('运营管理员','平台运营') AND p.code='im.manage';
