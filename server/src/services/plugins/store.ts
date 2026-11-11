/** Plugin rows, their files on disk, their settings, and the views the API returns. */
import { and, eq } from 'drizzle-orm';
import { join } from 'node:path';
import { notFound, type PluginDetail, type PluginSummary } from '@opal/shared';
import type { Db } from '../../db/client.ts';
import { plugin, pluginSetting, user } from '../../db/schema/index.ts';
import { dataDir } from '../../paths.ts';
import { isSealed, pluginSettingScope, readStored, seal } from '../../auth/sealed.ts';
import { pluginsEnabled, runtime } from './runtime.ts';

export type PluginRow = typeof plugin.$inferSelect;

/** <data>/plugins: one folder per plugin, one subfolder per installed commit. */
export const pluginsRoot = () => join(dataDir(), 'plugins');
export const pluginDir = (key: string, sha: string) => join(pluginsRoot(), key, sha);
/** State the plugin keeps across updates (OPAL_PLUGIN_DATA). */
export const pluginDataRoot = () => join(dataDir(), 'plugin-data');
export const pluginDataDir = (key: string) => join(pluginDataRoot(), key);

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

type SettingRow = typeof pluginSetting.$inferSelect;

export const sealSetting = (pluginKey: string, key: string, value: unknown) => seal(JSON.stringify(value), pluginSettingScope(pluginKey, key));

/** What a stored setting stands for. `undefined` means a secret no key opens. */
export function plainSetting(row: PluginRow, s: SettingRow): unknown {
	if (!s.secret || !isSealed(s.value)) return s.value;
	const text = readStored(s.value, pluginSettingScope(row.key, s.key));
	return text === null ? undefined : JSON.parse(text);
}

/** Every stored value, secrets included: for the plugin process only. A secret no key opens is left out. */
export function settingValues(db: Db, row: PluginRow): Record<string, unknown> {
	const stored = db.select().from(pluginSetting).where(eq(pluginSetting.pluginId, row.id)).all();
	const out: Record<string, unknown> = {};
	for (const def of row.manifest.settings) if (def.default !== undefined) out[def.key] = def.default;
	for (const s of stored) {
		const plain = plainSetting(row, s);
		if (plain !== undefined) out[s.key] = plain;
	}
	return out;
}

/** Keys of the secrets stored for a plugin that no key opens. */
export function unreadableSettings(db: Db, row: PluginRow): string[] {
	const stored = db.select().from(pluginSetting).where(eq(pluginSetting.pluginId, row.id)).all();
	return stored.filter((s) => plainSetting(row, s) === undefined).map((s) => s.key);
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
		available: pluginsEnabled(),
		manifest: row.manifest,
		settings: row.manifest.settings.map((def) => {
			const s = byKey.get(def.key);
			// A row stays secret after its manifest stops saying so: it was given as a secret.
			const isSecret = def.type === 'secret' || !!s?.secret;
			const plain = s ? plainSetting(row, s) : null;
			return {
				key: def.key,
				value: isSecret ? null : (plain ?? def.default ?? null),
				secret: isSecret,
				set: plain != null && plain !== '',
				unreadable: plain === undefined
			};
		}),
		log: runtime().log(row.key),
		username: u?.username ?? ''
	};
}
