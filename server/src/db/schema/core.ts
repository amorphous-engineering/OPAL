/** Identity, sessions, tokens and the audit log. */
import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

import { createdAt, id, oneOf, updatedAt } from './helpers.ts';

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
		/** One id per operation call: every row one call wrote shares it (undo reverses a whole call). */
		invocation: text('invocation'),
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

/** Counters behind human identifiers: OPAL-00001, WO-00001, IT-00001, ... One row per prefix. */
export const designatorSequence = sqliteTable('designator_sequence', {
	prefix: text('prefix').primaryKey(),
	lastValue: integer('last_value').notNull().default(0)
});
