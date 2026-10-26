/**
 * Part numbers. One counter per tier (designator_sequence key `PN-{tier}`). The counter never
 * rolls back and numbers are never reused, so gaps carry information. Without a project the
 * format is PN-{tier}-{seq:04d}.
 *
 * With variants on, a new number is variant 001 of a new family, and the family's own counter
 * (`PNV-{base}`, see `../parts/variants.ts`) starts at 1.
 */
import { OpalError, variantFormat } from '@opal/shared';
import { eq } from 'drizzle-orm';
import type { Ctx } from '../../context.ts';
import type { Db } from '../../db/client.ts';
import { designatorSequence, part } from '../../db/schema/index.ts';
import { nextValue } from '../designators.ts';
import { fallbackPartNumber, getProjectConfig, getTier, numbersFor, renderPartNumber } from './project.ts';

const sequenceKey = (tier: number) => `PN-${tier}`;
/** The counter of a variant family, keyed by its stored base number. */
export const familyKey = (base: string) => `PNV-${base}`;

/** The stored form has 10 digits, so a tier counter stays in 1..MAX_SEQUENCE. */
const MAX_SEQUENCE = 9_999_999_999;
/** Skips past taken numbers per allocation. A bound keeps a bad counter from looping for ever. */
const MAX_SKIPS = 10_000;

function exhausted(tier: number): OpalError {
	return new OpalError(409, 'numbers_exhausted', `No free part number found for tier ${tier}`);
}

function format(db: Db, tier: number, sequence: number): string {
	const config = getProjectConfig(db);
	if (!config) return fallbackPartNumber(tier, sequence);
	const t = getTier(config, tier);
	if (!t) throw new OpalError(422, 'unknown_tier', `Unknown tier level: ${tier}`);
	return renderPartNumber(config, t, sequence);
}

/** True when any part holds this number. Parts are never deleted, so a number stays taken. */
export function pnExists(db: Db, pn: string): boolean {
	return db.select({ id: part.id }).from(part).where(eq(part.internalPn, pn)).get() !== undefined;
}

/**
 * Consume and return the next part number of a tier. Skips numbers already taken (a manual
 * override, an import); each skip uses up its number too.
 */
export function nextPartNumber(ctx: Pick<Ctx, 'db'>, tier: number): string {
	for (let i = 0; i < MAX_SKIPS; i++) {
		const sequence = nextValue(ctx, sequenceKey(tier));
		if (!Number.isSafeInteger(sequence) || sequence > MAX_SEQUENCE) throw exhausted(tier);
		const pn = format(ctx.db, tier, sequence);
		if (!pnExists(ctx.db, pn)) {
			startFamily(ctx, pn);
			return pn;
		}
	}
	throw exhausted(tier);
}

/** A new number with a variant suffix starts its family counter at its own code, 1. */
function startFamily(ctx: Pick<Ctx, 'db'>, pn: string): void {
	const split = numbersFor(ctx.db).split(pn);
	if (!split?.variant) return;
	ctx.db
		.insert(designatorSequence)
		.values({ prefix: familyKey(split.base), lastValue: Number(split.variant) })
		.onConflictDoNothing()
		.run();
}

/** The next part number of a tier without using it up. */
export function peekNextPartNumber(db: Db, tier: number): { partNumber: string; sequence: number } {
	const seq = db
		.select()
		.from(designatorSequence)
		.where(eq(designatorSequence.prefix, sequenceKey(tier)))
		.get();
	let candidate = (seq?.lastValue ?? 0) + 1;
	for (let i = 0; ; i++) {
		if (!Number.isSafeInteger(candidate) || candidate > MAX_SEQUENCE || i >= MAX_SKIPS) throw exhausted(tier);
		if (!pnExists(db, format(db, tier, candidate))) break;
		candidate += 1;
	}
	return { partNumber: format(db, tier, candidate), sequence: candidate };
}

/**
 * Build the regex that matches valid part numbers of a tier; `sequence` is a named group.
 * With variants on, the variant suffix is optional: a number from before the switch has none.
 */
export function partNumberPattern(db: Db, tier: number): RegExp {
	const config = getProjectConfig(db);
	if (!config) return new RegExp(`^PN-${tier}-(?<sequence>\\d{1,10})$`);
	const t = getTier(config, tier);
	if (!t) throw new OpalError(422, 'unknown_tier', `Unknown tier level: ${tier}`);
	const n = config.partNumbering;
	const values: Record<string, string> = {
		prefix: n.prefix,
		sep: n.separator,
		tier_code: t.code,
		tier_name: t.name,
		tier_level: String(t.level)
	};
	const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	const { base, joiner, variants } = variantFormat(n.format);
	let out = '';
	let pos = 0;
	for (const m of base.matchAll(/\{(\w+)\}/g)) {
		out += esc(base.slice(pos, m.index));
		const token = m[1]!;
		if (token === 'sequence') out += '(?<sequence>\\d{1,10})';
		else if (token in values) out += esc(values[token]!);
		else throw new OpalError(422, 'invalid_format', `Unknown placeholder {${token}} in part numbering format`);
		pos = m.index + m[0].length;
	}
	out += esc(base.slice(pos));
	if (variants) out += `(?:${esc(joiner.replaceAll('{sep}', n.separator))}(?<variant>\\d{3}))?`;
	return new RegExp(`^${out}$`);
}

/** Validate a part number against the format of a tier and return its sequence. */
export function validatePartNumber(db: Db, tier: number, pn: string): number {
	const match = partNumberPattern(db, tier).exec(pn);
	if (!match) {
		throw new OpalError(
			422,
			'invalid_part_number',
			`'${pn}' does not match the tier-${tier} part number format (e.g. ${format(db, tier, 1)})`
		);
	}
	const sequence = Number(match.groups!.sequence);
	if (sequence < 1 || sequence > MAX_SEQUENCE) {
		throw new OpalError(422, 'invalid_part_number', `'${pn}' has a sequence outside 1 to ${MAX_SEQUENCE}`);
	}
	return sequence;
}
