/** Tables for the org area: profiles, roles, gates, workcenters, app settings. */
import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { PROJECT_STATES } from '@opal/shared';
import { createdAt, id, oneOf, updatedAt } from './helpers.ts';
import { user } from './core.ts';

/** Runtime-mutable key/value settings. `project_config` holds the organization settings as JSON. */
export const appSetting = sqliteTable('app_setting', {
	id: id(),
	key: text('key').notNull().unique(),
	value: text('value'),
	createdAt: createdAt(),
	updatedAt: updatedAt()
});

export const workcenter = sqliteTable('workcenter', {
	id: id(),
	name: text('name').notNull(),
	code: text('code').notNull().unique(),
	description: text('description'),
	location: text('location'),
	isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
	createdAt: createdAt(),
	updatedAt: updatedAt()
});

/** Profile fields of a user: one row per user, created on first write. */
export const userProfile = sqliteTable('user_profile', {
	id: id(),
	userId: integer('user_id')
		.notNull()
		.unique()
		.references(() => user.id, { onDelete: 'cascade' }),
	jobTitle: text('job_title'),
	phone: text('phone'),
	workcenterId: integer('workcenter_id').references(() => workcenter.id, { onDelete: 'set null' }),
	/** SHA-256 of the avatar bytes; the file is `avatars/<hash>` in the data folder. */
	avatarHash: text('avatar_hash'),
	avatarMime: text('avatar_mime'),
	/** upload | oidc | removed (removed: do not refill from the identity provider) */
	avatarSource: text('avatar_source'),
	avatarUpdatedAt: text('avatar_updated_at'),
	/** How the UI shows times: local (the browser's zone) or utc. Storage stays UTC. */ // added by time-display
	timeDisplay: text('time_display', { enum: ['local', 'utc'] }).notNull().default('local'),
	needsProfileSetup: integer('needs_profile_setup', { mode: 'boolean' }).notNull().default(false),
	needsOnboarding: integer('needs_onboarding', { mode: 'boolean' }).notNull().default(true),
	createdAt: createdAt(),
	updatedAt: updatedAt()
});

export const role = sqliteTable('role', {
	id: id(),
	/** Unique ignoring case; the stored casing is what sign-offs show. */
	name: text('name').notNull(),
	description: text('description'),
	/** Stable key of a system role: engineer, technician, quality, admin. */
	key: text('key').unique(),
	isSystem: integer('is_system', { mode: 'boolean' }).notNull().default(false),
	createdAt: createdAt(),
	updatedAt: updatedAt()
}, (t) => [uniqueIndex('role_name_nocase').on(t.name)]);

export const userRole = sqliteTable(
	'user_role',
	{
		id: id(),
		userId: integer('user_id')
			.notNull()
			.references(() => user.id, { onDelete: 'cascade' }),
		roleId: integer('role_id')
			.notNull()
			.references(() => role.id, { onDelete: 'cascade' }),
		grantedById: integer('granted_by_id').references(() => user.id, { onDelete: 'set null' }),
		grantedAt: text('granted_at').notNull()
	},
	(t) => [uniqueIndex('user_role_unique').on(t.userId, t.roleId), index('user_role_role_idx').on(t.roleId)]
);

export const roleGate = sqliteTable(
	'role_gate',
	{
		id: id(),
		roleId: integer('role_id')
			.notNull()
			.references(() => role.id, { onDelete: 'cascade' }),
		gate: text('gate').notNull()
	},
	(t) => [uniqueIndex('role_gate_unique').on(t.roleId, t.gate)]
);

/**
 * A project: the scope of requirements, risks, issues, procedures, executions and datasets.
 * Archived is terminal; a referenced project is never deleted.
 */
export const project = sqliteTable(
	'project',
	{
		id: id(),
		code: text('code').notNull().unique(),
		name: text('name').notNull(),
		description: text('description'),
		state: text('state', { enum: PROJECT_STATES }).notNull().default('active'),
		archivedAt: text('archived_at'),
		createdAt: createdAt(),
		updatedAt: updatedAt()
	},
	(t) => [oneOf('project_state_check', 'state', PROJECT_STATES)]
);
