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
	`invocation` text,
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
CREATE TABLE `designator_sequence` (
	`prefix` text PRIMARY KEY NOT NULL,
	`last_value` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
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
CREATE UNIQUE INDEX `user_email_unique` ON `user` (`email`);--> statement-breakpoint
CREATE TABLE `auth_setting` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`key` text NOT NULL,
	`value` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `auth_setting_key_unique` ON `auth_setting` (`key`);--> statement-breakpoint
CREATE TABLE `passkey_credential` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`credential_id` blob NOT NULL,
	`public_key` blob NOT NULL,
	`sign_count` integer DEFAULT 0 NOT NULL,
	`name` text DEFAULT 'Passkey' NOT NULL,
	`aaguid` text,
	`transports` text,
	`last_used_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `passkey_credential_credential_id_unique` ON `passkey_credential` (`credential_id`);--> statement-breakpoint
CREATE INDEX `passkey_user_idx` ON `passkey_credential` (`user_id`);--> statement-breakpoint
CREATE TABLE `webauthn_challenge` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`nonce` text NOT NULL,
	`kind` text NOT NULL,
	`rp_id` text NOT NULL,
	`user_id` integer,
	`state_json` text NOT NULL,
	`expires_at` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "webauthn_kind_check" CHECK("kind" IN ('login', 'register'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `webauthn_challenge_nonce_unique` ON `webauthn_challenge` (`nonce`);--> statement-breakpoint
CREATE INDEX `webauthn_challenge_user_idx` ON `webauthn_challenge` (`user_id`);--> statement-breakpoint
CREATE TABLE `bom_line` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`assembly_id` integer NOT NULL,
	`component_id` integer NOT NULL,
	`quantity` integer DEFAULT 10000 NOT NULL,
	`reference_designator` text,
	`notes` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`assembly_id`) REFERENCES `part`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`component_id`) REFERENCES `part`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "bom_line_quantity_positive" CHECK("quantity" > 0),
	CONSTRAINT "bom_line_not_self" CHECK("assembly_id" <> "component_id")
);
--> statement-breakpoint
CREATE UNIQUE INDEX `bom_line_pair` ON `bom_line` (`assembly_id`,`component_id`);--> statement-breakpoint
CREATE INDEX `bom_line_component_idx` ON `bom_line` (`component_id`);--> statement-breakpoint
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
	CONSTRAINT "part_procurement_check" CHECK("procurement" IN ('make', 'buy', 'both')),
	CONSTRAINT "part_state_check" CHECK("state" IN ('draft', 'active', 'obsolete'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `part_internal_pn_unique` ON `part` (`internal_pn`);--> statement-breakpoint
CREATE INDEX `part_state_idx` ON `part` (`state`);--> statement-breakpoint
CREATE INDEX `part_external_pn_idx` ON `part` (`external_pn`);--> statement-breakpoint
CREATE INDEX `part_category_idx` ON `part` (`category`);--> statement-breakpoint
CREATE INDEX `part_tier_idx` ON `part` (`tier`);--> statement-breakpoint
CREATE TABLE `retired_part_number` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`internal_pn` text NOT NULL,
	`reason` text NOT NULL,
	`retired_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `retired_part_number_internal_pn_unique` ON `retired_part_number` (`internal_pn`);--> statement-breakpoint
CREATE TABLE `app_setting` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`key` text NOT NULL,
	`value` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `app_setting_key_unique` ON `app_setting` (`key`);--> statement-breakpoint
CREATE TABLE `project` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`code` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`state` text DEFAULT 'active' NOT NULL,
	`archived_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT "project_state_check" CHECK("state" IN ('active', 'archived'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `project_code_unique` ON `project` (`code`);--> statement-breakpoint
CREATE TABLE `role` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`key` text,
	`is_system` integer DEFAULT false NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `role_key_unique` ON `role` (`key`);--> statement-breakpoint
CREATE UNIQUE INDEX `role_name_nocase` ON `role` (`name`);--> statement-breakpoint
CREATE TABLE `role_gate` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`role_id` integer NOT NULL,
	`gate` text NOT NULL,
	FOREIGN KEY (`role_id`) REFERENCES `role`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `role_gate_unique` ON `role_gate` (`role_id`,`gate`);--> statement-breakpoint
CREATE TABLE `user_profile` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`job_title` text,
	`phone` text,
	`workcenter_id` integer,
	`avatar_hash` text,
	`avatar_mime` text,
	`avatar_source` text,
	`avatar_updated_at` text,
	`needs_profile_setup` integer DEFAULT false NOT NULL,
	`needs_onboarding` integer DEFAULT true NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`workcenter_id`) REFERENCES `workcenter`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_profile_user_id_unique` ON `user_profile` (`user_id`);--> statement-breakpoint
CREATE TABLE `user_role` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`role_id` integer NOT NULL,
	`granted_by_id` integer,
	`granted_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`role_id`) REFERENCES `role`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`granted_by_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_role_unique` ON `user_role` (`user_id`,`role_id`);--> statement-breakpoint
CREATE INDEX `user_role_role_idx` ON `user_role` (`role_id`);--> statement-breakpoint
CREATE TABLE `workcenter` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`code` text NOT NULL,
	`description` text,
	`location` text,
	`is_active` integer DEFAULT true NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workcenter_code_unique` ON `workcenter` (`code`);--> statement-breakpoint
CREATE TABLE `attachment` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`blob_sha256` text NOT NULL,
	`filename` text NOT NULL,
	`owner_type` text NOT NULL,
	`owner_id` integer NOT NULL,
	`kind` text,
	`note` text,
	`uploaded_by_id` integer,
	`created_at` text NOT NULL,
	FOREIGN KEY (`blob_sha256`) REFERENCES `blob`(`sha256`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`uploaded_by_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "attachment_kind_check" CHECK("kind" IN ('inline', 'reference', 'closeout', 'capture', 'step_image', 'quote', 'invoice', 'packing_slip'))
);
--> statement-breakpoint
CREATE INDEX `attachment_owner_idx` ON `attachment` (`owner_type`,`owner_id`);--> statement-breakpoint
CREATE INDEX `attachment_blob_idx` ON `attachment` (`blob_sha256`);--> statement-breakpoint
CREATE TABLE `blob` (
	`sha256` text PRIMARY KEY NOT NULL,
	`size_bytes` integer NOT NULL,
	`mime_type` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `notification` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`actor_id` integer,
	`kind` text NOT NULL,
	`priority` text DEFAULT 'normal' NOT NULL,
	`title` text NOT NULL,
	`body` text,
	`href` text NOT NULL,
	`subject_type` text NOT NULL,
	`subject_id` integer NOT NULL,
	`created_at` text NOT NULL,
	`read_at` text,
	`dismissed_at` text,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`actor_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "notification_kind_check" CHECK("kind" IN ('issue_assigned', 'issue_dispositioned', 'issue_commented', 'issue_closed', 'execution_blocked', 'execution_unblocked')),
	CONSTRAINT "notification_priority_check" CHECK("priority" IN ('low', 'normal', 'high', 'critical'))
);
--> statement-breakpoint
CREATE INDEX `notification_user_created_idx` ON `notification` (`user_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `undo_mark` (
	`audit_id` integer PRIMARY KEY NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`audit_id`) REFERENCES `audit_log`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `stock_move` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`stock_id` integer NOT NULL,
	`kind` text NOT NULL,
	`qty` integer NOT NULL,
	`reason` text,
	`notes` text,
	`actor_user_id` integer,
	`at` text NOT NULL,
	`from_location` text,
	`to_location` text,
	`from_lot` text,
	`to_lot` text,
	`counterpart_id` integer,
	`into_stock_id` integer,
	`purchase_line_id` integer,
	FOREIGN KEY (`stock_id`) REFERENCES `stock_record`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`actor_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`counterpart_id`) REFERENCES `stock_move`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`into_stock_id`) REFERENCES `stock_record`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`purchase_line_id`) REFERENCES `purchase_line`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "stock_move_kind_check" CHECK("kind" IN ('receive', 'consume', 'produce', 'adjust', 'count', 'transfer')),
	CONSTRAINT "stock_move_sign_check" CHECK(("stock_move"."kind" IN ('receive', 'produce') AND "stock_move"."qty" > 0)
				OR ("stock_move"."kind" = 'consume' AND "stock_move"."qty" <= 0)
				OR "stock_move"."kind" IN ('adjust', 'count', 'transfer')),
	CONSTRAINT "stock_move_into_check" CHECK("stock_move"."into_stock_id" IS NULL OR "stock_move"."kind" = 'consume')
);
--> statement-breakpoint
CREATE INDEX `stock_move_stock_idx` ON `stock_move` (`stock_id`,`at`);--> statement-breakpoint
CREATE INDEX `stock_move_kind_idx` ON `stock_move` (`kind`);--> statement-breakpoint
CREATE INDEX `stock_move_into_idx` ON `stock_move` (`into_stock_id`);--> statement-breakpoint
CREATE INDEX `stock_move_purchase_line_idx` ON `stock_move` (`purchase_line_id`);--> statement-breakpoint
CREATE TABLE `stock_record` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`part_id` integer NOT NULL,
	`opal_number` text NOT NULL,
	`location` text NOT NULL,
	`lot_number` text,
	`serial_number` text,
	`alias` text,
	`source_type` text DEFAULT 'manual' NOT NULL,
	`expiration_date` text,
	`last_calibrated_at` text,
	`calibration_due_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`part_id`) REFERENCES `part`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "stock_record_source_check" CHECK("source_type" IN ('purchase', 'production', 'manual', 'transfer'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `stock_record_opal_number_unique` ON `stock_record` (`opal_number`);--> statement-breakpoint
CREATE INDEX `stock_record_part_idx` ON `stock_record` (`part_id`);--> statement-breakpoint
CREATE INDEX `stock_record_location_idx` ON `stock_record` (`location`);--> statement-breakpoint
CREATE INDEX `stock_record_lot_idx` ON `stock_record` (`lot_number`);--> statement-breakpoint
CREATE INDEX `stock_record_expiration_idx` ON `stock_record` (`expiration_date`);--> statement-breakpoint
CREATE INDEX `stock_record_calibration_idx` ON `stock_record` (`calibration_due_at`);--> statement-breakpoint
CREATE TABLE `stock_test_result` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`stock_id` integer NOT NULL,
	`template_id` integer,
	`test_name` text NOT NULL,
	`result` text DEFAULT 'pending' NOT NULL,
	`value` text,
	`notes` text,
	`tested_at` text,
	`tested_by_id` integer,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`stock_id`) REFERENCES `stock_record`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`template_id`) REFERENCES `test_template`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`tested_by_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "stock_test_result_check" CHECK("result" IN ('pass', 'fail', 'pending'))
);
--> statement-breakpoint
CREATE INDEX `stock_test_result_stock_idx` ON `stock_test_result` (`stock_id`);--> statement-breakpoint
CREATE TABLE `test_template` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`part_id` integer NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`required` integer DEFAULT false NOT NULL,
	`test_type` text DEFAULT 'boolean' NOT NULL,
	`min_value` integer,
	`max_value` integer,
	`unit` text,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`part_id`) REFERENCES `part`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "test_template_type_check" CHECK("test_type" IN ('boolean', 'numeric', 'text'))
);
--> statement-breakpoint
CREATE INDEX `test_template_part_idx` ON `test_template` (`part_id`);--> statement-breakpoint
CREATE TABLE `purchase` (
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
	CONSTRAINT "purchase_status_check" CHECK("status" IN ('draft', 'ordered', 'partial', 'received', 'cancelled', 'on_hold')),
	CONSTRAINT "purchase_supplier_check" CHECK("purchase"."supplier_id" IS NOT NULL OR "purchase"."supplier_name" IS NOT NULL)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `purchase_reference_unique` ON `purchase` (`reference`);--> statement-breakpoint
CREATE INDEX `purchase_supplier_idx` ON `purchase` (`supplier_id`);--> statement-breakpoint
CREATE INDEX `purchase_status_idx` ON `purchase` (`status`);--> statement-breakpoint
CREATE TABLE `purchase_expense` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`purchase_id` integer NOT NULL,
	`kind` text NOT NULL,
	`purchase_line_id` integer,
	`part_id` integer,
	`quantity` integer,
	`unit_cost` integer,
	`amount` integer,
	`at` text NOT NULL,
	`notes` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`purchase_id`) REFERENCES `purchase`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`purchase_line_id`) REFERENCES `purchase_line`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`part_id`) REFERENCES `part`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "purchase_expense_kind_check" CHECK("kind" IN ('receipt', 'shipping', 'tax', 'duty', 'fee', 'other')),
	CONSTRAINT "purchase_expense_shape_check" CHECK(("purchase_expense"."kind" = 'receipt' AND "purchase_expense"."quantity" IS NOT NULL AND "purchase_expense"."part_id" IS NOT NULL AND "purchase_expense"."amount" IS NULL)
				OR ("purchase_expense"."kind" <> 'receipt' AND "purchase_expense"."amount" IS NOT NULL AND "purchase_expense"."quantity" IS NULL AND "purchase_expense"."part_id" IS NULL))
);
--> statement-breakpoint
CREATE INDEX `purchase_expense_purchase_idx` ON `purchase_expense` (`purchase_id`);--> statement-breakpoint
CREATE TABLE `purchase_line` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`purchase_id` integer NOT NULL,
	`part_id` integer NOT NULL,
	`qty_ordered` integer NOT NULL,
	`unit_cost` integer,
	`destination` text,
	`notes` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`purchase_id`) REFERENCES `purchase`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`part_id`) REFERENCES `part`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "purchase_line_qty_check" CHECK("purchase_line"."qty_ordered" > 0)
);
--> statement-breakpoint
CREATE INDEX `purchase_line_purchase_idx` ON `purchase_line` (`purchase_id`);--> statement-breakpoint
CREATE INDEX `purchase_line_part_idx` ON `purchase_line` (`part_id`);--> statement-breakpoint
CREATE TABLE `supplier` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`code` text,
	`description` text,
	`website` text,
	`email` text,
	`phone` text,
	`address` text,
	`notes` text,
	`is_active` integer DEFAULT true NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `supplier_code_unique` ON `supplier` (`code`);--> statement-breakpoint
CREATE INDEX `supplier_name_idx` ON `supplier` (`name`);--> statement-breakpoint
CREATE TABLE `supplier_part` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`supplier_id` integer NOT NULL,
	`part_id` integer NOT NULL,
	`vendor_pn` text NOT NULL,
	`is_preferred` integer DEFAULT false NOT NULL,
	`lead_time_days` integer,
	`notes` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`supplier_id`) REFERENCES `supplier`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`part_id`) REFERENCES `part`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `supplier_part_part_idx` ON `supplier_part` (`part_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `supplier_part_unique` ON `supplier_part` (`supplier_id`,`part_id`);--> statement-breakpoint
CREATE TABLE `kit_item` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`procedure_id` integer,
	`step_id` integer,
	`part_id` integer NOT NULL,
	`quantity` integer NOT NULL,
	`usage` text DEFAULT 'consume' NOT NULL,
	`notes` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`procedure_id`) REFERENCES `procedure`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`step_id`) REFERENCES `procedure_step`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`part_id`) REFERENCES `part`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "kit_item_one_scope" CHECK(("procedure_id" IS NULL) <> ("step_id" IS NULL)),
	CONSTRAINT "kit_item_quantity_positive" CHECK("quantity" > 0),
	CONSTRAINT "kit_item_usage_check" CHECK("usage" IN ('consume', 'tooling'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `kit_item_procedure_part` ON `kit_item` (`procedure_id`,`part_id`) WHERE "procedure_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `kit_item_step_part` ON `kit_item` (`step_id`,`part_id`) WHERE "step_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `kit_item_part_idx` ON `kit_item` (`part_id`);--> statement-breakpoint
CREATE TABLE `procedure` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`template_number` text NOT NULL,
	`project_id` integer NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`procedure_type` text DEFAULT 'op' NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`current_version_id` integer,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`current_version_id`) REFERENCES `procedure_version`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "procedure_type_check" CHECK("procedure_type" IN ('op', 'build')),
	CONSTRAINT "procedure_status_check" CHECK("status" IN ('draft', 'released', 'obsolete'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `procedure_template_number_unique` ON `procedure` (`template_number`);--> statement-breakpoint
CREATE INDEX `procedure_status_idx` ON `procedure` (`status`);--> statement-breakpoint
CREATE INDEX `procedure_project_idx` ON `procedure` (`project_id`);--> statement-breakpoint
CREATE TABLE `procedure_output` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`procedure_id` integer NOT NULL,
	`part_id` integer NOT NULL,
	`quantity` integer DEFAULT 10000 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`procedure_id`) REFERENCES `procedure`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`part_id`) REFERENCES `part`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "procedure_output_quantity_positive" CHECK("quantity" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `procedure_output_pair` ON `procedure_output` (`procedure_id`,`part_id`);--> statement-breakpoint
CREATE INDEX `procedure_output_part_idx` ON `procedure_output` (`part_id`);--> statement-breakpoint
CREATE TABLE `procedure_step` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`procedure_id` integer NOT NULL,
	`parent_step_id` integer,
	`position` integer DEFAULT 0 NOT NULL,
	`is_contingency` integer DEFAULT false NOT NULL,
	`title` text NOT NULL,
	`instructions` text,
	`data_schema` text,
	`signoffs` text,
	`estimated_duration_minutes` integer,
	`callouts` text DEFAULT '[]' NOT NULL,
	`strict_sequence` integer DEFAULT false NOT NULL,
	`workcenter_id` integer,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`procedure_id`) REFERENCES `procedure`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`parent_step_id`) REFERENCES `procedure_step`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`workcenter_id`) REFERENCES `workcenter`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "procedure_step_not_own_parent" CHECK("parent_step_id" IS NULL OR "parent_step_id" <> "id")
);
--> statement-breakpoint
CREATE INDEX `procedure_step_procedure_idx` ON `procedure_step` (`procedure_id`);--> statement-breakpoint
CREATE INDEX `procedure_step_parent_idx` ON `procedure_step` (`parent_step_id`);--> statement-breakpoint
CREATE INDEX `procedure_step_workcenter_idx` ON `procedure_step` (`workcenter_id`);--> statement-breakpoint
CREATE TABLE `procedure_version` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`procedure_id` integer NOT NULL,
	`version_number` integer NOT NULL,
	`content` text NOT NULL,
	`change_note` text,
	`created_by_id` integer,
	`created_at` text NOT NULL,
	FOREIGN KEY (`procedure_id`) REFERENCES `procedure`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `procedure_version_number` ON `procedure_version` (`procedure_id`,`version_number`);--> statement-breakpoint
CREATE TABLE `step_dependency` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`step_id` integer NOT NULL,
	`depends_on_step_id` integer NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`step_id`) REFERENCES `procedure_step`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`depends_on_step_id`) REFERENCES `procedure_step`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "step_dependency_not_self" CHECK("step_id" <> "depends_on_step_id")
);
--> statement-breakpoint
CREATE UNIQUE INDEX `step_dependency_pair` ON `step_dependency` (`step_id`,`depends_on_step_id`);--> statement-breakpoint
CREATE INDEX `step_dependency_depends_idx` ON `step_dependency` (`depends_on_step_id`);--> statement-breakpoint
CREATE TABLE `step_image` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`step_id` integer NOT NULL,
	`attachment_id` integer NOT NULL,
	`caption` text,
	`position` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`step_id`) REFERENCES `procedure_step`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`attachment_id`) REFERENCES `attachment`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `step_image_attachment_id_unique` ON `step_image` (`attachment_id`);--> statement-breakpoint
CREATE INDEX `step_image_step_idx` ON `step_image` (`step_id`);--> statement-breakpoint
CREATE TABLE `issue` (
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
	CONSTRAINT "issue_disposition_check" CHECK("disposition_type" IN ('use_as_is', 'rework', 'repair', 'scrap', 'return_to_supplier', 'no_defect'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `issue_issue_number_unique` ON `issue` (`issue_number`);--> statement-breakpoint
CREATE INDEX `issue_status_idx` ON `issue` (`status`);--> statement-breakpoint
CREATE INDEX `issue_project_idx` ON `issue` (`project_id`);--> statement-breakpoint
CREATE INDEX `issue_assignee_idx` ON `issue` (`assigned_to_id`);--> statement-breakpoint
CREATE INDEX `issue_execution_idx` ON `issue` (`execution_id`);--> statement-breakpoint
CREATE TABLE `issue_comment` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`issue_id` integer NOT NULL,
	`user_id` integer,
	`body` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`issue_id`) REFERENCES `issue`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `issue_comment_issue_idx` ON `issue_comment` (`issue_id`);--> statement-breakpoint
CREATE TABLE `issue_link` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`issue_id` integer NOT NULL,
	`part_id` integer,
	`risk_id` integer,
	`risk_role` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`issue_id`) REFERENCES `issue`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`part_id`) REFERENCES `part`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`risk_id`) REFERENCES `risk`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "issue_link_one_target_check" CHECK((CASE WHEN "part_id" IS NOT NULL THEN 1 ELSE 0 END) + (CASE WHEN "risk_id" IS NOT NULL THEN 1 ELSE 0 END) = 1),
	CONSTRAINT "issue_link_risk_role_check" CHECK(("risk_id" IS NULL) = ("risk_role" IS NULL))
);
--> statement-breakpoint
CREATE INDEX `issue_link_issue_idx` ON `issue_link` (`issue_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `issue_link_part_uq` ON `issue_link` (`issue_id`,`part_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `issue_link_risk_uq` ON `issue_link` (`issue_id`,`risk_id`);--> statement-breakpoint
CREATE TABLE `risk` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`risk_number` text NOT NULL,
	`project_id` integer NOT NULL,
	`title` text NOT NULL,
	`description` text,
	`condition` text,
	`departure` text,
	`asset_part_id` integer,
	`asset_text` text,
	`consequence` text,
	`disposition` text DEFAULT 'open' NOT NULL,
	`disposition_note` text,
	`owner_id` integer,
	`probability` integer DEFAULT 3 NOT NULL,
	`impact` integer DEFAULT 3 NOT NULL,
	`residual_probability` integer,
	`residual_impact` integer,
	`accepted_by_id` integer,
	`accepted_at` text,
	`acceptance_rationale` text,
	`watch_observable` text,
	`watch_threshold` text,
	`watch_contingency` text,
	`last_reviewed_at` text,
	`last_reviewed_by_id` integer,
	`realized_issue_id` integer,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`asset_part_id`) REFERENCES `part`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`owner_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`accepted_by_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`last_reviewed_by_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`realized_issue_id`) REFERENCES `issue`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "risk_disposition_check" CHECK("disposition" IN ('open', 'mitigate', 'watch', 'research', 'accepted', 'closed', 'realized')),
	CONSTRAINT "risk_probability_check" CHECK("probability" BETWEEN 1 AND 5),
	CONSTRAINT "risk_impact_check" CHECK("impact" BETWEEN 1 AND 5),
	CONSTRAINT "risk_residual_probability_check" CHECK("residual_probability" IS NULL OR "residual_probability" BETWEEN 1 AND 5),
	CONSTRAINT "risk_residual_impact_check" CHECK("residual_impact" IS NULL OR "residual_impact" BETWEEN 1 AND 5),
	CONSTRAINT "risk_one_asset_check" CHECK("asset_part_id" IS NULL OR "asset_text" IS NULL)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `risk_risk_number_unique` ON `risk` (`risk_number`);--> statement-breakpoint
CREATE INDEX `risk_disposition_idx` ON `risk` (`disposition`);--> statement-breakpoint
CREATE INDEX `risk_project_idx` ON `risk` (`project_id`);--> statement-breakpoint
CREATE INDEX `risk_owner_idx` ON `risk` (`owner_id`);--> statement-breakpoint
CREATE INDEX `risk_asset_part_idx` ON `risk` (`asset_part_id`);--> statement-breakpoint
CREATE INDEX `risk_realized_issue_idx` ON `risk` (`realized_issue_id`);--> statement-breakpoint
CREATE TABLE `risk_reference` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`risk_id` integer NOT NULL,
	`reference_type` text NOT NULL,
	`reference_value` text NOT NULL,
	`notes` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`risk_id`) REFERENCES `risk`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "risk_reference_type_check" CHECK("reference_type" IN ('opal', 'work_order'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `risk_reference_uq` ON `risk_reference` (`risk_id`,`reference_type`,`reference_value`);--> statement-breakpoint
CREATE INDEX `risk_reference_value_idx` ON `risk_reference` (`reference_value`);--> statement-breakpoint
CREATE TABLE `baseline_event` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` integer NOT NULL,
	`label` text,
	`note` text,
	`signed_by_id` integer,
	`created_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`signed_by_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `baseline_event_item` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`event_id` integer NOT NULL,
	`requirement_id` integer NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `baseline_event`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`requirement_id`) REFERENCES `requirement`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `baseline_event_item_uq` ON `baseline_event_item` (`event_id`,`requirement_id`);--> statement-breakpoint
CREATE INDEX `baseline_event_item_req_idx` ON `baseline_event_item` (`requirement_id`);--> statement-breakpoint
CREATE TABLE `part_requirement` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`part_id` integer NOT NULL,
	`requirement_id` integer NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`notes` text,
	`verified_at` text,
	`verified_by_id` integer,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`part_id`) REFERENCES `part`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`requirement_id`) REFERENCES `requirement`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`verified_by_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "part_requirement_status_check" CHECK("status" IN ('open', 'verified', 'waived', 'not_applicable'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `part_requirement_uq` ON `part_requirement` (`part_id`,`requirement_id`);--> statement-breakpoint
CREATE INDEX `part_requirement_req_idx` ON `part_requirement` (`requirement_id`);--> statement-breakpoint
CREATE TABLE `requirement` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`req_number` text NOT NULL,
	`project_id` integer NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`lifecycle_state` text DEFAULT 'draft' NOT NULL,
	`title` text NOT NULL,
	`statement` text NOT NULL,
	`rationale` text,
	`category` text,
	`parent_id` integer,
	`level` integer DEFAULT 0 NOT NULL,
	`verification_method` text,
	`tbd` integer DEFAULT false NOT NULL,
	`tbr` integer DEFAULT false NOT NULL,
	`tbr_owner_id` integer,
	`tbr_due` text,
	`stale` integer DEFAULT false NOT NULL,
	`baselined_at` text,
	`baselined_by_id` integer,
	`supersedes_id` integer,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`parent_id`) REFERENCES `requirement`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`tbr_owner_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`baselined_by_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`supersedes_id`) REFERENCES `requirement`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "requirement_state_check" CHECK("lifecycle_state" IN ('draft', 'preliminary', 'baselined', 'superseded', 'cancelled')),
	CONSTRAINT "requirement_verification_check" CHECK("verification_method" IN ('analysis', 'inspection', 'demonstration', 'test'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `requirement_number_revision_uq` ON `requirement` (`req_number`,`revision`);--> statement-breakpoint
CREATE INDEX `requirement_parent_idx` ON `requirement` (`parent_id`);--> statement-breakpoint
CREATE INDEX `requirement_project_idx` ON `requirement` (`project_id`);--> statement-breakpoint
CREATE INDEX `requirement_state_idx` ON `requirement` (`lifecycle_state`);--> statement-breakpoint
CREATE TABLE `data_point` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`dataset_id` integer NOT NULL,
	`recorded_at` text NOT NULL,
	`values` text NOT NULL,
	`step_execution_id` integer,
	`created_at` text NOT NULL,
	FOREIGN KEY (`dataset_id`) REFERENCES `dataset`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `data_point_dataset_time_idx` ON `data_point` (`dataset_id`,`recorded_at`);--> statement-breakpoint
CREATE INDEX `data_point_step_execution_idx` ON `data_point` (`step_execution_id`);--> statement-breakpoint
CREATE TABLE `dataset` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` integer NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`schema` text NOT NULL,
	`procedure_id` integer,
	`state` text DEFAULT 'active' NOT NULL,
	`archived_at` text,
	`archived_by_id` integer,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`archived_by_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "dataset_state_check" CHECK("state" IN ('active', 'archived'))
);
--> statement-breakpoint
CREATE INDEX `dataset_name_idx` ON `dataset` (`name`);--> statement-breakpoint
CREATE INDEX `dataset_project_idx` ON `dataset` (`project_id`);--> statement-breakpoint
CREATE INDEX `dataset_procedure_idx` ON `dataset` (`procedure_id`);