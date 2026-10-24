import {
	CONTAINMENTS,
	DISPOSITION_TYPES,
	ISSUE_PRIORITIES,
	ISSUE_STATUSES,
	ISSUE_TYPES,
	RISK_ISSUE_ROLES // added by risks
} from '@opal/shared';
import { sql } from 'drizzle-orm';
import { type AnySQLiteColumn, check, index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { user } from './core.ts';
import { execution, stepExecution } from './execution.ts'; // added by execution
import { createdAt, id, oneOf, updatedAt } from './helpers.ts';
import { project } from './org.ts'; // added by projects
import { part } from './parts.ts';
import { risk } from './risks.ts'; // added by risks

const userRef = (name: string) =>
	integer(name).references(() => user.id, { onDelete: 'set null' });

/**
 * Tickets of every type. Typed columns stay in one table (decision O2). The ticket
 * state is derived from the stamps below and is never stored.
 *
 * Anchors into the execution area are plain integers until that area's tables exist.
 * It adds the foreign keys: execution_id -> execution(id) and the two step columns ->
 * step_execution(id), all ON DELETE SET NULL.
 */
export const issue = sqliteTable(
	'issue',
	{
		id: id(),
		issueNumber: text('issue_number').notNull().unique(),
		projectId: integer('project_id') // added by projects
			.notNull()
			.references(() => project.id),
		title: text('title').notNull(),
		description: text('description'),
		issueType: text('issue_type', { enum: ISSUE_TYPES }).notNull().default('task'),
		status: text('status', { enum: ISSUE_STATUSES }).notNull().default('open'),
		priority: text('priority', { enum: ISSUE_PRIORITIES }).notNull().default('medium'),

		containment: text('containment', { enum: CONTAINMENTS }).notNull().default('advisory'),
		/** The step that cannot complete until disposition ("resolve by 3.7"). No FK yet. */
		containmentStepId: integer('containment_step_id').references((): AnySQLiteColumn => stepExecution.id, { onDelete: 'set null' }), // added by execution
		/** The execution (work order) this issue holds. No FK yet. */
		executionId: integer('execution_id').references((): AnySQLiteColumn => execution.id, { onDelete: 'set null' }), // added by execution
		/** The step the issue was raised from. No FK yet. */
		raisedStepId: integer('raised_step_id').references((): AnySQLiteColumn => stepExecution.id, { onDelete: 'set null' }), // added by execution

		shouldBe: text('should_be'),
		actual: text('actual'),
		stepsToReproduce: text('steps_to_reproduce'),
		expectedBehavior: text('expected_behavior'),
		actualBehavior: text('actual_behavior'),
		expectedBenefit: text('expected_benefit'),

		rootCause: text('root_cause'),
		correctiveAction: text('corrective_action'),
		dispositionType: text('disposition_type', { enum: DISPOSITION_TYPES }),
		dispositionRationale: text('disposition_rationale'),
		dispositionedAt: text('dispositioned_at'),
		dispositionedById: userRef('dispositioned_by_id'),

		workStartedAt: text('work_started_at'),
		workStartedById: userRef('work_started_by_id'),
		reviewRequestedAt: text('review_requested_at'),
		reviewRequestedById: userRef('review_requested_by_id'),
		closedAt: text('closed_at'),
		closedById: userRef('closed_by_id'),

		raisedById: userRef('raised_by_id'),
		assignedToId: userRef('assigned_to_id'),
		createdAt: createdAt(),
		updatedAt: updatedAt()
	},
	(t) => [
		index('issue_status_idx').on(t.status),
		index('issue_project_idx').on(t.projectId), // added by projects
		index('issue_assignee_idx').on(t.assignedToId),
		index('issue_execution_idx').on(t.executionId),
		oneOf('issue_type_check', 'issue_type', ISSUE_TYPES),
		oneOf('issue_status_check', 'status', ISSUE_STATUSES),
		oneOf('issue_priority_check', 'priority', ISSUE_PRIORITIES),
		oneOf('issue_containment_check', 'containment', CONTAINMENTS),
		oneOf('issue_disposition_check', 'disposition_type', DISPOSITION_TYPES)
	]
);

export const issueComment = sqliteTable(
	'issue_comment',
	{
		id: id(),
		issueId: integer('issue_id')
			.notNull()
			.references(() => issue.id, { onDelete: 'cascade' }),
		userId: userRef('user_id'),
		body: text('body').notNull(),
		createdAt: createdAt()
	},
	(t) => [index('issue_comment_issue_idx').on(t.issueId)]
);

/**
 * A typed link from an issue to another record. One nullable FK column per target kind.
 * To add a kind, an area adds its column here, adds a term to the CHECK sum and a unique
 * index, and adds the kind to ISSUE_LINK_KINDS. The CHECK keeps "exactly one target set".
 */
export const issueLink = sqliteTable(
	'issue_link',
	{
		id: id(),
		issueId: integer('issue_id')
			.notNull()
			.references(() => issue.id, { onDelete: 'cascade' }),
		partId: integer('part_id').references(() => part.id, { onDelete: 'cascade' }),
		// added by risks: the risk this issue responds to, and its role (mitigation | research)
		riskId: integer('risk_id').references(() => risk.id, { onDelete: 'cascade' }),
		riskRole: text('risk_role', { enum: RISK_ISSUE_ROLES }),
		createdAt: createdAt()
	},
	(t) => [
		index('issue_link_issue_idx').on(t.issueId),
		uniqueIndex('issue_link_part_uq').on(t.issueId, t.partId),
		uniqueIndex('issue_link_risk_uq').on(t.issueId, t.riskId), // added by risks
		check(
			'issue_link_one_target_check',
			sql.raw(
				'(CASE WHEN "part_id" IS NOT NULL THEN 1 ELSE 0 END) + (CASE WHEN "risk_id" IS NOT NULL THEN 1 ELSE 0 END) = 1' // added by risks
			)
		),
		// added by risks: a role goes with a risk target and with nothing else
		check('issue_link_risk_role_check', sql.raw('("risk_id" IS NULL) = ("risk_role" IS NULL)'))
	]
);
