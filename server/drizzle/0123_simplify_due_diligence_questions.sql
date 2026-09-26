ALTER TABLE `sbl_due_diligence_questions` ADD COLUMN `sort_order` int NOT NULL DEFAULT 0;
--> statement-breakpoint
UPDATE `sbl_due_diligence_questions` SET `status`='待核查' WHERE `status` NOT IN ('待核查','已完成');
