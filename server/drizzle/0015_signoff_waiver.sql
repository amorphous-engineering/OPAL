CREATE TABLE `signoff_waiver` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`step_execution_id` integer NOT NULL,
	`slot` integer NOT NULL,
	`label` text NOT NULL,
	`role` text,
	`reason` text NOT NULL,
	`waived_by_id` integer,
	`waived_at` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`step_execution_id`) REFERENCES `step_execution`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`waived_by_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `signoff_waiver_slot_uq` ON `signoff_waiver` (`step_execution_id`,`slot`);