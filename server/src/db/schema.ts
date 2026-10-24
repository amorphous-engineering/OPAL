/**
 * The database schema: the one source for tables. Migrations in drizzle/
 * are generated from this file (`pnpm db:generate`) and reviewed.
 *
 * Conventions: INTEGER PRIMARY KEY AUTOINCREMENT, so ids are never reused.
 * Timestamps are ISO 8601 UTC text. Quantities are integers in Qty units.
 * Every enum column has a CHECK generated from the shared enum.
 */
import { PART_STATES, PROCUREMENT, TRACKING_TYPES } from '@opal/shared';
import { sql } from 'drizzle-orm';
import { check, index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

const id = () => integer('id').primaryKey({ autoIncrement: true });
const createdAt = () => text('created_at').notNull();
const updatedAt = () => text('updated_at').notNull();

/** CHECK (col IN (...)) from a shared enum. */
function oneOf(name: string, col: string, values: readonly string[]) {
	return check(name, sql.raw(`"${col}" IN (${values.map((v) => `'${v}'`).join(', ')})`));
}

export const user = sqliteTable('user', {
	id: id(),
	username: text('username').notNull().unique(),
	name: text('name').notNull(),
	email: text('email').unique(),
	passwordHash: text('password_hash'),
	oidcIssuer: text('oidc_issuer'),
	oidcSubject: text('oidc_subject'),
	isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
	isAdmin: integer('is_admin', { mode: 'boolean' }).notNull().default(false),
	createdAt: createdAt(),
	updatedAt: updatedAt()
});

export const session = sqliteTable(
	'session',
	{
		id: id(),
		userId: integer('user_id')
			.notNull()
			.references(() => user.id, { onDelete: 'cascade' }),
		tokenHash: text('token_hash').notNull().unique(),
		method: text('method').notNull(),
		expiresAt: text('expires_at').notNull(),
		lastSeenAt: text('last_seen_at'),
		revokedAt: text('revoked_at'),
		userAgent: text('user_agent'),
		ipAddress: text('ip_address'),
		createdAt: createdAt()
	},
	(t) => [index('session_user_idx').on(t.userId)]
);

export const apiToken = sqliteTable(
	'api_token',
	{
		id: id(),
		userId: integer('user_id')
			.notNull()
			.references(() => user.id, { onDelete: 'cascade' }),
		name: text('name').notNull(),
		tokenHash: text('token_hash').notNull().unique(),
		lastUsedAt: text('last_used_at'),
		expiresAt: text('expires_at'),
		revokedAt: text('revoked_at'),
		createdAt: createdAt()
	},
	(t) => [index('api_token_user_idx').on(t.userId)]
);

/** Written only by the audited write helpers in write.ts. */
export const auditLog = sqliteTable(
	'audit_log',
	{
		id: id(),
		at: text('at').notNull(),
		entity: text('entity').notNull(),
		entityId: integer('entity_id').notNull(),
		action: text('action').notNull(),
		op: text('op').notNull(),
		actorUserId: integer('actor_user_id').references(() => user.id, { onDelete: 'set null' }),
		actorTokenId: integer('actor_token_id').references(() => apiToken.id, {
			onDelete: 'set null'
		}),
		before: text('before', { mode: 'json' }),
		after: text('after', { mode: 'json' })
	},
	(t) => [
		index('audit_entity_idx').on(t.entity, t.entityId),
		index('audit_at_idx').on(t.at),
		oneOf('audit_action_check', 'action', ['create', 'update', 'delete'])
	]
);

export const part = sqliteTable(
	'part',
	{
		id: id(),
		internalPn: text('internal_pn').notNull().unique(),
		externalPn: text('external_pn'),
		name: text('name').notNull(),
		description: text('description'),
		category: text('category'),
		unitOfMeasure: text('unit_of_measure').notNull(),
		trackingType: text('tracking_type', { enum: TRACKING_TYPES }).notNull(),
		procurement: text('procurement', { enum: PROCUREMENT }).notNull(),
		tier: integer('tier').notNull(),
		reorderPoint: integer('reorder_point'),
		isTooling: integer('is_tooling', { mode: 'boolean' }).notNull().default(false),
		calibrationIntervalDays: integer('calibration_interval_days'),
		state: text('state', { enum: PART_STATES }).notNull().default('draft'),
		activatedAt: text('activated_at'),
		activatedById: integer('activated_by_id').references(() => user.id, {
			onDelete: 'set null'
		}),
		createdAt: createdAt(),
		updatedAt: updatedAt()
	},
	(t) => [
		index('part_state_idx').on(t.state),
		oneOf('part_tracking_check', 'tracking_type', TRACKING_TYPES),
		oneOf('part_procurement_check', 'procurement', PROCUREMENT),
		oneOf('part_state_check', 'state', PART_STATES)
	]
);
