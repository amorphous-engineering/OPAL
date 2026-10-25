/**
 * Tables for the execution area.
 *
 * An execution (work order) runs one published procedure version. The snapshot in that version
 * is the only home of step content. An execution stores state only: one `step_execution` row
 * per snapshot step (and per redline step), signatures, notes, who is where.
 * Holds are derived from issues and never stored.
 */
import {
	EXECUTION_PRIORITIES,
	EXECUTION_STATUSES,
	EXEC_STEP_STATUSES,
	type ProcedureDataSchema
} from '@opal/shared';
import { sql } from 'drizzle-orm';
import { type AnySQLiteColumn, check, index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { user } from './core.ts';
import { createdAt, id, oneOf, updatedAt } from './helpers.ts';
import { issue } from './issues.ts';
import { project, workcenter } from './org.ts';
import { procedure, procedureVersion } from './procedures.ts';
import { stockRecord } from './inventory.ts';

export const execution = sqliteTable(
	'execution',
	{
		id: id(),
		/** `WO-00042`, from the designator sequence. Editable, unique. */
		woNumber: text('wo_number').notNull().unique(),
		projectId: integer('project_id')
			.notNull()
			.references(() => project.id),
		procedureId: integer('procedure_id')
			.notNull()
			.references(() => procedure.id),
		/** The version that was cut. Never changes. */
		versionId: integer('version_id')
			.notNull()
			.references(() => procedureVersion.id),
		status: text('status', { enum: EXECUTION_STATUSES }).notNull().default('cut'),
		priority: text('priority', { enum: EXECUTION_PRIORITIES }).notNull().default('normal'),
		scheduledStartAt: text('scheduled_start_at'),
		targetCompletionAt: text('target_completion_at'),
		/** First completed or skipped work. */
		startedAt: text('started_at'),
		/** Completion, or the abort. */
		completedAt: text('completed_at'),
		abortReason: text('abort_reason'),
		createdById: integer('created_by_id').references(() => user.id, { onDelete: 'set null' }),
		createdAt: createdAt(),
		updatedAt: updatedAt()
	},
	(t) => [
		index('execution_project_idx').on(t.projectId),
		index('execution_procedure_idx').on(t.procedureId),
		index('execution_status_idx').on(t.status),
		oneOf('execution_status_check', 'status', EXECUTION_STATUSES),
		oneOf('execution_priority_check', 'priority', EXECUTION_PRIORITIES)
	]
);

/**
 * A redline: a step inserted into a running execution to rework a non-conformance.
 * `parent_id` null: the redline OP (it gates its host OP). Set: a sub-step of that OP.
 * Its own content lives here because it has no snapshot entry.
 */
export const adhocStep = sqliteTable(
	'adhoc_step',
	{
		id: id(),
		executionId: integer('execution_id')
			.notNull()
			.references(() => execution.id, { onDelete: 'cascade' }),
		issueId: integer('issue_id')
			.notNull()
			.references((): AnySQLiteColumn => issue.id),
		parentId: integer('parent_id').references((): AnySQLiteColumn => adhocStep.id, { onDelete: 'cascade' }),
		/** The snapshot OP this redline gates. */
		hostStepId: integer('host_step_id'),
		position: integer('position').notNull().default(0),
		/** `4R1`, `4R1.2`. R-numbers count per host OP. */
		number: text('number').notNull(),
		title: text('title').notNull(),
		instructions: text('instructions'),
		dataSchema: text('data_schema', { mode: 'json' }).$type<ProcedureDataSchema>(),
		/** Sign-off roles in slot order. Null: the default. */
		signoffs: text('signoffs', { mode: 'json' }).$type<{ role: string | null }[]>(),
		createdById: integer('created_by_id').references(() => user.id, { onDelete: 'set null' }),
		createdAt: createdAt()
	},
	(t) => [index('adhoc_step_execution_idx').on(t.executionId), index('adhoc_step_issue_idx').on(t.issueId)]
);

/**
 * The state of one step in one execution. Exactly one of `step_id` (a snapshot step, by the
 * snapshot's own step id) and `adhoc_step_id` (a redline step) is set.
 */
export const stepExecution = sqliteTable(
	'step_execution',
	{
		id: id(),
		executionId: integer('execution_id')
			.notNull()
			.references(() => execution.id, { onDelete: 'cascade' }),
		stepId: integer('step_id'),
		adhocStepId: integer('adhoc_step_id')
			.unique()
			.references((): AnySQLiteColumn => adhocStep.id, { onDelete: 'cascade' }),
		status: text('status', { enum: EXEC_STEP_STATUSES }).notNull().default('pending'),
		/** Values captured at slot 0, validated against the step data schema. */
		dataCaptured: text('data_captured', { mode: 'json' }).$type<Record<string, unknown>>(),
		skipReason: text('skip_reason'),
		startedAt: text('started_at'),
		completedAt: text('completed_at'),
		completedById: integer('completed_by_id').references(() => user.id, { onDelete: 'set null' }),
		/** Where the step was actually done. */
		workcenterId: integer('workcenter_id').references(() => workcenter.id, { onDelete: 'set null' }),
		/** Soft telemetry: first claim of the OP. Never shown as state. */
		firstFocusedAt: text('first_focused_at'),
		createdAt: createdAt(),
		updatedAt: updatedAt()
	},
	(t) => [
		index('step_execution_execution_idx').on(t.executionId),
		uniqueIndex('step_execution_snapshot_uq').on(t.executionId, t.stepId).where(sql`"step_id" IS NOT NULL`),
		check('step_execution_one_source', sql`("step_id" IS NULL) <> ("adhoc_step_id" IS NULL)`),
		oneOf('step_execution_status_check', 'status', EXEC_STEP_STATUSES)
	]
);

/** One signature on a slot of a step. Label and role are copied at signing time. */
export const signoff = sqliteTable(
	'signoff',
	{
		id: id(),
		stepExecutionId: integer('step_execution_id')
			.notNull()
			.references(() => stepExecution.id, { onDelete: 'cascade' }),
		slot: integer('slot').notNull(),
		label: text('label').notNull(),
		role: text('role'),
		signedById: integer('signed_by_id').references(() => user.id, { onDelete: 'set null' }),
		signedAt: text('signed_at').notNull(),
		createdAt: createdAt()
	},
	(t) => [uniqueIndex('signoff_slot_uq').on(t.stepExecutionId, t.slot)]
);

/** Append-only operator note. Files attach through the platform (owner type `step_note`). */
export const stepNote = sqliteTable(
	'step_note',
	{
		id: id(),
		stepExecutionId: integer('step_execution_id')
			.notNull()
			.references(() => stepExecution.id, { onDelete: 'cascade' }),
		authorId: integer('author_id').references(() => user.id, { onDelete: 'set null' }),
		body: text('body').notNull(),
		createdAt: createdAt()
	},
	(t) => [index('step_note_step_idx').on(t.stepExecutionId)]
);

/** The work order's comment thread: people talking about the run, not about one step. */
export const executionComment = sqliteTable(
	'execution_comment',
	{
		id: id(),
		executionId: integer('execution_id')
			.notNull()
			.references(() => execution.id, { onDelete: 'cascade' }),
		authorId: integer('author_id').references(() => user.id, { onDelete: 'set null' }),
		body: text('body').notNull(),
		createdAt: createdAt()
	},
	(t) => [index('execution_comment_execution_idx').on(t.executionId)]
);

/**
 * Who joined an execution and where each person works. One row per person per execution.
 * `joined_at` null: left (the claim stays). `focus_step_id` null: no claim.
 * A row with neither is deleted.
 */
export const executionParticipant = sqliteTable(
	'execution_participant',
	{
		id: id(),
		executionId: integer('execution_id')
			.notNull()
			.references(() => execution.id, { onDelete: 'cascade' }),
		userId: integer('user_id')
			.notNull()
			.references(() => user.id, { onDelete: 'cascade' }),
		joinedAt: text('joined_at'),
		focusStepId: integer('focus_step_id').references((): AnySQLiteColumn => stepExecution.id, { onDelete: 'set null' }),
		focusedAt: text('focused_at'),
		lastActiveAt: text('last_active_at').notNull()
	},
	(t) => [uniqueIndex('execution_participant_uq').on(t.executionId, t.userId)]
);

/**
 * An output planned at cut time: a stock record with its OPAL number and serial, balance zero
 * until finalize books it. Produced stock with no plan has no row here (it is a produce move
 * linked to the execution).
 */
export const executionOutput = sqliteTable(
	'execution_output',
	{
		id: id(),
		executionId: integer('execution_id')
			.notNull()
			.references(() => execution.id, { onDelete: 'cascade' }),
		stockId: integer('stock_id')
			.notNull()
			.unique()
			.references((): AnySQLiteColumn => stockRecord.id),
		/** Qty units. */
		quantity: integer('quantity').notNull(),
		createdAt: createdAt()
	},
	(t) => [index('execution_output_execution_idx').on(t.executionId), check('execution_output_qty', sql`"quantity" > 0`)]
);
