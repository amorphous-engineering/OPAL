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
	type ProcedureDataSchema,
	type RedlineKitLine,
	type RedlineStrike
} from '@opal/shared';
import { sql } from 'drizzle-orm';
import { type AnySQLiteColumn, check, index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { user } from './core.ts';
import { createdAt, id, oneOf, updatedAt } from './helpers.ts';
import { issue } from './issues.ts';
import { project, workcenter } from './org.ts';
import { procedure, procedureVersion } from './procedures.ts';
import { stockMove, stockRecord } from './inventory.ts';

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
		/** When it ended: completed, voided or closed short. */
		completedAt: text('completed_at'),
		/**
		 * Why it was voided or closed short. The column keeps its old name: it holds the old
		 * abort reasons, and renaming it makes `db:generate` stop for an interactive answer.
		 */
		closeReason: text('abort_reason'),
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
 * Who struck a work order, and the issue a closed-short one cites. At most one row per order. Its
 * own table because a generated rebuild of `execution` that also adds columns copies the new
 * column names into every existing row as text; a rebuild for the status CHECK alone is faithful.
 */
export const executionClosure = sqliteTable('execution_closure', {
	id: id(),
	executionId: integer('execution_id')
		.notNull()
		.unique()
		.references(() => execution.id, { onDelete: 'cascade' }),
	closedById: integer('closed_by_id').references(() => user.id, { onDelete: 'set null' }),
	issueId: integer('issue_id').references((): AnySQLiteColumn => issue.id),
	createdAt: createdAt()
});

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
		/** Parts this step consumes. */
		kit: text('kit', { mode: 'json' }).$type<RedlineKitLine[]>(),
		/** On the OP row: the snapshot kit lines this redline replaces, struck once it is released. */
		strikes: text('strikes', { mode: 'json' }).$type<RedlineStrike[]>(),
		/**
		 * On the OP row. Null: a draft, pencil, which the floor cannot work. Signing the issue's
		 * disposition releases its drafts; a draft written after that is released on its own.
		 */
		releasedAt: text('released_at'),
		releasedById: integer('released_by_id').references(() => user.id, { onDelete: 'set null' }),
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

/**
 * A later slot set aside by the one person there, who could not sign it twice. Its own record,
 * never a signature row: every reader of `signoff` takes a row there as a person attesting. Label
 * and role are copied as a signature's are. No update or delete: it stands as written.
 */
export const signoffWaiver = sqliteTable(
	'signoff_waiver',
	{
		id: id(),
		stepExecutionId: integer('step_execution_id')
			.notNull()
			.references(() => stepExecution.id, { onDelete: 'cascade' }),
		slot: integer('slot').notNull(),
		label: text('label').notNull(),
		role: text('role'),
		reason: text('reason').notNull(),
		waivedById: integer('waived_by_id').references(() => user.id, { onDelete: 'set null' }),
		waivedAt: text('waived_at').notNull(),
		createdAt: createdAt()
	},
	(t) => [uniqueIndex('signoff_waiver_slot_uq').on(t.stepExecutionId, t.slot)]
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
 * Time worked: one row per clock-in, from claiming an OP to clocking out, moving to another
 * OP, or the OP finishing. `ended_at` null: still clocked in (a finished OP or execution ends
 * it at its own finish time; see services/execution/labor.ts).
 */
export const workInterval = sqliteTable(
	'work_interval',
	{
		id: id(),
		executionId: integer('execution_id')
			.notNull()
			.references(() => execution.id, { onDelete: 'cascade' }),
		opStepId: integer('op_step_id')
			.notNull()
			.references((): AnySQLiteColumn => stepExecution.id, { onDelete: 'cascade' }),
		userId: integer('user_id')
			.notNull()
			.references(() => user.id, { onDelete: 'cascade' }),
		startedAt: text('started_at').notNull(),
		endedAt: text('ended_at')
	},
	(t) => [index('work_interval_execution_idx').on(t.executionId, t.userId)]
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

/**
 * A unit a work order acts on, named on an OP: an existing serialized stock record, or borrowed
 * gear OPAL does not hold (text only, no OPAL number, no count). The one home of "this work order
 * acted on this unit". Use counts and a unit's work orders are queries over it.
 */
export const executionUnit = sqliteTable(
	'execution_unit',
	{
		id: id(),
		executionId: integer('execution_id')
			.notNull()
			.references(() => execution.id, { onDelete: 'cascade' }),
		stepExecutionId: integer('step_execution_id')
			.notNull()
			.references((): AnySQLiteColumn => stepExecution.id, { onDelete: 'cascade' }),
		/** The declared slot's key. Null: hardware the procedure did not list. */
		slot: text('slot'),
		stockId: integer('stock_id').references((): AnySQLiteColumn => stockRecord.id),
		borrowedName: text('borrowed_name'),
		borrowedSerial: text('borrowed_serial'),
		borrowedFrom: text('borrowed_from'),
		recordedById: integer('recorded_by_id').references(() => user.id, { onDelete: 'set null' }),
		createdAt: createdAt()
	},
	(t) => [
		index('execution_unit_execution_idx').on(t.executionId),
		index('execution_unit_stock_idx').on(t.stockId),
		uniqueIndex('execution_unit_stock_uq').on(t.executionId, t.stockId).where(sql`"stock_id" IS NOT NULL`),
		uniqueIndex('execution_unit_slot_uq').on(t.executionId, t.slot).where(sql`"slot" IS NOT NULL`),
		check('execution_unit_one_kind', sql`("stock_id" IS NULL) <> ("borrowed_name" IS NULL)`)
	]
);

/**
 * A component taken out of a unit a work order acts on. The ledger is append-only and a consume
 * move names its assembly once, so the removal is its own fact; genealogy nets it. A serialized
 * component put back on the shelf has its ledger move here; anything else is scrapped.
 */
export const componentRemoval = sqliteTable(
	'component_removal',
	{
		id: id(),
		executionId: integer('execution_id')
			.notNull()
			.references(() => execution.id),
		stepExecutionId: integer('step_execution_id')
			.notNull()
			.references((): AnySQLiteColumn => stepExecution.id),
		assemblyStockId: integer('assembly_stock_id')
			.notNull()
			.references((): AnySQLiteColumn => stockRecord.id),
		stockId: integer('stock_id')
			.notNull()
			.references((): AnySQLiteColumn => stockRecord.id),
		/** Qty units. */
		quantity: integer('quantity').notNull(),
		/** The move that put it back in stock. Null: scrapped. */
		returnMoveId: integer('return_move_id').references((): AnySQLiteColumn => stockMove.id),
		notes: text('notes'),
		removedById: integer('removed_by_id').references(() => user.id, { onDelete: 'set null' }),
		at: text('at').notNull(),
		createdAt: createdAt()
	},
	(t) => [
		index('component_removal_assembly_idx').on(t.assemblyStockId),
		index('component_removal_stock_idx').on(t.stockId),
		index('component_removal_execution_idx').on(t.executionId),
		check('component_removal_qty', sql`"quantity" > 0`)
	]
);
