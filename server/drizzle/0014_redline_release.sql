ALTER TABLE `adhoc_step` ADD `kit` text;--> statement-breakpoint
ALTER TABLE `adhoc_step` ADD `strikes` text;--> statement-breakpoint
ALTER TABLE `adhoc_step` ADD `released_at` text;--> statement-breakpoint
ALTER TABLE `adhoc_step` ADD `released_by_id` integer REFERENCES user(id) ON DELETE set null;--> statement-breakpoint
-- Redlines written before drafts existed went to the floor as they were written: released then, by their author.
UPDATE `adhoc_step` SET `released_at` = `created_at`, `released_by_id` = `created_by_id` WHERE `parent_id` IS NULL;--> statement-breakpoint
ALTER TABLE `issue` ADD `corrective_procedure_id` integer REFERENCES procedure(id);--> statement-breakpoint
ALTER TABLE `issue` ADD `corrective_after_version` integer;
