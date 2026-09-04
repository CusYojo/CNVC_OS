ALTER TABLE `sbl_meetings`
  DROP CHECK `sbl_meeting_workflow_state_ck`,
  ADD CONSTRAINT `sbl_meeting_workflow_state_ck` CHECK (
    (`workflow_kind`='legacy' AND `workflow_status` IN ('recorded','scheduled','in_progress','completed','cancelled'))
    OR (`workflow_kind` IN ('friday','committee') AND `workflow_status` IN ('draft','scheduled','completed','cancelled'))
  );
