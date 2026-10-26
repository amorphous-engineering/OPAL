/**
 * Variant families. A family is the set of parts whose stored number has the same base (the
 * number up to and including the sequence). The base has no row: the numbers are the fact.
 *
 * Each family has its own counter (`PNV-{base}`). A code is handed out once, also when its
 * part is later deleted, and the tier counter never moves for a variant. A number without a
 * suffix (from before variants were on, or an import) is variant 001 of its own family.
 */
import { MAX_VARIANT, OpalError, type PartFamily, showVariant } from '@opal/shared';
import { asc, eq, or, sql } from 'drizzle-orm';
import type { Ctx } from '../../context.ts';
import type { Db } from '../../db/client.ts';
import { designatorSequence, part, retiredPartNumber } from '../../db/schema/index.ts';
import { nextValue } from '../designators.ts';
import { familyKey, pnExists } from '../org/numbering.ts';
import { getProjectConfig, numbersFor, variantJoiner } from '../org/project.ts';

type Row = typeof part.$inferSelect;

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function retired(db: Db, pn: string): boolean {
	return db.select({ id: retiredPartNumber.id }).from(retiredPartNumber).where(eq(retiredPartNumber.internalPn, pn)).get() !== undefined;
}

/** A number on record: a part holds it, or a deleted or replaced part held it. */
function taken(db: Db, pn: string): boolean {
	return pnExists(db, pn) || retired(db, pn);
}

export interface Family {
	base: string;
	joiner: string;
}

/** The family of a stored part number. */
export function familyOf(db: Db, pn: string): Family {
	const joiner = variantJoiner(getProjectConfig(db));
	const split = numbersFor(db).split(pn);
	if (split) return { base: split.base, joiner };
	// Outside the current scheme (an older format, an import): a suffix counts when the
	// number before it is on record, else the number is a base of its own.
	const m = joiner ? new RegExp(`^(.+)${esc(joiner)}\\d{3}$`).exec(pn) : null;
	if (m && taken(db, m[1]!)) return { base: m[1]!, joiner };
	return { base: pn, joiner };
}

/** The variant code of a family member: the suffix, or 001 for the base number itself. */
function codeOf(f: Family, pn: string): number | null {
	if (pn === f.base) return 1;
	const head = f.base + f.joiner;
	if (!f.joiner || !pn.startsWith(head)) return null;
	const tail = pn.slice(head.length);
	return /^\d{3}$/.test(tail) ? Number(tail) : null;
}

/** Numbers of the family in a table, read by prefix so a `%` or `_` in a number is literal. */
function familyNumbers(db: Db, f: Family): { parts: Row[]; retired: string[] } {
	const head = f.base + f.joiner;
	const like = <T extends typeof part.internalPn | typeof retiredPartNumber.internalPn>(col: T) =>
		or(eq(col, f.base), sql`substr(${col}, 1, ${head.length}) = ${head}`);
	const parts = db.select().from(part).where(like(part.internalPn)).orderBy(asc(part.id)).all();
	const gone = db
		.select({ pn: retiredPartNumber.internalPn })
		.from(retiredPartNumber)
		.where(like(retiredPartNumber.internalPn))
		.all()
		.map((r) => r.pn);
	return {
		parts: parts.filter((p) => codeOf(f, p.internalPn) !== null),
		retired: gone.filter((pn) => codeOf(f, pn) !== null)
	};
}

/** The counter value a family starts from: the highest code on record, at least 1. */
function firstCounter(db: Db, f: Family): number {
	const { parts, retired } = familyNumbers(db, f);
	const codes = [...parts.map((p) => p.internalPn), ...retired].map((pn) => codeOf(f, pn) ?? 1);
	return Math.max(1, ...codes);
}

function lastCode(db: Db, f: Family): number {
	const row = db.select().from(designatorSequence).where(eq(designatorSequence.prefix, familyKey(f.base))).get();
	return row?.lastValue ?? firstCounter(db, f);
}

function exhausted(f: Family): OpalError {
	return new OpalError(409, 'numbers_exhausted', `No free variant code left for ${f.base}`);
}

const numberOf = (f: Family, code: number) => f.base + f.joiner + showVariant(code);

/** Consume and return the next variant number of a family. */
export function nextVariantNumber(ctx: Pick<Ctx, 'db'>, f: Family): string {
	// A legacy family has no counter yet: it starts above every code already on record.
	ctx.db
		.insert(designatorSequence)
		.values({ prefix: familyKey(f.base), lastValue: firstCounter(ctx.db, f) })
		.onConflictDoNothing()
		.run();
	for (let i = 0; i < MAX_VARIANT; i++) {
		const code = nextValue(ctx, familyKey(f.base));
		if (code > MAX_VARIANT) throw exhausted(f);
		const pn = numberOf(f, code);
		if (!taken(ctx.db, pn)) return pn;
	}
	throw exhausted(f);
}

/** The next variant number of a family without using it up. Null when the codes are used up. */
export function peekVariantNumber(db: Db, f: Family): string | null {
	for (let code = lastCode(db, f) + 1; code <= MAX_VARIANT; code++) {
		const pn = numberOf(f, code);
		if (!taken(db, pn)) return pn;
	}
	return null;
}

/** The family of a part, ready to show: base number and members in code order. */
export function family(db: Db, row: Row): PartFamily {
	const f = familyOf(db, row.internalPn);
	const variants = getProjectConfig(db)?.partNumbering.variants ?? false;
	const members = familyNumbers(db, f)
		.parts.map((p) => ({ p, code: codeOf(f, p.internalPn)! }))
		.sort((a, b) => a.code - b.code || a.p.id - b.p.id)
		.map(({ p, code }) => ({
			id: p.id,
			internalPn: p.internalPn,
			variant: showVariant(code),
			name: p.name,
			state: p.state,
			trackingType: p.trackingType
		}));
	return { baseNumber: f.base, variants, nextNumber: variants ? peekVariantNumber(db, f) : null, members };
}
