PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_issue` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`issue_number` text NOT NULL,
	`project_id` integer NOT NULL,
	`title` text NOT NULL,
	`description` text,
	`issue_type` text DEFAULT 'task' NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`priority` text DEFAULT 'medium' NOT NULL,
	`containment` text DEFAULT 'advisory' NOT NULL,
	`containment_step_id` integer,
	`execution_id` integer,
	`raised_step_id` integer,
	`should_be` text,
	`actual` text,
	`steps_to_reproduce` text,
	`expected_behavior` text,
	`actual_behavior` text,
	`expected_benefit` text,
	`root_cause` text,
	`corrective_action` text,
	`disposition_type` text,
	`disposition_rationale` text,
	`dispositioned_at` text,
	`dispositioned_by_id` integer,
	`work_started_at` text,
	`work_started_by_id` integer,
	`review_requested_at` text,
	`review_requested_by_id` integer,
	`closed_at` text,
	`closed_by_id` integer,
	`raised_by_id` integer,
	`assigned_to_id` integer,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`containment_step_id`) REFERENCES `step_execution`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`execution_id`) REFERENCES `execution`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`raised_step_id`) REFERENCES `step_execution`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`dispositioned_by_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`work_started_by_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`review_requested_by_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`closed_by_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`raised_by_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`assigned_to_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "issue_type_check" CHECK("issue_type" IN ('non_conformance', 'bug', 'task', 'improvement')),
	CONSTRAINT "issue_status_check" CHECK("status" IN ('open', 'closed', 'void')),
	CONSTRAINT "issue_priority_check" CHECK("priority" IN ('low', 'medium', 'high', 'critical')),
	CONSTRAINT "issue_containment_check" CHECK("containment" IN ('advisory', 'step', 'op', 'wo')),
	CONSTRAINT "issue_disposition_check" CHECK("disposition_type" IN ('use_as_is', 'rework', 'repair', 'scrap', 'return_to_supplier', 'no_defect', 'other'))
);
--> statement-breakpoint
INSERT INTO `__new_issue`("id", "issue_number", "project_id", "title", "description", "issue_type", "status", "priority", "containment", "containment_step_id", "execution_id", "raised_step_id", "should_be", "actual", "steps_to_reproduce", "expected_behavior", "actual_behavior", "expected_benefit", "root_cause", "corrective_action", "disposition_type", "disposition_rationale", "dispositioned_at", "dispositioned_by_id", "work_started_at", "work_started_by_id", "review_requested_at", "review_requested_by_id", "closed_at", "closed_by_id", "raised_by_id", "assigned_to_id", "created_at", "updated_at") SELECT "id", "issue_number", "project_id", "title", "description", "issue_type", "status", "priority", "containment", "containment_step_id", "execution_id", "raised_step_id", "should_be", "actual", "steps_to_reproduce", "expected_behavior", "actual_behavior", "expected_benefit", "root_cause", "corrective_action", "disposition_type", "disposition_rationale", "dispositioned_at", "dispositioned_by_id", "work_started_at", "work_started_by_id", "review_requested_at", "review_requested_by_id", "closed_at", "closed_by_id", "raised_by_id", "assigned_to_id", "created_at", "updated_at" FROM `issue`;--> statement-breakpoint
DROP TABLE `issue`;--> statement-breakpoint
ALTER TABLE `__new_issue` RENAME TO `issue`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `issue_issue_number_unique` ON `issue` (`issue_number`);--> statement-breakpoint
CREATE INDEX `issue_status_idx` ON `issue` (`status`);--> statement-breakpoint
CREATE INDEX `issue_project_idx` ON `issue` (`project_id`);--> statement-breakpoint
CREATE INDEX `issue_assignee_idx` ON `issue` (`assigned_to_id`);--> statement-breakpoint
CREATE INDEX `issue_execution_idx` ON `issue` (`execution_id`);