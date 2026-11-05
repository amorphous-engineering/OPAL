CREATE TABLE `execution_closure` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`execution_id` integer NOT NULL,
	`closed_by_id` integer,
	`issue_id` integer,
	`created_at` text NOT NULL,
	FOREIGN KEY (`execution_id`) REFERENCES `execution`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`closed_by_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`issue_id`) REFERENCES `issue`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `execution_closure_execution_id_unique` ON `execution_closure` (`execution_id`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_execution` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`wo_number` text NOT NULL,
	`project_id` integer NOT NULL,
	`procedure_id` integer NOT NULL,
	`version_id` integer NOT NULL,
	`status` text DEFAULT 'cut' NOT NULL,
	`priority` text DEFAULT 'normal' NOT NULL,
	`scheduled_start_at` text,
	`target_completion_at` text,
	`started_at` text,
	`completed_at` text,
	`abort_reason` text,
	`created_by_id` integer,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`procedure_id`) REFERENCES `procedure`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`version_id`) REFERENCES `procedure_version`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "execution_status_check" CHECK("status" IN ('cut', 'in_work', 'completed', 'void', 'closed_short')),
	CONSTRAINT "execution_priority_check" CHECK("priority" IN ('normal', 'high', 'urgent'))
);
--> statement-breakpoint
INSERT INTO `__new_execution`("id", "wo_number", "project_id", "procedure_id", "version_id", "status", "priority", "scheduled_start_at", "target_completion_at", "started_at", "completed_at", "abort_reason", "created_by_id", "created_at", "updated_at") SELECT "id", "wo_number", "project_id", "procedure_id", "version_id", "status", "priority", "scheduled_start_at", "target_completion_at", "started_at", "completed_at", "abort_reason", "created_by_id", "created_at", "updated_at" FROM `execution`;--> statement-breakpoint
DROP TABLE `execution`;--> statement-breakpoint
ALTER TABLE `__new_execution` RENAME TO `execution`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `execution_wo_number_unique` ON `execution` (`wo_number`);--> statement-breakpoint
CREATE INDEX `execution_project_idx` ON `execution` (`project_id`);--> statement-breakpoint
CREATE INDEX `execution_procedure_idx` ON `execution` (`procedure_id`);--> statement-breakpoint
CREATE INDEX `execution_status_idx` ON `execution` (`status`);