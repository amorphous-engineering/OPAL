ALTER TABLE `purchase_expense` ADD `struck_at` text;--> statement-breakpoint
ALTER TABLE `purchase_expense` ADD `struck_by_id` integer REFERENCES user(id);--> statement-breakpoint
ALTER TABLE `purchase_expense` ADD `strike_reason` text;