ALTER TABLE `role` ADD `project_id` integer REFERENCES project(id);--> statement-breakpoint
CREATE INDEX `role_project_idx` ON `role` (`project_id`);