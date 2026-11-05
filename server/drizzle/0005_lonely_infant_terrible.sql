ALTER TABLE `requirement` ADD `cancelled_at` text;--> statement-breakpoint
ALTER TABLE `requirement` ADD `cancelled_by_id` integer REFERENCES user(id);--> statement-breakpoint
ALTER TABLE `requirement` ADD `cancel_reason` text;