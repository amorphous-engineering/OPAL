PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_purchase` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`reference` text NOT NULL,
	`supplier_id` integer,
	`supplier_name` text,
	`supplier_reference` text,
	`status` text DEFAULT 'draft' NOT NULL,
	`ordered_at` text,
	`received_at` text,
	`target_date` text,
	`destination` text,
	`created_by_id` integer,
	`received_by_id` integer,
	`notes` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`supplier_id`) REFERENCES `supplier`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`received_by_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "purchase_status_check" CHECK("status" IN ('draft', 'ordered', 'partial', 'received', 'cancelled', 'on_hold', 'closed_short')),
	CONSTRAINT "purchase_supplier_check" CHECK("__new_purchase"."supplier_id" IS NOT NULL OR "__new_purchase"."supplier_name" IS NOT NULL)
);
--> statement-breakpoint
INSERT INTO `__new_purchase`("id", "reference", "supplier_id", "supplier_name", "supplier_reference", "status", "ordered_at", "received_at", "target_date", "destination", "created_by_id", "received_by_id", "notes", "created_at", "updated_at") SELECT "id", "reference", "supplier_id", "supplier_name", "supplier_reference", "status", "ordered_at", "received_at", "target_date", "destination", "created_by_id", "received_by_id", "notes", "created_at", "updated_at" FROM `purchase`;--> statement-breakpoint
DROP TABLE `purchase`;--> statement-breakpoint
ALTER TABLE `__new_purchase` RENAME TO `purchase`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `purchase_reference_unique` ON `purchase` (`reference`);--> statement-breakpoint
CREATE INDEX `purchase_supplier_idx` ON `purchase` (`supplier_id`);--> statement-breakpoint
CREATE INDEX `purchase_status_idx` ON `purchase` (`status`);--> statement-breakpoint
ALTER TABLE `audit_log` ADD `reason` text;--> statement-breakpoint
CREATE TABLE `__new_purchase_line` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`purchase_id` integer NOT NULL,
	`part_id` integer NOT NULL,
	`qty_ordered` integer NOT NULL,
	`qty_cancelled` integer DEFAULT 0 NOT NULL,
	`unit_cost` integer,
	`destination` text,
	`notes` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`purchase_id`) REFERENCES `purchase`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`part_id`) REFERENCES `part`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "purchase_line_qty_check" CHECK("__new_purchase_line"."qty_ordered" > 0),
	CONSTRAINT "purchase_line_cancelled_check" CHECK("__new_purchase_line"."qty_cancelled" >= 0 AND "__new_purchase_line"."qty_cancelled" <= "__new_purchase_line"."qty_ordered")
);
--> statement-breakpoint
INSERT INTO `__new_purchase_line`("id", "purchase_id", "part_id", "qty_ordered", "qty_cancelled", "unit_cost", "destination", "notes", "created_at", "updated_at") SELECT "id", "purchase_id", "part_id", "qty_ordered", 0, "unit_cost", "destination", "notes", "created_at", "updated_at" FROM `purchase_line`;--> statement-breakpoint
DROP TABLE `purchase_line`;--> statement-breakpoint
ALTER TABLE `__new_purchase_line` RENAME TO `purchase_line`;--> statement-breakpoint
CREATE INDEX `purchase_line_purchase_idx` ON `purchase_line` (`purchase_id`);--> statement-breakpoint
CREATE INDEX `purchase_line_part_idx` ON `purchase_line` (`part_id`);