CREATE TABLE `work_interval` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`execution_id` integer NOT NULL,
	`op_step_id` integer NOT NULL,
	`user_id` integer NOT NULL,
	`started_at` text NOT NULL,
	`ended_at` text,
	FOREIGN KEY (`execution_id`) REFERENCES `execution`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`op_step_id`) REFERENCES `step_execution`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `work_interval_execution_idx` ON `work_interval` (`execution_id`,`user_id`);