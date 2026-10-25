CREATE TABLE `execution_comment` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`execution_id` integer NOT NULL,
	`author_id` integer,
	`body` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`execution_id`) REFERENCES `execution`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`author_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `execution_comment_execution_idx` ON `execution_comment` (`execution_id`);