CREATE TABLE `sbl_ai_task_templates` (
	`type` varchar(40) NOT NULL,
	`label` varchar(128) NOT NULL,
	`template_version` varchar(64) NOT NULL,
	`skill_name` varchar(128) NOT NULL,
	`output_format` varchar(16) NOT NULL,
	`status` varchar(16) NOT NULL DEFAULT 'enabled',
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `sbl_ai_task_templates_type` PRIMARY KEY(`type`)
);
--> statement-breakpoint
CREATE INDEX `idx_ai_task_templates_status` ON `sbl_ai_task_templates` (`status`,`type`);
--> statement-breakpoint
INSERT INTO `sbl_ai_task_templates`
	(`type`, `label`, `template_version`, `skill_name`, `output_format`, `status`)
VALUES
	('compliance_statement', '合规性说明', 'compliance-corpus-20260804-v5-project-study-template-fidelity', 'generate-compliance-statement', 'docx', 'enabled'),
	('investment_proposal', '投资提案', 'proposal-corpus-20260804-v10-project-study-template-fidelity', 'draft-investment-proposal', 'docx', 'enabled'),
	('investment_recommendation_ppt', '投资建议书（PPT）', 'create-reference-driven-editable-ppt-20260806-v2', 'create-reference-driven-editable-ppt', 'pptx', 'enabled'),
	('due_diligence_report', '尽调报告', 'dd-corpus-202608-v15-human-prose-no-meta-summaries', 'write-investment-dd-report', 'docx', 'enabled'),
	('project_qa', '项目 Q&A', 'generate-project-qa-report-20260806-v1', 'generate-project-qa-report', 'docx', 'enabled');
