ALTER TABLE `sbl_projects` ADD `owner_user_id` varchar(36);
--> statement-breakpoint
ALTER TABLE `sbl_projects` ADD CONSTRAINT `sbl_projects_owner_user_id_sbl_users_id_fk` FOREIGN KEY (`owner_user_id`) REFERENCES `sbl_users`(`id`) ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX `idx_projects_owner_user` ON `sbl_projects` (`owner_user_id`);
--> statement-breakpoint
ALTER TABLE `sbl_meetings` ADD `host_user_id` varchar(36);
--> statement-breakpoint
ALTER TABLE `sbl_meetings` ADD CONSTRAINT `sbl_meetings_host_user_id_sbl_users_id_fk` FOREIGN KEY (`host_user_id`) REFERENCES `sbl_users`(`id`) ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX `idx_meetings_host_user` ON `sbl_meetings` (`host_user_id`);
--> statement-breakpoint
ALTER TABLE `sbl_todos` ADD `owner_user_id` varchar(36);
--> statement-breakpoint
ALTER TABLE `sbl_todos` ADD CONSTRAINT `sbl_todos_owner_user_id_sbl_users_id_fk` FOREIGN KEY (`owner_user_id`) REFERENCES `sbl_users`(`id`) ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX `idx_todos_owner_user` ON `sbl_todos` (`owner_user_id`);
--> statement-breakpoint
ALTER TABLE `sbl_risks` ADD `assignee_user_id` varchar(36);
--> statement-breakpoint
ALTER TABLE `sbl_risks` ADD CONSTRAINT `sbl_risks_assignee_user_id_sbl_users_id_fk` FOREIGN KEY (`assignee_user_id`) REFERENCES `sbl_users`(`id`) ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX `idx_risks_assignee_user` ON `sbl_risks` (`assignee_user_id`);
--> statement-breakpoint
CREATE TABLE `sbl_project_members` (
	`project_id` varchar(36) NOT NULL,
	`user_id` varchar(36) NOT NULL,
	`member_role` varchar(16) NOT NULL,
	`source_name` varchar(64) NOT NULL,
	`created_at` datetime(3) DEFAULT CURRENT_TIMESTAMP(3) NOT NULL,
	CONSTRAINT `uq_project_members_project_user` UNIQUE(`project_id`,`user_id`),
	CONSTRAINT `sbl_project_members_project_id_sbl_projects_id_fk` FOREIGN KEY (`project_id`) REFERENCES `sbl_projects`(`id`) ON DELETE cascade ON UPDATE no action,
	CONSTRAINT `sbl_project_members_user_id_sbl_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `sbl_users`(`id`) ON DELETE cascade ON UPDATE no action
);
--> statement-breakpoint
CREATE INDEX `idx_project_members_user` ON `sbl_project_members` (`user_id`,`project_id`);
--> statement-breakpoint
CREATE TABLE `sbl_meeting_participants` (
	`meeting_id` varchar(36) NOT NULL,
	`user_id` varchar(36) NOT NULL,
	`source_name` varchar(64) NOT NULL,
	`created_at` datetime(3) DEFAULT CURRENT_TIMESTAMP(3) NOT NULL,
	CONSTRAINT `uq_meeting_participants_meeting_user` UNIQUE(`meeting_id`,`user_id`),
	CONSTRAINT `sbl_meeting_participants_meeting_id_sbl_meetings_id_fk` FOREIGN KEY (`meeting_id`) REFERENCES `sbl_meetings`(`id`) ON DELETE cascade ON UPDATE no action,
	CONSTRAINT `sbl_meeting_participants_user_id_sbl_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `sbl_users`(`id`) ON DELETE cascade ON UPDATE no action
);
--> statement-breakpoint
CREATE INDEX `idx_meeting_participants_user` ON `sbl_meeting_participants` (`user_id`,`meeting_id`);
--> statement-breakpoint
CREATE TABLE `sbl_identity_resolution_issues` (
	`id` varchar(36) PRIMARY KEY NOT NULL,
	`entity_type` varchar(32) NOT NULL,
	`entity_id` varchar(36) NOT NULL,
	`field_name` varchar(32) NOT NULL,
	`source_value` varchar(64) NOT NULL,
	`reason` varchar(32) NOT NULL,
	`status` varchar(16) DEFAULT 'open' NOT NULL,
	`resolved_user_id` varchar(36),
	`resolved_at` datetime(3),
	`created_at` datetime(3) DEFAULT CURRENT_TIMESTAMP(3) NOT NULL,
	`updated_at` datetime(3) DEFAULT CURRENT_TIMESTAMP(3) NOT NULL,
	CONSTRAINT `uq_identity_resolution_issue` UNIQUE(`entity_type`,`entity_id`,`field_name`,`source_value`),
	CONSTRAINT `sbl_identity_resolution_issues_resolved_user_id_sbl_users_id_fk` FOREIGN KEY (`resolved_user_id`) REFERENCES `sbl_users`(`id`) ON DELETE set null ON UPDATE no action
);
--> statement-breakpoint
CREATE INDEX `idx_identity_resolution_status` ON `sbl_identity_resolution_issues` (`status`,`entity_type`);
--> statement-breakpoint
UPDATE `sbl_projects` p
JOIN (
	SELECT MIN(id) AS user_id, TRIM(name) AS source_name
	FROM `sbl_users`
	GROUP BY TRIM(name)
	HAVING COUNT(*) = 1 AND SUM(status = '启用') = 1
) u ON TRIM(p.owner) = u.source_name
SET p.owner_user_id = u.user_id;
--> statement-breakpoint
UPDATE `sbl_meetings` m
JOIN (
	SELECT MIN(id) AS user_id, TRIM(name) AS source_name
	FROM `sbl_users`
	GROUP BY TRIM(name)
	HAVING COUNT(*) = 1 AND SUM(status = '启用') = 1
) u ON TRIM(m.host) = u.source_name
SET m.host_user_id = u.user_id;
--> statement-breakpoint
UPDATE `sbl_todos` t
JOIN (
	SELECT MIN(id) AS user_id, TRIM(name) AS source_name
	FROM `sbl_users`
	GROUP BY TRIM(name)
	HAVING COUNT(*) = 1 AND SUM(status = '启用') = 1
) u ON TRIM(t.owner) = u.source_name
SET t.owner_user_id = u.user_id;
--> statement-breakpoint
UPDATE `sbl_risks` r
JOIN (
	SELECT MIN(id) AS user_id, TRIM(name) AS source_name
	FROM `sbl_users`
	GROUP BY TRIM(name)
	HAVING COUNT(*) = 1 AND SUM(status = '启用') = 1
) u ON TRIM(r.assignee) = u.source_name
SET r.assignee_user_id = u.user_id
WHERE NULLIF(TRIM(r.assignee), '') IS NOT NULL;
--> statement-breakpoint
INSERT IGNORE INTO `sbl_project_members` (`project_id`, `user_id`, `member_role`, `source_name`)
SELECT p.id, p.owner_user_id, 'owner', TRIM(p.owner)
FROM `sbl_projects` p
WHERE p.owner_user_id IS NOT NULL;
--> statement-breakpoint
INSERT IGNORE INTO `sbl_project_members` (`project_id`, `user_id`, `member_role`, `source_name`)
SELECT p.id, u.user_id, 'collaborator', TRIM(j.source_name)
FROM `sbl_projects` p
JOIN JSON_TABLE(COALESCE(p.collaborators, JSON_ARRAY()), '$[*]' COLUMNS (`source_name` varchar(64) PATH '$')) j
JOIN (
	SELECT MIN(id) AS user_id, TRIM(name) AS source_name
	FROM `sbl_users`
	GROUP BY TRIM(name)
	HAVING COUNT(*) = 1 AND SUM(status = '启用') = 1
) u ON TRIM(j.source_name) COLLATE utf8mb4_general_ci = u.source_name
WHERE NULLIF(TRIM(j.source_name), '') IS NOT NULL;
--> statement-breakpoint
INSERT IGNORE INTO `sbl_meeting_participants` (`meeting_id`, `user_id`, `source_name`)
SELECT m.id, u.user_id, TRIM(j.source_name)
FROM `sbl_meetings` m
JOIN JSON_TABLE(COALESCE(m.attendees, JSON_ARRAY()), '$[*]' COLUMNS (`source_name` varchar(64) PATH '$')) j
JOIN (
	SELECT MIN(id) AS user_id, TRIM(name) AS source_name
	FROM `sbl_users`
	GROUP BY TRIM(name)
	HAVING COUNT(*) = 1 AND SUM(status = '启用') = 1
) u ON TRIM(j.source_name) COLLATE utf8mb4_general_ci = u.source_name
WHERE NULLIF(TRIM(j.source_name), '') IS NOT NULL;
--> statement-breakpoint
INSERT IGNORE INTO `sbl_identity_resolution_issues`
	(`id`, `entity_type`, `entity_id`, `field_name`, `source_value`, `reason`)
SELECT UUID(), 'project', p.id, 'owner', TRIM(p.owner),
	CASE WHEN a.total_count IS NULL THEN 'missing_user' WHEN a.total_count > 1 THEN 'duplicate_name' ELSE 'disabled_user' END
FROM `sbl_projects` p
LEFT JOIN (
	SELECT TRIM(name) AS source_name, COUNT(*) AS total_count FROM `sbl_users` GROUP BY TRIM(name)
) a ON TRIM(p.owner) = a.source_name
WHERE NULLIF(TRIM(p.owner), '') IS NOT NULL AND p.owner_user_id IS NULL;
--> statement-breakpoint
INSERT IGNORE INTO `sbl_identity_resolution_issues`
	(`id`, `entity_type`, `entity_id`, `field_name`, `source_value`, `reason`)
SELECT UUID(), 'project', p.id, 'collaborators', TRIM(j.source_name),
	CASE WHEN a.total_count IS NULL THEN 'missing_user' WHEN a.total_count > 1 THEN 'duplicate_name' ELSE 'disabled_user' END
FROM `sbl_projects` p
JOIN JSON_TABLE(COALESCE(p.collaborators, JSON_ARRAY()), '$[*]' COLUMNS (`source_name` varchar(64) PATH '$')) j
LEFT JOIN (
	SELECT TRIM(name) AS source_name, COUNT(*) AS total_count,
		SUM(status = '启用') AS enabled_count FROM `sbl_users` GROUP BY TRIM(name)
) a ON TRIM(j.source_name) COLLATE utf8mb4_general_ci = a.source_name
WHERE NULLIF(TRIM(j.source_name), '') IS NOT NULL
	AND NOT (a.total_count = 1 AND a.enabled_count = 1);
--> statement-breakpoint
INSERT IGNORE INTO `sbl_identity_resolution_issues`
	(`id`, `entity_type`, `entity_id`, `field_name`, `source_value`, `reason`)
SELECT UUID(), 'meeting', m.id, 'host', TRIM(m.host),
	CASE WHEN a.total_count IS NULL THEN 'missing_user' WHEN a.total_count > 1 THEN 'duplicate_name' ELSE 'disabled_user' END
FROM `sbl_meetings` m
LEFT JOIN (
	SELECT TRIM(name) AS source_name, COUNT(*) AS total_count FROM `sbl_users` GROUP BY TRIM(name)
) a ON TRIM(m.host) = a.source_name
WHERE NULLIF(TRIM(m.host), '') IS NOT NULL AND m.host_user_id IS NULL;
--> statement-breakpoint
INSERT IGNORE INTO `sbl_identity_resolution_issues`
	(`id`, `entity_type`, `entity_id`, `field_name`, `source_value`, `reason`)
SELECT UUID(), 'meeting', m.id, 'attendees', TRIM(j.source_name),
	CASE WHEN a.total_count IS NULL THEN 'missing_user' WHEN a.total_count > 1 THEN 'duplicate_name' ELSE 'disabled_user' END
FROM `sbl_meetings` m
JOIN JSON_TABLE(COALESCE(m.attendees, JSON_ARRAY()), '$[*]' COLUMNS (`source_name` varchar(64) PATH '$')) j
LEFT JOIN (
	SELECT TRIM(name) AS source_name, COUNT(*) AS total_count,
		SUM(status = '启用') AS enabled_count FROM `sbl_users` GROUP BY TRIM(name)
) a ON TRIM(j.source_name) COLLATE utf8mb4_general_ci = a.source_name
WHERE NULLIF(TRIM(j.source_name), '') IS NOT NULL
	AND NOT (a.total_count = 1 AND a.enabled_count = 1);
--> statement-breakpoint
INSERT IGNORE INTO `sbl_identity_resolution_issues`
	(`id`, `entity_type`, `entity_id`, `field_name`, `source_value`, `reason`)
SELECT UUID(), 'todo', t.id, 'owner', TRIM(t.owner),
	CASE WHEN a.total_count IS NULL THEN 'missing_user' WHEN a.total_count > 1 THEN 'duplicate_name' ELSE 'disabled_user' END
FROM `sbl_todos` t
LEFT JOIN (
	SELECT TRIM(name) AS source_name, COUNT(*) AS total_count FROM `sbl_users` GROUP BY TRIM(name)
) a ON TRIM(t.owner) = a.source_name
WHERE NULLIF(TRIM(t.owner), '') IS NOT NULL AND t.owner_user_id IS NULL;
--> statement-breakpoint
INSERT IGNORE INTO `sbl_identity_resolution_issues`
	(`id`, `entity_type`, `entity_id`, `field_name`, `source_value`, `reason`)
SELECT UUID(), 'risk', r.id, 'assignee', TRIM(r.assignee),
	CASE WHEN a.total_count IS NULL THEN 'missing_user' WHEN a.total_count > 1 THEN 'duplicate_name' ELSE 'disabled_user' END
FROM `sbl_risks` r
LEFT JOIN (
	SELECT TRIM(name) AS source_name, COUNT(*) AS total_count FROM `sbl_users` GROUP BY TRIM(name)
) a ON TRIM(r.assignee) = a.source_name
WHERE NULLIF(TRIM(r.assignee), '') IS NOT NULL AND r.assignee_user_id IS NULL;
