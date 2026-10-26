/** Panels the running plugins offer for one slot of the app. */
import { and, eq } from 'drizzle-orm';
import type { PanelSlot, PluginPanel } from '@opal/shared';
import { signPayload } from '../../auth/signing.ts';
import type { Db } from '../../db/client.ts';
import { plugin } from '../../db/schema/index.ts';
import { runtime } from './runtime.ts';

const PANEL_TOKEN_MS = 3_600_000;

export function panelsFor(db: Db, userId: number, slot: PanelSlot): PluginPanel[] {
	const out: PluginPanel[] = [];
	for (const row of db.select().from(plugin).where(eq(plugin.enabled, true)).orderBy(plugin.key).all()) {
		if (runtime().port(row.key) === null) continue;
		const token = signPayload({ k: 'panel', u: userId, p: row.key }, PANEL_TOKEN_MS);
		for (const panel of row.manifest.panels) {
			if (panel.slot === slot) {
				out.push({ plugin: row.key, title: panel.title, src: `/plugins/${row.key}${panel.path}?pt=${token}` });
			}
		}
	}
	return out;
}
