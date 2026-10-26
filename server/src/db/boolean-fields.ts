/**
 * One-time data step: the data field type `checkbox` is now `boolean`. Rewrites every stored
 * field schema (draft steps, ad-hoc steps, published version snapshots). Runs once per
 * database; a marker in app_setting records that it ran.
 *
 * A data rewrite, not an operation: no audit rows. The contract still reads `checkbox` as
 * `boolean`, so a missed row would still work; this keeps one spelling in storage.
 */
import { now } from '@opal/shared';
import { eq } from 'drizzle-orm';
import type { Db } from './client.ts';
import * as s from './schema/index.ts';

const MARKER = 'fields_boolean_type';

/** Every `fields` array in a JSON value: items typed `checkbox` become `boolean`. */
function rewrite(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(rewrite);
	if (!value || typeof value !== 'object') return value;
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(value)) {
		out[k] =
			k === 'fields' && Array.isArray(v)
				? v.map((f) =>
						f && typeof f === 'object' && (f as { type?: unknown }).type === 'checkbox'
							? { ...(f as object), type: 'boolean' }
							: rewrite(f)
					)
				: rewrite(v);
	}
	return out;
}

const changed = (a: unknown, b: unknown) => JSON.stringify(a) !== JSON.stringify(b);

export function renameCheckboxFields(db: Db, again = false): void {
	if (!again && db.select().from(s.appSetting).where(eq(s.appSetting.key, MARKER)).get()) return;
	db.transaction((tx) => {
		for (const r of tx.select({ id: s.procedureStep.id, v: s.procedureStep.dataSchema }).from(s.procedureStep).all()) {
			const next = rewrite(r.v) as typeof r.v;
			if (r.v && changed(r.v, next)) tx.update(s.procedureStep).set({ dataSchema: next }).where(eq(s.procedureStep.id, r.id)).run();
		}
		for (const r of tx.select({ id: s.adhocStep.id, v: s.adhocStep.dataSchema }).from(s.adhocStep).all()) {
			const next = rewrite(r.v) as typeof r.v;
			if (r.v && changed(r.v, next)) tx.update(s.adhocStep).set({ dataSchema: next }).where(eq(s.adhocStep.id, r.id)).run();
		}
		// Published content keeps its meaning: only the name of the type changes.
		for (const r of tx.select({ id: s.procedureVersion.id, v: s.procedureVersion.content }).from(s.procedureVersion).all()) {
			const next = rewrite(r.v) as typeof r.v;
			if (changed(r.v, next)) tx.update(s.procedureVersion).set({ content: next }).where(eq(s.procedureVersion.id, r.id)).run();
		}
		if (!tx.select().from(s.appSetting).where(eq(s.appSetting.key, MARKER)).get()) {
			const at = now();
			tx.insert(s.appSetting).values({ key: MARKER, value: '1', createdAt: at, updatedAt: at }).run();
		}
	});
}
