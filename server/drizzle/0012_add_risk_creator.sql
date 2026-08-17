ALTER TABLE `sbl_risks` ADD `created_by` varchar(36);
--> statement-breakpoint
ALTER TABLE `sbl_risks` ADD CONSTRAINT `sbl_risks_created_by_sbl_users_id_fk` FOREIGN KEY (`created_by`) REFERENCES `sbl_users`(`id`) ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX `idx_risks_creator` ON `sbl_risks` (`created_by`);
