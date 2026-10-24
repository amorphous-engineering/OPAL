CREATE TABLE `api_token` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`name` text NOT NULL,
	`token_hash` text NOT NULL,
	`last_used_at` text,
	`expires_at` text,
	`revoked_at` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `api_token_token_hash_unique` ON `api_token` (`token_hash`);--> statement-breakpoint
CREATE INDEX `api_token_user_idx` ON `api_token` (`user_id`);--> statement-breakpoint
CREATE TABLE `audit_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`at` text NOT NULL,
	`entity` text NOT NULL,
	`entity_id` integer NOT NULL,
	`action` text NOT NULL,
	`op` text NOT NULL,
	`actor_user_id` integer,
	`actor_token_id` integer,
	`before` text,
	`after` text,
	FOREIGN KEY (`actor_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`actor_token_id`) REFERENCES `api_token`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "audit_action_check" CHECK("action" IN ('create', 'update', 'delete'))
);
--> statement-breakpoint
CREATE INDEX `audit_entity_idx` ON `audit_log` (`entity`,`entity_id`);--> statement-breakpoint
CREATE INDEX `audit_at_idx` ON `audit_log` (`at`);--> statement-breakpoint
CREATE TABLE `part` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`internal_pn` text NOT NULL,
	`external_pn` text,
	`name` text NOT NULL,
	`description` text,
	`category` text,
	`unit_of_measure` text NOT NULL,
	`tracking_type` text NOT NULL,
	`procurement` text NOT NULL,
	`tier` integer NOT NULL,
	`reorder_point` integer,
	`is_tooling` integer DEFAULT false NOT NULL,
	`calibration_interval_days` integer,
	`state` text DEFAULT 'draft' NOT NULL,
	`activated_at` text,
	`activated_by_id` integer,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`activated_by_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "part_tracking_check" CHECK("tracking_type" IN ('serialized', 'bulk')),
	CONSTRAINT "part_procurement_check" CHECK("procurement" IN ('make', 'buy', 'both')),
	CONSTRAINT "part_state_check" CHECK("state" IN ('draft', 'active', 'obsolete'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `part_internal_pn_unique` ON `part` (`internal_pn`);--> statement-breakpoint
CREATE INDEX `part_state_idx` ON `part` (`state`);--> statement-breakpoint
CREATE TABLE `session` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`token_hash` text NOT NULL,
	`method` text NOT NULL,
	`expires_at` text NOT NULL,
	`last_seen_at` text,
	`revoked_at` text,
	`user_agent` text,
	`ip_address` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `session_token_hash_unique` ON `session` (`token_hash`);--> statement-breakpoint
CREATE INDEX `session_user_idx` ON `session` (`user_id`);--> statement-breakpoint
CREATE TABLE `user` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`username` text NOT NULL,
	`name` text NOT NULL,
	`email` text,
	`password_hash` text,
	`oidc_issuer` text,
	`oidc_subject` text,
	`is_active` integer DEFAULT true NOT NULL,
	`is_admin` integer DEFAULT false NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_username_unique` ON `user` (`username`);--> statement-breakpoint
CREATE UNIQUE INDEX `user_email_unique` ON `user` (`email`);