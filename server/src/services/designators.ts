/**
 * Human identifiers from per-prefix counters. A number is handed out once and never
 * reused, also when its record is later removed.
 */
import { type DesignatorPrefix, storeDesignator } from '@opal/shared';
import { eq, sql } from 'drizzle-orm';
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

/** The value `nextValue` would hand out, without taking it. Two creates may both be shown it. */
export function peekValue(ctx: Pick<Ctx, 'db'>, prefix: string): number {
	const row = ctx.db
		.select({ value: designatorSequence.lastValue })
		.from(designatorSequence)
		.where(eq(designatorSequence.prefix, prefix))
		.get();
	return (row?.value ?? 0) + 1;
}

/** The numbers a batch of `count` would take next, first and last, without taking them. */
export function peekDesignators(
	ctx: Pick<Ctx, 'db'>,
	prefix: DesignatorPrefix,
	count = 1
): { first: string; last: string } {
	const v = peekValue(ctx, prefix);
	return { first: storeDesignator(prefix, v), last: storeDesignator(prefix, v + count - 1) };
}

/** The stored form, `OPAL-0000000042`. The API shows it at the organization's width. */
export function nextDesignator(ctx: Pick<Ctx, 'db'>, prefix: DesignatorPrefix): string {
	return storeDesignator(prefix, nextValue(ctx, prefix));
}

/** Serial numbers per part: `001`, `002`, ... (legacy SN-{PN} sequence, 3 digits). */
export function nextSerial(ctx: Pick<Ctx, 'db'>, partNumber: string): string {
	return String(nextValue(ctx, `SN-${partNumber}`)).padStart(3, '0');
}
