/**
 * Part numbers. One counter per tier (designator_sequence key `PN-{tier}`). The counter never
 * rolls back and numbers are never reused, so gaps carry information. Without a project the
 * format is PN-{tier}-{seq:04d}.
 */
import { OpalError } from '@opal/shared';
import { eq } from 'drizzle-orm';
import type { Ctx } from '../../context.ts';
import type { Db } from '../../db/client.ts';
import { designatorSequence, part } from '../../db/schema/index.ts';
import { nextValue } from '../designators.ts';
import { fallbackPartNumber, getProjectConfig, getTier, renderPartNumber } from './project.ts';

const sequenceKey = (tier: number) => `PN-${tier}`;

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
	for (;;) {
		const pn = format(ctx.db, tier, nextValue(ctx, sequenceKey(tier)));
		if (!pnExists(ctx.db, pn)) return pn;
	}
}

/** The next part number of a tier without using it up. */
export function peekNextPartNumber(db: Db, tier: number): { partNumber: string; sequence: number } {
	const seq = db
		.select()
		.from(designatorSequence)
		.where(eq(designatorSequence.prefix, sequenceKey(tier)))
		.get();
	let candidate = (seq?.lastValue ?? 0) + 1;
	while (pnExists(db, format(db, tier, candidate))) candidate += 1;
	return { partNumber: format(db, tier, candidate), sequence: candidate };
}

/** Build the regex that matches valid part numbers of a tier; `sequence` is a named group. */
export function partNumberPattern(db: Db, tier: number): RegExp {
	const config = getProjectConfig(db);
	if (!config) return new RegExp(`^PN-${tier}-(?<sequence>\\d{4,})$`);
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
	let out = '';
	let pos = 0;
	for (const m of n.format.matchAll(/\{(\w+)\}/g)) {
		out += esc(n.format.slice(pos, m.index));
		const token = m[1]!;
		if (token === 'sequence') out += `(?<sequence>\\d{${n.sequenceDigits},})`;
		else if (token in values) out += esc(values[token]!);
		else throw new OpalError(422, 'invalid_format', `Unknown placeholder {${token}} in part numbering format`);
		pos = m.index + m[0].length;
	}
	return new RegExp(`^${out}${esc(n.format.slice(pos))}$`);
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
	return Number(match.groups!.sequence);
}

/**
 * Check a manual part number and move the tier counter past it, so an automatic number never
 * reuses it. Throws 409 when a part holds the number. Returns the sequence.
 */
export function registerPartNumber(ctx: Pick<Ctx, 'db'>, tier: number, pn: string): number {
	const sequence = validatePartNumber(ctx.db, tier, pn);
	if (pnExists(ctx.db, pn)) throw new OpalError(409, 'duplicate', `Part number ${pn} is already taken`);
	const key = sequenceKey(tier);
	const row = ctx.db.select().from(designatorSequence).where(eq(designatorSequence.prefix, key)).get();
	if (!row) ctx.db.insert(designatorSequence).values({ prefix: key, lastValue: sequence }).run();
	else if (row.lastValue < sequence) {
		ctx.db.update(designatorSequence).set({ lastValue: sequence }).where(eq(designatorSequence.prefix, key)).run();
	}
	return sequence;
}
