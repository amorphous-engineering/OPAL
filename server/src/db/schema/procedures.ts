/**
 * Tables for the procedures area.
 *
 * A procedure (template) has a draft: steps, kit items, outputs, step dependencies, step
 * images. Publishing freezes the draft into `procedure_version.content` (a ProcedureSnapshot).
 * Step numbers, document order and levels are derived from `parent_step_id`, `is_contingency`
 * and `position`; none of them is stored.
 */
import {
	KIT_USAGES,
	PROCEDURE_STATUSES,
	PROCEDURE_TYPES,
	type ProcedureCallout,
	type ProcedureDataSchema,
	type ProcedureSnapshot
} from '@opal/shared';
import { sql } from 'drizzle-orm';
import {
	type AnySQLiteColumn,
	check,
	index,
	integer,
	sqliteTable,
	text,
	uniqueIndex
} from 'drizzle-orm/sqlite-core';
import { user } from './core.ts';
import { project, workcenter } from './org.ts';
import { part } from './parts.ts';
import { attachment } from './platform.ts';
import { createdAt, id, oneOf, updatedAt } from './helpers.ts';

export const procedure = sqliteTable(
	'procedure',
	{
		id: id(),
		/** `T-0042`. Handed out once from the designator sequence, never reused. */
		templateNumber: text('template_number').notNull().unique(),
		projectId: integer('project_id')
			.notNull()
			.references(() => project.id),
		name: text('name').notNull(),
		description: text('description'),
		procedureType: text('procedure_type', { enum: PROCEDURE_TYPES }).notNull().default('op'),
		status: text('status', { enum: PROCEDURE_STATUSES }).notNull().default('draft'),
		/** The latest published version. Null until the first publish. */
		currentVersionId: integer('current_version_id').references((): AnySQLiteColumn => procedureVersion.id, {
			onDelete: 'set null'
		}),
		createdAt: createdAt(),
		updatedAt: updatedAt()
	},
	(t) => [
		index('procedure_status_idx').on(t.status),
		index('procedure_project_idx').on(t.projectId),
		oneOf('procedure_type_check', 'procedure_type', PROCEDURE_TYPES),
		oneOf('procedure_status_check', 'status', PROCEDURE_STATUSES)
	]
);

export const procedureStep = sqliteTable(
	'procedure_step',
	{
		id: id(),
		procedureId: integer('procedure_id')
			.notNull()
			.references(() => procedure.id, { onDelete: 'cascade' }),
		/** Null: a top-level OP. Set: a sub-step of that OP. */
		parentStepId: integer('parent_step_id').references((): AnySQLiteColumn => procedureStep.id, {
			onDelete: 'cascade'
		}),
		/**
		 * Index among the siblings: the sub-steps of one OP, or the OPs of one group (normal or
		 * contingency). Kept dense (0..n-1) by every structural edit.
		 */
		position: integer('position').notNull().default(0),
		/** OPs only. A sub-step follows its OP; the column is false for sub-steps. */
		isContingency: integer('is_contingency', { mode: 'boolean' }).notNull().default(false),
		title: text('title').notNull(),
		instructions: text('instructions'),
		dataSchema: text('data_schema', { mode: 'json' }).$type<ProcedureDataSchema>(),
		/**
		 * Sign-off roles in slot order. Null: the default (a leaf has one slot, an OP with
		 * sub-steps none). Labels come from the slot position and are never stored.
		 */
		signoffs: text('signoffs', { mode: 'json' }).$type<{ role: string | null }[]>(),
		estimatedDurationMinutes: integer('estimated_duration_minutes'),
		callouts: text('callouts', { mode: 'json' }).$type<ProcedureCallout[]>().notNull().default(sql`'[]'`),
		/** OPs only: sub-steps must start in order. */
		strictSequence: integer('strict_sequence', { mode: 'boolean' }).notNull().default(false),
		workcenterId: integer('workcenter_id').references(() => workcenter.id, { onDelete: 'set null' }),
		createdAt: createdAt(),
		updatedAt: updatedAt()
	},
	(t) => [
		index('procedure_step_procedure_idx').on(t.procedureId),
		index('procedure_step_parent_idx').on(t.parentStepId),
		index('procedure_step_workcenter_idx').on(t.workcenterId),
		check('procedure_step_not_own_parent', sql`"parent_step_id" IS NULL OR "parent_step_id" <> "id"`)
	]
);

/** OP-level prerequisite: `step` cannot start until `depends_on_step` is terminal. */
export const stepDependency = sqliteTable(
	'step_dependency',
	{
		id: id(),
		stepId: integer('step_id')
			.notNull()
			.references(() => procedureStep.id, { onDelete: 'cascade' }),
		dependsOnStepId: integer('depends_on_step_id')
			.notNull()
			.references(() => procedureStep.id, { onDelete: 'cascade' }),
		createdAt: createdAt()
	},
	(t) => [
		uniqueIndex('step_dependency_pair').on(t.stepId, t.dependsOnStepId),
		index('step_dependency_depends_idx').on(t.dependsOnStepId),
		check('step_dependency_not_self', sql`"step_id" <> "depends_on_step_id"`)
	]
);

/**
 * Where an attached file sits on a step: caption and display order. The file is an attachment
 * owned by the step (kind `step_image`); a snapshot freezes its blob hash, so unlinking an image
 * never changes a published version.
 */
export const stepImage = sqliteTable(
	'step_image',
	{
		id: id(),
		stepId: integer('step_id')
			.notNull()
			.references(() => procedureStep.id, { onDelete: 'cascade' }),
		attachmentId: integer('attachment_id')
			.notNull()
			.unique()
			.references(() => attachment.id, { onDelete: 'cascade' }),
		caption: text('caption'),
		position: integer('position').notNull().default(0),
		createdAt: createdAt()
	},
	(t) => [index('step_image_step_idx').on(t.stepId)]
);

/**
 * Parts a procedure needs: at procedure level (`procedure_id` set) or at one step (`step_id`
 * set). Exactly one of the two. A part appears once per scope.
 */
export const kitItem = sqliteTable(
	'kit_item',
	{
		id: id(),
		procedureId: integer('procedure_id').references(() => procedure.id, { onDelete: 'cascade' }),
		stepId: integer('step_id').references(() => procedureStep.id, { onDelete: 'cascade' }),
		partId: integer('part_id')
			.notNull()
			.references(() => part.id),
		/** Qty units. Above zero. */
		quantity: integer('quantity').notNull(),
		usage: text('usage', { enum: KIT_USAGES }).notNull().default('consume'),
		notes: text('notes'),
		createdAt: createdAt(),
		updatedAt: updatedAt()
	},
	(t) => [
		uniqueIndex('kit_item_procedure_part')
			.on(t.procedureId, t.partId)
			.where(sql`"procedure_id" IS NOT NULL`),
		uniqueIndex('kit_item_step_part').on(t.stepId, t.partId).where(sql`"step_id" IS NOT NULL`),
		index('kit_item_part_idx').on(t.partId),
		check('kit_item_one_scope', sql`("procedure_id" IS NULL) <> ("step_id" IS NULL)`),
		check('kit_item_quantity_positive', sql`"quantity" > 0`),
		oneOf('kit_item_usage_check', 'usage', KIT_USAGES)
	]
);

/** A part (usually an assembly) the procedure produces. */
export const procedureOutput = sqliteTable(
	'procedure_output',
	{
		id: id(),
		procedureId: integer('procedure_id')
			.notNull()
			.references(() => procedure.id, { onDelete: 'cascade' }),
		partId: integer('part_id')
			.notNull()
			.references(() => part.id),
		quantity: integer('quantity').notNull().default(10000),
		createdAt: createdAt(),
		updatedAt: updatedAt()
	},
	(t) => [
		uniqueIndex('procedure_output_pair').on(t.procedureId, t.partId),
		index('procedure_output_part_idx').on(t.partId),
		check('procedure_output_quantity_positive', sql`"quantity" > 0`)
	]
);

/** An immutable published snapshot. Never updated, never deleted. */
export const procedureVersion = sqliteTable(
	'procedure_version',
	{
		id: id(),
		procedureId: integer('procedure_id')
			.notNull()
			.references(() => procedure.id),
		versionNumber: integer('version_number').notNull(),
		content: text('content', { mode: 'json' }).$type<ProcedureSnapshot>().notNull(),
		changeNote: text('change_note'),
		createdById: integer('created_by_id').references(() => user.id, { onDelete: 'set null' }),
		createdAt: createdAt()
	},
	(t) => [uniqueIndex('procedure_version_number').on(t.procedureId, t.versionNumber)]
);
