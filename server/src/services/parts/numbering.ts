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
	pnExists,
	registerPartNumber,
	validatePartNumber
} from '../org/numbering.ts';
import { getProjectConfig, getTier, levelDefaults } from '../org/project.ts';

/** The single place a new number is taken from the counter. */
export function allocatePartNumber(ctx: Ctx, tier: number): string {
	return nextPartNumber(ctx, tier);
}

export function isRetired(db: Db, pn: string): boolean {
	return db.select({ id: retiredPartNumber.id }).from(retiredPartNumber).where(eq(retiredPartNumber.internalPn, pn)).get() !== undefined;
}

/** True when a part holds the number or a deleted/abandoned part held it. */
export function partNumberTaken(db: Db, pn: string): boolean {
	return pnExists(db, pn) || isRetired(db, pn);
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

/** The number for a new part: a checked override or the next one. */
export function assignPartNumber(ctx: Ctx, tier: number, override: string | undefined): string {
	requireConfiguredTier(ctx.db, tier);
	if (!override) return allocatePartNumber(ctx, tier);
	validatePartNumber(ctx.db, tier, override);
	if (isRetired(ctx.db, override)) {
		throw new OpalError(
			409,
			'duplicate',
			`Part number ${override} is already taken (numbers are never reused, including by deleted parts)`
		);
	}
	registerPartNumber(ctx, tier, override);
	return override;
}

export function previewNext(db: Db, tier: number) {
	requireConfiguredTier(db, tier);
	const { partNumber, sequence } = peekNextPartNumber(db, tier);
	return { partNumber, sequence, tier, tierName: tierName(db, tier), defaultTracking: defaultTracking(db, tier) };
}
