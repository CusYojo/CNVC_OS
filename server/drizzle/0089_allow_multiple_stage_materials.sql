ALTER TABLE `sbl_project_stage_materials`
  DROP INDEX `uq_project_stage_material`,
  ADD UNIQUE KEY `uq_project_stage_material_file` (`project_id`,`stage`,`requirement_key`,`file_id`),
  ADD KEY `idx_project_stage_material_requirement` (`project_id`,`stage`,`requirement_key`);
