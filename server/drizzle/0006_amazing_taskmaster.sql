ALTER TABLE `project` ADD `archived_reason` text;--> statement-breakpoint
ALTER TABLE `data_point` ADD `struck_at` text;--> statement-breakpoint
ALTER TABLE `data_point` ADD `struck_by_id` integer REFERENCES user(id);--> statement-breakpoint
ALTER TABLE `data_point` ADD `strike_reason` text;