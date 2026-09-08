INSERT IGNORE INTO `sbl_roles` (`id`,`code`,`name`,`description`,`data_scope`,`fde_category`,`built_in`)
VALUES (UUID(),'FDE_CASHIER','出纳','报销审批完成后的付款执行岗位','self','specialist',true);
--> statement-breakpoint
INSERT IGNORE INTO `sbl_role_permissions` (`role_id`,`permission_id`)
SELECT r.`id`,p.`id` FROM `sbl_roles` r JOIN `sbl_permissions` p ON p.`code`='fde.project.read'
WHERE r.`code`='FDE_CASHIER';
