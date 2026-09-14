ALTER TABLE `sbl_project_post_investment_updates`
  ADD CONSTRAINT `fk_post_investment_update_project`
    FOREIGN KEY (`project_id`) REFERENCES `sbl_projects` (`id`) ON DELETE RESTRICT,
  ADD CONSTRAINT `fk_post_investment_update_author`
    FOREIGN KEY (`author_id`) REFERENCES `sbl_users` (`id`) ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE `sbl_project_post_investment_update_files`
  ADD CONSTRAINT `fk_post_investment_update_file_update`
    FOREIGN KEY (`update_id`) REFERENCES `sbl_project_post_investment_updates` (`id`) ON DELETE CASCADE,
  ADD CONSTRAINT `fk_post_investment_update_file_file`
    FOREIGN KEY (`file_id`) REFERENCES `sbl_project_files` (`id`) ON DELETE RESTRICT;
