/**
 * Part numbering for parts. The scheme, counters and format checks live in the org area
 * (`../org/numbering.ts`); this file adds what only parts know: retired numbers (a number
 * that left the part table stays taken) and tier checks.
 */
import { OpalError, now } from '@opal/shared';
import { eq } from 'drizzle-orm';
import type { Ctx } from '../../context.ts';
import type { Db } from '../../db/client.ts';
import { retiredPartNumber } from '../../db/schema/index.ts';
import { insert } from '../../write.ts';
import {
	nextPartNumber,
	peekNextPartNumber,
	pnExists
} from '../org/numbering.ts';
import { getProjectConfig, getTier, levelDefaults } from '../org/project.ts';

/** The single place a new number is taken from the counter. */
export function allocatePartNumber(ctx: Ctx, tier: number): string {
	return nextPartNumber(ctx, tier);
}

export function retirePartNumber(ctx: Ctx, pn: string, reason: 'deleted' | 'replaced'): void {
	insert(ctx, retiredPartNumber, { internalPn: pn, reason, retiredAt: now() });
}

/** With a project set up, a tier must be one of its levels. Without one any tier is accepted. */
export function requireConfiguredTier(db: Db, tier: number): void {
	const config = getProjectConfig(db);
	if (config && !getTier(config, tier)) {
		const levels = config.tiers.map((t) => t.level).join(', ');
		throw new OpalError(422, 'invalid_input', `Unknown tier ${tier} (configured tiers: ${levels})`, {
			tier: `must be one of ${levels}`
		});
	}
}

export function tierName(db: Db, level: number): string | null {
	return getTier(getProjectConfig(db), level)?.name ?? null;
}

/** Tracking a part gets when none is given: the tier's default. */
export function defaultTracking(db: Db, level: number): 'serialized' | 'bulk' {
	return getTier(getProjectConfig(db), level)?.defaultTracking ?? levelDefaults(level).defaultTracking;
}

export function previewNext(db: Db, tier: number) {
	requireConfiguredTier(db, tier);
	const { partNumber, sequence } = peekNextPartNumber(db, tier);
	return { partNumber, sequence, tier, tierName: tierName(db, tier), defaultTracking: defaultTracking(db, tier) };
}
