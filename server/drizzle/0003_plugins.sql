CREATE TABLE `external_link` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`plugin_id` integer NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` integer NOT NULL,
	`external_id` text NOT NULL,
	`url` text NOT NULL,
	`label` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`plugin_id`) REFERENCES `plugin`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "external_link_entity_check" CHECK("entity_type" IN ('issue', 'part', 'execution', 'project'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `external_link_key` ON `external_link` (`plugin_id`,`entity_type`,`entity_id`,`external_id`);--> statement-breakpoint
CREATE INDEX `external_link_entity_idx` ON `external_link` (`entity_type`,`entity_id`);--> statement-breakpoint
CREATE TABLE `plugin` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`key` text NOT NULL,
	`source` text NOT NULL,
	`ref` text,
	`sha` text NOT NULL,
	`previous_sha` text,
	`version` text NOT NULL,
	`manifest` text NOT NULL,
	`enabled` integer DEFAULT false NOT NULL,
	`user_id` integer NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `plugin_key_unique` ON `plugin` (`key`);--> statement-breakpoint
CREATE TABLE `plugin_setting` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`plugin_id` integer NOT NULL,
	`key` text NOT NULL,
	`value` text,
	`secret` integer DEFAULT false NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`plugin_id`) REFERENCES `plugin`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `plugin_setting_key` ON `plugin_setting` (`plugin_id`,`key`);--> statement-breakpoint
ALTER TABLE `api_token` ADD `scopes` text;