/**
 * Tables for the plugins area. A plugin runs as its own process with its own
 * user, so audit rows name the plugin. Files live in <data>/plugins/<id>/<sha>/.
 */
import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { LINK_ENTITIES, type PluginManifest } from '@opal/shared';
import { createdAt, id, oneOf, updatedAt } from './helpers.ts';
import { user } from './core.ts';

export const plugin = sqliteTable('plugin', {
	id: id(),
	/** The manifest id: `kaneo`. */
	key: text('key').notNull().unique(),
	/** `github:owner/repo` or `local:/abs/path` (development only). */
	source: text('source').notNull(),
	/** The ref the admin asked for (tag or branch). Null: the default branch. */
	ref: text('ref'),
	/** Installed commit, or `local`. */
	sha: text('sha').notNull(),
	/** The previous commit, kept on disk for one rollback. */
	previousSha: text('previous_sha'),
	version: text('version').notNull(),
	manifest: text('manifest', { mode: 'json' }).$type<PluginManifest>().notNull(),
	enabled: integer('enabled', { mode: 'boolean' }).notNull().default(false),
	/** The plugin's own user. It has no password and cannot sign in. */
	userId: integer('user_id')
		.notNull()
		.references(() => user.id),
	createdAt: createdAt(),
	updatedAt: updatedAt()
});

/** One value per setting. The audit log redacts `value` when `secret` is set. */
export const pluginSetting = sqliteTable(
	'plugin_setting',
	{
		id: id(),
		pluginId: integer('plugin_id')
			.notNull()
			.references(() => plugin.id, { onDelete: 'cascade' }),
		key: text('key').notNull(),
		value: text('value', { mode: 'json' }),
		secret: integer('secret', { mode: 'boolean' }).notNull().default(false),
		createdAt: createdAt(),
		updatedAt: updatedAt()
	},
	(t) => [uniqueIndex('plugin_setting_key').on(t.pluginId, t.key)]
);

/** A record's counterpart in another system, written by the plugin that syncs it. */
export const externalLink = sqliteTable(
	'external_link',
	{
		id: id(),
		pluginId: integer('plugin_id')
			.notNull()
			.references(() => plugin.id),
		entityType: text('entity_type', { enum: LINK_ENTITIES }).notNull(),
		entityId: integer('entity_id').notNull(),
		externalId: text('external_id').notNull(),
		url: text('url').notNull(),
		label: text('label'),
		createdAt: createdAt(),
		updatedAt: updatedAt()
	},
	(t) => [
		uniqueIndex('external_link_key').on(t.pluginId, t.entityType, t.entityId, t.externalId),
		index('external_link_entity_idx').on(t.entityType, t.entityId),
		oneOf('external_link_entity_check', 'entity_type', LINK_ENTITIES)
	]
);
