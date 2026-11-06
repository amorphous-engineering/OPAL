ALTER TABLE `stock_test_result` ADD `struck_at` text;--> statement-breakpoint
ALTER TABLE `stock_test_result` ADD `struck_by_id` integer REFERENCES user(id);--> statement-breakpoint
ALTER TABLE `stock_test_result` ADD `strike_reason` text;