/**
 * Tables for the requirements area.
 *
 * A revision is its own row. Rows of one requirement share `req_number` and differ in
 * `revision`; `supersedes_id` points at the prior row. A requirement is never soft-deleted:
 * a draft nothing references is removed, anything else is cancelled or superseded.
 */
import {
	REQUIREMENT_ALLOCATION_STATUSES,
	REQUIREMENT_LIFECYCLE_STATES,
	REQUIREMENT_VERIFICATION_METHODS
} from '@opal/shared';
import {
	type AnySQLiteColumn,
	index,
	integer,
	sqliteTable,
	text,
	uniqueIndex
} from 'drizzle-orm/sqlite-core';
import { user } from './core.ts';
import { createdAt, id, oneOf, updatedAt } from './helpers.ts';
import { project } from './org.ts'; // added by projects
import { part } from './parts.ts';

const userRef = (name: string) =>
	integer(name).references(() => user.id, { onDelete: 'set null' });

export const requirement = sqliteTable(
	'requirement',
	{
		id: id(),
		/** `REQ-0042`. Handed out once, never reused. */
		reqNumber: text('req_number').notNull(),
		projectId: integer('project_id') // added by projects
			.notNull()
			.references(() => project.id),
		revision: integer('revision').notNull().default(1),
		lifecycleState: text('lifecycle_state', { enum: REQUIREMENT_LIFECYCLE_STATES })
			.notNull()
			.default('draft'),
		title: text('title').notNull(),
		/** The shall statement: exactly one thought. */
		statement: text('statement').notNull(),
		rationale: text('rationale'),
		category: text('category'),
		/** Flow-down parent. Level-0 roots have none. */
		parentId: integer('parent_id').references((): AnySQLiteColumn => requirement.id, {
			onDelete: 'set null'
		}),
		/** 0 mission, 1 system, 2 subsystem, ... */
		level: integer('level').notNull().default(0),
		verificationMethod: text('verification_method', { enum: REQUIREMENT_VERIFICATION_METHODS }),
		tbd: integer('tbd', { mode: 'boolean' }).notNull().default(false),
		tbr: integer('tbr', { mode: 'boolean' }).notNull().default(false),
		tbrOwnerId: userRef('tbr_owner_id'),
		tbrDue: text('tbr_due'),
		/** The parent was revised after this row last got a fresh look. Informational only. */
		stale: integer('stale', { mode: 'boolean' }).notNull().default(false),
		baselinedAt: text('baselined_at'),
		baselinedById: userRef('baselined_by_id'),
		supersedesId: integer('supersedes_id').references((): AnySQLiteColumn => requirement.id, {
			onDelete: 'set null'
		}),
		createdAt: createdAt(),
		updatedAt: updatedAt()
	},
	(t) => [
		uniqueIndex('requirement_number_revision_uq').on(t.reqNumber, t.revision),
		index('requirement_parent_idx').on(t.parentId),
		index('requirement_project_idx').on(t.projectId), // added by projects
		index('requirement_state_idx').on(t.lifecycleState),
		oneOf('requirement_state_check', 'lifecycle_state', REQUIREMENT_LIFECYCLE_STATES),
		oneOf('requirement_verification_check', 'verification_method', REQUIREMENT_VERIFICATION_METHODS)
	]
);

/** One baseline commitment: a queue batch or a single baseline. */
export const baselineEvent = sqliteTable('baseline_event', {
	id: id(),
	projectId: integer('project_id') // added by projects
		.notNull()
		.references(() => project.id),
	label: text('label'),
	note: text('note'),
	signedById: userRef('signed_by_id'),
	createdAt: createdAt()
});

/** The exact revision rows an event locked. */
export const baselineEventItem = sqliteTable(
	'baseline_event_item',
	{
		id: id(),
		eventId: integer('event_id')
			.notNull()
			.references(() => baselineEvent.id, { onDelete: 'cascade' }),
		requirementId: integer('requirement_id')
			.notNull()
			.references(() => requirement.id),
		createdAt: createdAt()
	},
	(t) => [
		uniqueIndex('baseline_event_item_uq').on(t.eventId, t.requirementId),
		index('baseline_event_item_req_idx').on(t.requirementId)
	]
);

/** A requirement allocated to a part, with its verification status. */
export const partRequirement = sqliteTable(
	'part_requirement',
	{
		id: id(),
		partId: integer('part_id')
			.notNull()
			.references(() => part.id),
		requirementId: integer('requirement_id')
			.notNull()
			.references(() => requirement.id),
		status: text('status', { enum: REQUIREMENT_ALLOCATION_STATUSES }).notNull().default('open'),
		notes: text('notes'),
		verifiedAt: text('verified_at'),
		verifiedById: userRef('verified_by_id'),
		createdAt: createdAt(),
		updatedAt: updatedAt()
	},
	(t) => [
		uniqueIndex('part_requirement_uq').on(t.partId, t.requirementId),
		index('part_requirement_req_idx').on(t.requirementId),
		oneOf('part_requirement_status_check', 'status', REQUIREMENT_ALLOCATION_STATUSES)
	]
);
