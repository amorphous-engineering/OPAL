PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_part` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`internal_pn` text NOT NULL,
	`external_pn` text,
	`name` text NOT NULL,
	`description` text,
	`category` text,
	`unit_of_measure` text NOT NULL,
	`tracking_type` text NOT NULL,
	`lot_rule` text DEFAULT 'tier' NOT NULL,
	`procurement` text NOT NULL,
	`tier` integer NOT NULL,
	`reorder_point` integer,
	`is_tooling` integer DEFAULT false NOT NULL,
	`calibration_interval_days` integer,
	`metadata` text,
	`state` text DEFAULT 'draft' NOT NULL,
	`activated_at` text,
	`activated_by_id` integer,
	`activation_cause` text,
	`obsoleted_at` text,
	`obsoleted_by_id` integer,
	`obsolete_cause` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`activated_by_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`obsoleted_by_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "part_tracking_check" CHECK("tracking_type" IN ('serialized', 'bulk')),
	CONSTRAINT "part_lot_rule_check" CHECK("lot_rule" IN ('tier', 'required', 'none')),
	CONSTRAINT "part_procurement_check" CHECK("procurement" IN ('make', 'buy', 'both')),
	CONSTRAINT "part_state_check" CHECK("state" IN ('draft', 'active', 'obsolete'))
);
--> statement-breakpoint
INSERT INTO `__new_part`("id", "internal_pn", "external_pn", "name", "description", "category", "unit_of_measure", "tracking_type", "lot_rule", "procurement", "tier", "reorder_point", "is_tooling", "calibration_interval_days", "metadata", "state", "activated_at", "activated_by_id", "activation_cause", "obsoleted_at", "obsoleted_by_id", "obsolete_cause", "created_at", "updated_at") SELECT "id", "internal_pn", "external_pn", "name", "description", "category", "unit_of_measure", "tracking_type", 'tier', "procurement", "tier", "reorder_point", "is_tooling", "calibration_interval_days", "metadata", "state", "activated_at", "activated_by_id", "activation_cause", "obsoleted_at", "obsoleted_by_id", "obsolete_cause", "created_at", "updated_at" FROM `part`;--> statement-breakpoint
DROP TABLE `part`;--> statement-breakpoint
ALTER TABLE `__new_part` RENAME TO `part`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `part_internal_pn_unique` ON `part` (`internal_pn`);--> statement-breakpoint
CREATE INDEX `part_state_idx` ON `part` (`state`);--> statement-breakpoint
CREATE INDEX `part_external_pn_idx` ON `part` (`external_pn`);--> statement-breakpoint
CREATE INDEX `part_category_idx` ON `part` (`category`);--> statement-breakpoint
CREATE INDEX `part_tier_idx` ON `part` (`tier`);