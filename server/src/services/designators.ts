/**
 * Human identifiers from per-prefix counters. A number is handed out once and never
 * reused, also when its record is later removed.
 */
import { sql } from 'drizzle-orm';
import type { Ctx } from '../context.ts';
import { designatorSequence } from '../db/schema/index.ts';

export const PREFIX = {
	opal: 'OPAL',
	workOrder: 'WO',
	issue: 'IT',
	risk: 'RISK',
	requirement: 'REQ',
	template: 'T'
} as const;

const DIGITS: Record<string, number> = { REQ: 4, T: 4 };

/** Next value for a prefix. One upsert statement, so two writers never get the same number. */
export function nextValue(ctx: Pick<Ctx, 'db'>, prefix: string): number {
	const row = ctx.db
		.insert(designatorSequence)
		.values({ prefix, lastValue: 1 })
		.onConflictDoUpdate({
			target: designatorSequence.prefix,
			set: { lastValue: sql`${designatorSequence.lastValue} + 1` }
		})
		.returning({ value: designatorSequence.lastValue })
		.get();
	return row.value;
}

/** `OPAL-00042`. Digits default to 5 (4 for REQ and T), as in legacy. */
export function nextDesignator(ctx: Pick<Ctx, 'db'>, prefix: string, digits = DIGITS[prefix] ?? 5): string {
	return `${prefix}-${String(nextValue(ctx, prefix)).padStart(digits, '0')}`;
}

/** Serial numbers per part: `001`, `002`, ... (legacy SN-{PN} sequence, 3 digits). */
export function nextSerial(ctx: Pick<Ctx, 'db'>, partNumber: string): string {
	return String(nextValue(ctx, `SN-${partNumber}`)).padStart(3, '0');
}
