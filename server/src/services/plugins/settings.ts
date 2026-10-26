/** Validates plugin settings against the manifest and stores them. */
import { and, eq } from 'drizzle-orm';
import { OpalError, type PluginSettingDef } from '@opal/shared';
import type { Ctx } from '../../context.ts';
import { pluginSetting } from '../../db/schema/index.ts';
import { insert, remove, update } from '../../write.ts';
import { settingRow, settingValues, type PluginRow } from './store.ts';

/** The stored value for one input, or an error text. */
function check(def: PluginSettingDef, v: unknown): { value: unknown } | { error: string } {
	switch (def.type) {
		case 'text':
		case 'secret':
			return typeof v === 'string' ? { value: v } : { error: 'Must be text' };
		case 'url': {
			if (typeof v !== 'string') return { error: 'Must be a URL' };
			if (v === '') return { value: v };
			try {
				const u = new URL(v);
				if (u.protocol !== 'http:' && u.protocol !== 'https:') return { error: 'Must be an http or https URL' };
				return { value: v };
			} catch {
				return { error: 'Must be a URL' };
			}
		}
		case 'number':
			return typeof v === 'number' && Number.isFinite(v) ? { value: v } : { error: 'Must be a number' };
		case 'boolean':
			return typeof v === 'boolean' ? { value: v } : { error: 'Must be true or false' };
		case 'select':
			return typeof v === 'string' && (def.options ?? []).includes(v)
				? { value: v }
				: { error: `Must be one of: ${(def.options ?? []).join(', ')}` };
		case 'json':
			return { value: v };
	}
}

/**
 * `null` clears a setting (the default applies). A secret left out or `null`
 * keeps its value; an empty string clears it. Other keys left out stay as they are.
 */
export function saveSettings(ctx: Ctx, row: PluginRow, values: Record<string, unknown>): void {
	const defs = new Map(row.manifest.settings.map((d) => [d.key, d]));
	const fields: Record<string, string> = {};
	const writes: Array<{ def: PluginSettingDef; value: unknown }> = [];
	for (const [key, v] of Object.entries(values)) {
		const def = defs.get(key);
		if (!def) {
			fields[key] = 'Unknown setting';
			continue;
		}
		if (v === undefined || (v === null && def.type === 'secret')) continue;
		if (v === null || (def.type === 'secret' && v === '')) {
			writes.push({ def, value: null });
			continue;
		}
		const r = check(def, v);
		if ('error' in r) fields[key] = r.error;
		else writes.push({ def, value: r.value });
	}
	if (Object.keys(fields).length) throw new OpalError(422, 'invalid_settings', 'Some settings are not valid', fields);
	for (const { def, value } of writes) {
		const existing = settingRow(ctx.db, row.id, def.key);
		if (value === null) {
			if (existing) remove(ctx, pluginSetting, existing.id);
		} else if (!existing) {
			insert(ctx, pluginSetting, { pluginId: row.id, key: def.key, value, secret: def.type === 'secret' });
		} else if (JSON.stringify(existing.value) !== JSON.stringify(value)) {
			update(ctx, pluginSetting, existing.id, { value });
		}
	}
}

/** Required settings that have neither a stored value nor a default. */
export function missingSettings(ctx: Ctx, row: PluginRow): PluginSettingDef[] {
	const values = settingValues(ctx.db, row);
	return row.manifest.settings.filter((d) => {
		const v = values[d.key];
		return d.required && (v === undefined || v === null || v === '');
	});
}
