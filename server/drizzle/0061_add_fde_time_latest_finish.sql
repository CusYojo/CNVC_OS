-- Preserve unknown historical deadlines; never infer them from project dates or creation time.
ALTER TABLE `sbl_leader_time_requests`
 ADD COLUMN `latest_finish` datetime(3) NULL;
