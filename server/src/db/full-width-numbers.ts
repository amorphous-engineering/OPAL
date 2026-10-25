/**
 * One-time data step: store every sequence number at full width (see `designators.ts` in
 * shared). Databases from before the change, and every legacy import, hold numbers at 3 to 5
 * digits. Runs once per database; a marker in app_setting records that it ran.
 *
 * A data rewrite, not an operation: no audit rows. The audit log keeps the values as they
 * were recorded.
 */
import { canonicalDesignator, now, type NumberCodec } from '@opal/shared';
import { eq, sql } from 'drizzle-orm';
import type { Db } from './client.ts';
import * as s from './schema/index.ts';
import { numbersFor } from '../services/org/project.ts';

const MARKER = 'numbers_full_width';

/** JSON keys whose value is a number (procedure snapshots). */
const JSON_KEYS = new Set([
	'templateNumber',
	'internalPn',
	'partNumber',
	'part_number',
	'internal_pn',
	'opalNumber',
	'woNumber'
]);

function rewriteJson(value: unknown, codec: NumberCodec): unknown {
	if (Array.isArray(value)) return value.map((v) => rewriteJson(v, codec));
	if (!value || typeof value !== 'object') return value;
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(value)) {
		out[k] = typeof v === 'string' && JSON_KEYS.has(k) ? codec.canonical(v) : rewriteJson(v, codec);
	}
	return out;
}

/**
 * `again` skips the marker: content imported into a database that already ran the step (the
 * demo, which is opened before its seed is imported) needs the step once more. The step is
 * idempotent, so a second run changes nothing it has already changed.
 */
export function storeNumbersAtFullWidth(db: Db, again = false): void {
	const marked = db.select().from(s.appSetting).where(eq(s.appSetting.key, MARKER)).get();
	if (marked && !again) return;
	const codec = numbersFor(db);
	const desig = (v: string) => canonicalDesignator(v);
	const pn = (v: string) => codec.canonical(v);

	db.transaction((tx) => {
		const column = <T extends { id: number }>(
			rows: (T & { v: string | null })[],
			to: (v: string) => string,
			write: (id: number, v: string) => void
		) => {
			for (const r of rows) {
				if (r.v === null) continue;
				const next = to(r.v);
				if (next !== r.v) write(r.id, next);
			}
		};

		column(tx.select({ id: s.stockRecord.id, v: s.stockRecord.opalNumber }).from(s.stockRecord).all(), desig, (id, v) =>
			tx.update(s.stockRecord).set({ opalNumber: v }).where(eq(s.stockRecord.id, id)).run()
		);
		// A production lot is the work order number.
		// Only production lots: a lot a person typed (T-5, PO-7) is theirs, not a sequence number.
		column(tx.select({ id: s.stockRecord.id, v: s.stockRecord.lotNumber }).from(s.stockRecord).where(eq(s.stockRecord.sourceType, 'production')).all(), desig, (id, v) =>
			tx.update(s.stockRecord).set({ lotNumber: v }).where(eq(s.stockRecord.id, id)).run()
		);
		column(tx.select({ id: s.execution.id, v: s.execution.woNumber }).from(s.execution).all(), desig, (id, v) =>
			tx.update(s.execution).set({ woNumber: v }).where(eq(s.execution.id, id)).run()
		);
		column(tx.select({ id: s.issue.id, v: s.issue.issueNumber }).from(s.issue).all(), desig, (id, v) =>
			tx.update(s.issue).set({ issueNumber: v }).where(eq(s.issue.id, id)).run()
		);
		column(tx.select({ id: s.risk.id, v: s.risk.riskNumber }).from(s.risk).all(), desig, (id, v) =>
			tx.update(s.risk).set({ riskNumber: v }).where(eq(s.risk.id, id)).run()
		);
		column(tx.select({ id: s.riskReference.id, v: s.riskReference.referenceValue }).from(s.riskReference).all(), desig, (id, v) =>
			tx.update(s.riskReference).set({ referenceValue: v }).where(eq(s.riskReference.id, id)).run()
		);
		column(tx.select({ id: s.requirement.id, v: s.requirement.reqNumber }).from(s.requirement).all(), desig, (id, v) =>
			tx.update(s.requirement).set({ reqNumber: v }).where(eq(s.requirement.id, id)).run()
		);
		column(tx.select({ id: s.procedure.id, v: s.procedure.templateNumber }).from(s.procedure).all(), desig, (id, v) =>
			tx.update(s.procedure).set({ templateNumber: v }).where(eq(s.procedure.id, id)).run()
		);
		column(tx.select({ id: s.purchase.id, v: s.purchase.reference }).from(s.purchase).all(), desig, (id, v) =>
			tx.update(s.purchase).set({ reference: v }).where(eq(s.purchase.id, id)).run()
		);

		// Part numbers, and the serial counters keyed by part number (SN-<pn>).
		const pnMoves = new Map<string, string>();
		column(tx.select({ id: s.part.id, v: s.part.internalPn }).from(s.part).all(), pn, (id, v) => {
			const old = tx.select({ v: s.part.internalPn }).from(s.part).where(eq(s.part.id, id)).get()!.v;
			pnMoves.set(old, v);
			tx.update(s.part).set({ internalPn: v }).where(eq(s.part.id, id)).run();
		});
		column(tx.select({ id: s.retiredPartNumber.id, v: s.retiredPartNumber.internalPn }).from(s.retiredPartNumber).all(), pn, (id, v) =>
			tx.update(s.retiredPartNumber).set({ internalPn: v }).where(eq(s.retiredPartNumber.id, id)).run()
		);
		for (const [old, next] of pnMoves) {
			tx.update(s.designatorSequence)
				.set({ prefix: `SN-${next}` })
				.where(eq(s.designatorSequence.prefix, `SN-${old}`))
				.run();
		}

		// Published content keeps its meaning: only the stored width of its numbers changes.
		for (const v of tx.select({ id: s.procedureVersion.id, content: s.procedureVersion.content }).from(s.procedureVersion).all()) {
			const after = rewriteJson(v.content, codec) as typeof v.content;
			if (JSON.stringify(after) !== JSON.stringify(v.content)) {
				tx.update(s.procedureVersion).set({ content: after }).where(eq(s.procedureVersion.id, v.id)).run();
			}
		}

		const at = now();
		if (!marked) tx.insert(s.appSetting).values({ key: MARKER, value: '1', createdAt: at, updatedAt: at }).run();
	});
	db.run(sql`PRAGMA optimize`);
}
