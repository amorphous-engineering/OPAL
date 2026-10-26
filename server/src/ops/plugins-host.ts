import { contracts, conflict, OpalError } from '@opal/shared';
import { asc } from 'drizzle-orm';
import { plugin } from '../db/schema/index.ts';
import { type Impl, implement } from '../registry.ts';
import { runtime } from '../services/plugins/runtime.ts';
import { missingSettings, saveSettings } from '../services/plugins/settings.ts';
import { getPlugin, toDetail, toSummary } from '../services/plugins/store.ts';
import { update } from '../write.ts';

const c = contracts.plugins;

export const pluginsHostImpls: Impl[] = [
	implement(c.list, (ctx) => ({ items: ctx.db.select().from(plugin).orderBy(asc(plugin.key)).all().map(toSummary) })),
	implement(c.get, (ctx, i) => toDetail(ctx.db, getPlugin(ctx.db, i.id))),
	implement(c.settings, (ctx, i) => {
		const row = getPlugin(ctx.db, i.id);
		saveSettings(ctx, row, i.values);
		// start() reads the row again after this transaction commits.
		if (row.enabled) void runtime().start(row.key);
		return toDetail(ctx.db, getPlugin(ctx.db, i.id));
	}),
	implement(c.enable, (ctx, i) => {
		const row = getPlugin(ctx.db, i.id);
		const missing = missingSettings(ctx, row);
		if (missing.length) {
			throw new OpalError(
				422,
				'missing_settings',
				`Set ${missing.map((d) => d.label).join(', ')} first`,
				Object.fromEntries(missing.map((d) => [d.key, 'Required']))
			);
		}
		const next = update(ctx, plugin, row.id, { enabled: true });
		void runtime().start(row.key);
		return toDetail(ctx.db, next);
	}),
	implement(c.disable, (ctx, i) => {
		const row = getPlugin(ctx.db, i.id);
		const next = update(ctx, plugin, row.id, { enabled: false });
		void runtime().stop(row.key);
		return toDetail(ctx.db, next);
	}),
	implement(c.restart, (ctx, i) => {
		const row = getPlugin(ctx.db, i.id);
		if (!row.enabled) throw conflict('plugin_disabled', 'Enable the plugin first');
		void runtime().start(row.key);
		return toDetail(ctx.db, row);
	})
];
