/** Plugin rows, their files on disk, their settings, and the views the API returns. */
import { and, eq } from 'drizzle-orm';
import { join } from 'node:path';
import { notFound, type PluginDetail, type PluginSummary } from '@opal/shared';
import type { Db } from '../../db/client.ts';
import { plugin, pluginSetting, user } from '../../db/schema/index.ts';
import { dataDir } from '../../paths.ts';
import { runtime } from './runtime.ts';

export type PluginRow = typeof plugin.$inferSelect;

/** <data>/plugins: one folder per plugin, one subfolder per installed commit. */
export const pluginsRoot = () => join(dataDir(), 'plugins');
export const pluginDir = (key: string, sha: string) => join(pluginsRoot(), key, sha);
/** State the plugin keeps across updates (OPAL_PLUGIN_DATA). */
export const pluginDataDir = (key: string) => join(dataDir(), 'plugin-data', key);

/** Folder the plugin runs from: a local source runs in place. */
export function codeDir(row: PluginRow): string {
	return row.source.startsWith('local:') ? row.source.slice('local:'.length) : pluginDir(row.key, row.sha);
}

export function findPlugin(db: Db, key: string): PluginRow | undefined {
	return db.select().from(plugin).where(eq(plugin.key, key)).get();
}

export function getPlugin(db: Db, key: string): PluginRow {
	const row = findPlugin(db, key);
	if (!row) throw notFound(`Plugin ${key}`);
	return row;
}

/** The plugin a user belongs to (a plugin token's actor), if any. */
export function pluginOfUser(db: Db, userId: number): PluginRow | undefined {
	return db.select().from(plugin).where(eq(plugin.userId, userId)).get();
}

/** Every stored value, secrets included: for the plugin process only. */
export function settingValues(db: Db, row: PluginRow): Record<string, unknown> {
	const stored = db.select().from(pluginSetting).where(eq(pluginSetting.pluginId, row.id)).all();
	const out: Record<string, unknown> = {};
	for (const def of row.manifest.settings) if (def.default !== undefined) out[def.key] = def.default;
	for (const s of stored) out[s.key] = s.value;
	return out;
}

export function settingRow(db: Db, pluginId: number, key: string) {
	return db
		.select()
		.from(pluginSetting)
		.where(and(eq(pluginSetting.pluginId, pluginId), eq(pluginSetting.key, key)))
		.get();
}

export function toSummary(row: PluginRow): PluginSummary {
	return {
		id: row.key,
		name: row.manifest.name,
		version: row.version,
		source: row.source,
		ref: row.ref,
		sha: row.sha,
		previousSha: row.previousSha,
		enabled: row.enabled,
		process: runtime().process(row.key),
		installedAt: row.createdAt,
		updatedAt: row.updatedAt
	};
}

export function toDetail(db: Db, row: PluginRow): PluginDetail {
	const stored = db.select().from(pluginSetting).where(eq(pluginSetting.pluginId, row.id)).all();
	const byKey = new Map(stored.map((s) => [s.key, s]));
	const u = db.select({ username: user.username }).from(user).where(eq(user.id, row.userId)).get();
	return {
		...toSummary(row),
		manifest: row.manifest,
		settings: row.manifest.settings.map((def) => {
			const s = byKey.get(def.key);
			const isSecret = def.type === 'secret';
			return {
				key: def.key,
				value: isSecret ? null : (s?.value ?? def.default ?? null),
				set: s?.value != null && s.value !== ''
			};
		}),
		log: runtime().log(row.key),
		username: u?.username ?? ''
	};
}
