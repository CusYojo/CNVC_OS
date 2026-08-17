ALTER TABLE `sbl_leads` DROP INDEX `uq_leads_name_active`;--> statement-breakpoint
CREATE INDEX `idx_leads_name_status` ON `sbl_leads` (`name`,`pool_status`);--> statement-breakpoint
ALTER TABLE `sbl_leads` DROP COLUMN `active_name`;