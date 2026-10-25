/**
 * The spec of a captured number: what a good value is, in the field's unit.
 *
 * A spec never refuses a value. `specResult` says whether a value meets it; an out-of-spec
 * value is recorded and flagged (and blocks step completion until a note or an NC explains it).
 *
 * Limits are decimal strings and compare exactly (12.125 stays 12.125). A value on a limit is
 * in spec.
 */
import { z } from 'zod';
import { unitSymbol } from './units.ts';

/** A plain decimal: optional sign, digits, optional fraction. No exponent. */
export const zDecimal = z
	.string()
	.trim()
	.regex(/^[-+]?(\d+(\.\d*)?|\.\d+)$/, 'Expected a decimal number such as 12.125');

export const SPEC_KINDS = ['range', 'nominal', 'min', 'max', 'reference'] as const;
export type SpecKind = (typeof SPEC_KINDS)[number];

export const zSpec = z
	.discriminatedUnion('kind', [
		z.object({ kind: z.literal('range'), lower: zDecimal, upper: zDecimal }),
		/** nominal + plus / − minus. */
		z.object({ kind: z.literal('nominal'), nominal: zDecimal, plus: zDecimal, minus: zDecimal }),
		z.object({ kind: z.literal('min'), lower: zDecimal }),
		z.object({ kind: z.literal('max'), upper: zDecimal }),
		/** Shown ("approx. 80 ft·lbf"), never checked. */
		z.object({ kind: z.literal('reference'), nominal: zDecimal })
	])
	.superRefine((s, ctx) => {
		if (s.kind === 'range' && cmp(s.lower, s.upper) > 0)
			ctx.addIssue({ code: 'custom', path: ['upper'], message: 'Upper limit is below the lower limit' });
		if (s.kind === 'nominal' && (sign(s.plus) < 0 || sign(s.minus) < 0))
			ctx.addIssue({ code: 'custom', path: ['plus'], message: 'Tolerances are positive; minus is subtracted' });
	});
export type Spec = z.infer<typeof zSpec>;

export const SPEC_RESULTS = ['in_spec', 'out_of_spec', 'none', 'invalid'] as const;
export type SpecResult = (typeof SPEC_RESULTS)[number];

// ---------------------------------------------------------------- exact decimals

interface Dec {
	n: bigint;
	scale: number;
}

function parse(v: string): Dec | null {
	const m = /^([-+]?)(\d*)(?:\.(\d*))?$/.exec(v.trim());
	if (!m || (!m[2] && !m[3])) return null;
	const frac = m[3] ?? '';
	const n = BigInt(`${m[2] || '0'}${frac}`) * (m[1] === '-' ? -1n : 1n);
	return { n, scale: frac.length };
}

function align(a: Dec, b: Dec): [bigint, bigint, number] {
	const scale = Math.max(a.scale, b.scale);
	return [a.n * 10n ** BigInt(scale - a.scale), b.n * 10n ** BigInt(scale - b.scale), scale];
}

function cmp(a: string, b: string): number {
	const x = parse(a);
	const y = parse(b);
	if (!x || !y) return Number.NaN;
	const [p, q] = align(x, y);
	return p < q ? -1 : p > q ? 1 : 0;
}

const sign = (a: string) => cmp(a, '0');

function add(a: string, b: string, negate = false): string {
	const x = parse(a)!;
	const y = parse(b)!;
	const [p, q, scale] = align(x, y);
	const r = negate ? p - q : p + q;
	const neg = r < 0n;
	const digits = (neg ? -r : r).toString().padStart(scale + 1, '0');
	const int = digits.slice(0, digits.length - scale);
	const frac = scale ? `.${digits.slice(digits.length - scale)}` : '';
	return `${neg ? '-' : ''}${int}${frac}`;
}

/** A captured value as a decimal string: numbers print without exponent where possible. */
export function decimalOf(value: unknown): string | null {
	if (typeof value === 'number') {
		if (!Number.isFinite(value)) return null;
		const s = String(value);
		return /e/i.test(s) ? value.toFixed(12).replace(/\.?0+$/, '') : s;
	}
	if (typeof value === 'string' && parse(value)) return value.trim();
	return null;
}

/** The limits a spec checks, or null for none (reference). */
export function specLimits(s: Spec): { lower: string | null; upper: string | null } | null {
	switch (s.kind) {
		case 'range':
			return { lower: s.lower, upper: s.upper };
		case 'nominal':
			return { lower: add(s.nominal, s.minus, true), upper: add(s.nominal, s.plus) };
		case 'min':
			return { lower: s.lower, upper: null };
		case 'max':
			return { lower: null, upper: s.upper };
		case 'reference':
			return null;
	}
}

/** Does a captured value meet the spec? `none`: no spec, no value, or a reference spec. */
export function specResult(spec: Spec | null | undefined, value: unknown): SpecResult {
	if (!spec || value === undefined || value === null || value === '') return 'none';
	const limits = specLimits(spec);
	if (!limits) return 'none';
	const v = decimalOf(value);
	if (v === null) return 'invalid';
	if (limits.lower !== null && cmp(v, limits.lower) < 0) return 'out_of_spec';
	if (limits.upper !== null && cmp(v, limits.upper) > 0) return 'out_of_spec';
	return 'in_spec';
}

/** The spec as people read it, with the unit symbol: "12.125 – 12.250 in", "≥ 80 ft·lbf". */
export function specText(spec: Spec | null | undefined, unit?: string | null): string {
	if (!spec) return '';
	const sym = unitSymbol(unit);
	const u = sym ? ` ${sym}` : '';
	switch (spec.kind) {
		case 'range':
			return `${spec.lower} – ${spec.upper}${u}`;
		case 'nominal':
			return cmp(spec.plus, spec.minus) === 0
				? `${spec.nominal} ± ${spec.plus}${u}`
				: `${spec.nominal} +${spec.plus} / −${spec.minus}${u}`;
		case 'min':
			return `≥ ${spec.lower}${u}`;
		case 'max':
			return `≤ ${spec.upper}${u}`;
		case 'reference':
			return `approx. ${spec.nominal}${u}`;
	}
}
