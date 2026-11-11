CREATE TABLE `part_revision` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`part_id` integer NOT NULL,
	`revises_id` integer NOT NULL,
	`reason` text NOT NULL,
	`created_by_id` integer,
	`created_at` text NOT NULL,
	FOREIGN KEY (`part_id`) REFERENCES `part`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`revises_id`) REFERENCES `part`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `part_revision_part_id_unique` ON `part_revision` (`part_id`);--> statement-breakpoint
CREATE INDEX `part_revision_revises_idx` ON `part_revision` (`revises_id`);