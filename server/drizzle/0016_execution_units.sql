CREATE TABLE `component_removal` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`execution_id` integer NOT NULL,
	`step_execution_id` integer NOT NULL,
	`assembly_stock_id` integer NOT NULL,
	`stock_id` integer NOT NULL,
	`quantity` integer NOT NULL,
	`return_move_id` integer,
	`notes` text,
	`removed_by_id` integer,
	`at` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`execution_id`) REFERENCES `execution`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`step_execution_id`) REFERENCES `step_execution`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`assembly_stock_id`) REFERENCES `stock_record`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`stock_id`) REFERENCES `stock_record`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`return_move_id`) REFERENCES `stock_move`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`removed_by_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "component_removal_qty" CHECK("quantity" > 0)
);
--> statement-breakpoint
CREATE INDEX `component_removal_assembly_idx` ON `component_removal` (`assembly_stock_id`);--> statement-breakpoint
CREATE INDEX `component_removal_stock_idx` ON `component_removal` (`stock_id`);--> statement-breakpoint
CREATE INDEX `component_removal_execution_idx` ON `component_removal` (`execution_id`);--> statement-breakpoint
CREATE TABLE `execution_unit` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`execution_id` integer NOT NULL,
	`step_execution_id` integer NOT NULL,
	`slot` text,
	`stock_id` integer,
	`borrowed_name` text,
	`borrowed_serial` text,
	`borrowed_from` text,
	`recorded_by_id` integer,
	`created_at` text NOT NULL,
	FOREIGN KEY (`execution_id`) REFERENCES `execution`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`step_execution_id`) REFERENCES `step_execution`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`stock_id`) REFERENCES `stock_record`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`recorded_by_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "execution_unit_one_kind" CHECK(("stock_id" IS NULL) <> ("borrowed_name" IS NULL))
);
--> statement-breakpoint
CREATE INDEX `execution_unit_execution_idx` ON `execution_unit` (`execution_id`);--> statement-breakpoint
CREATE INDEX `execution_unit_stock_idx` ON `execution_unit` (`stock_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `execution_unit_stock_uq` ON `execution_unit` (`execution_id`,`stock_id`) WHERE "stock_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `execution_unit_slot_uq` ON `execution_unit` (`execution_id`,`slot`) WHERE "slot" IS NOT NULL;--> statement-breakpoint
ALTER TABLE `kit_item` ADD `into_slot` text;--> statement-breakpoint
ALTER TABLE `procedure_step` ADD `units` text;