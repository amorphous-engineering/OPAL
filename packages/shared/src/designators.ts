/**
 * Sequence numbers (OPAL-, WO-, IT-, RISK-, REQ-, T-, PO- and part numbers) are stored with a
 * fixed 10-digit sequence and shown with the organization's `sequenceDigits`. Changing the
 * setting changes every number on screen, in links and in exports, and no stored row moves.
 *
 * The 10-digit form never reaches a person: the server rewrites it at the API boundary. Any
 * other width a person types (WO-4, WO-0004, WO-00004) means the same record.
 */
export const DESIGNATOR_PREFIXES = ['OPAL', 'WO', 'IT', 'RISK', 'REQ', 'T', 'PO'] as const;
export type DesignatorPrefix = (typeof DESIGNATOR_PREFIXES)[number];

export const STORED_DIGITS = 10;

const ALT = DESIGNATOR_PREFIXES.join('|');
const ANY_WIDTH = new RegExp(`^(${ALT})-(\\d{1,${STORED_DIGITS}})$`, 'i');
// Word-bounded so a stored number inside generated text (a notification, a CSV) is found too.
const STORED_IN_TEXT = new RegExp(`(?<![\\w-])(${ALT})-(\\d{${STORED_DIGITS}})(?![\\w])`, 'g');

const pad = (n: number | string, width: number) => String(n).padStart(width, '0');
/** Zero-pad to `width`; a longer number is never cut. */
export const showSequence = (digits: string, width: number) => pad(Number(digits), width);

/** The stored form of a new number: `WO-0000000042`. */
export function storeDesignator(prefix: DesignatorPrefix, sequence: number): string {
	return `${prefix}-${pad(sequence, STORED_DIGITS)}`;
}

/** Any width of a designator to its stored form. Other text comes back unchanged. */
export function canonicalDesignator(value: string): string {
	const m = ANY_WIDTH.exec(value.trim());
	return m ? `${m[1]!.toUpperCase()}-${pad(Number(m[2]), STORED_DIGITS)}` : value;
}

/** Part number scheme, as the settings describe it. */
export interface PartNumberScheme {
	prefix: string;
	separator: string;
	format: string;
	tiers: { level: number; code: string; name: string }[];
}

/** Without organization settings, part numbers are PN-{tier}-{sequence}. */
export const FALLBACK_SCHEME: PartNumberScheme = {
	prefix: 'PN',
	separator: '-',
	format: '{prefix}{sep}{tier_level}{sep}{sequence}',
	tiers: []
};

/** A variant code is always three digits, whatever `sequenceDigits` says: 001 to 999. */
export const VARIANT_DIGITS = 3;
export const MAX_VARIANT = 999;
export const showVariant = (code: number) => pad(code, VARIANT_DIGITS);

/**
 * A format split at its variant suffix. With variants on the format ends in a joiner (the
 * separator, or literal punctuation) and `{variant}`; `base` is the rest. Without `{variant}`
 * the whole format is the base and the joiner is `{sep}`, so a number with a suffix still
 * reads after an admin turns variants off.
 */
export function variantFormat(format: string): { base: string; joiner: string; variants: boolean } {
	const at = format.lastIndexOf('{variant}');
	if (at < 0 || at + '{variant}'.length !== format.length) return { base: format, joiner: '{sep}', variants: false };
	const head = format.slice(0, at);
	const joiner = /(?:\{sep\}|[^\w{}])*$/.exec(head)![0];
	return { base: head.slice(0, head.length - joiner.length), joiner, variants: true };
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The base format around `{sequence}` as two regex sources, and the joiner before a variant
 * code. Null when the format has no sequence.
 */
function schemeParts(s: PartNumberScheme): { before: string; after: string; joiner: string | null } | null {
	const alt = (xs: string[]) => (xs.length ? `(?:${xs.map(esc).join('|')})` : '(?!)');
	const token: Record<string, string> = {
		prefix: esc(s.prefix),
		sep: esc(s.separator),
		tier_code: alt(s.tiers.map((t) => t.code).filter(Boolean)),
		tier_name: alt(s.tiers.map((t) => t.name).filter(Boolean)),
		tier_level: s.tiers.length ? alt(s.tiers.map((t) => String(t.level))) : '\\d+'
	};
	const src = (part: string) =>
		part
			.split(/(\{\w+\})/)
			.map((chunk) => {
				const m = /^\{(\w+)\}$/.exec(chunk);
				return m ? (token[m[1]!] ?? esc(chunk)) : esc(chunk);
			})
			.join('');
	const { base, joiner } = variantFormat(s.format);
	const at = base.indexOf('{sequence}');
	if (at < 0) return null;
	// An empty joiner would make the variant code run into the sequence digits.
	const j = joiner.replaceAll('{sep}', s.separator);
	return {
		before: src(base.slice(0, at)),
		after: src(base.slice(at + '{sequence}'.length)),
		joiner: j ? esc(j) : null
	};
}

/** Rewrites numbers between their stored form and the form a person sees. */
export interface NumberCodec {
	width: number;
	/** Every stored number in `text` (a whole value or inside prose) at the display width. */
	display(text: string): string;
	/** A number a person typed, at any width, to its stored form. Other text is unchanged. */
	canonical(value: string): string;
	/**
	 * A search string: a whole or partial number becomes the text the stored form contains.
	 * `WO-00` at width 4 finds WO-0000000001 to WO-0000000099. A base part number finds every
	 * variant of it, and `F-1-00` finds variants 001 to 009 of F-0001.
	 */
	search(q: string): string;
	/**
	 * A stored part number split into its base (up to and including the sequence) and its
	 * variant code. A number without a suffix has `variant: null`. Null outside the scheme.
	 */
	split(stored: string): { base: string; variant: string | null } | null;
}

export function numberCodec(width: number, scheme: PartNumberScheme = FALLBACK_SCHEME): NumberCodec {
	const parts = schemeParts(scheme);
	const suffix = (digits: string) => (parts?.joiner ? `(?:(${parts.joiner})(\\d${digits}))?` : '()()');
	const pnStored = parts
		? new RegExp(
				`(?<![\\w-])(${parts.before})(\\d{${STORED_DIGITS}})(${parts.after})${suffix(`{${VARIANT_DIGITS}}`)}(?![\\w])`,
				'g'
			)
		: null;
	const pnSplit = parts
		? new RegExp(`^(${parts.before}\\d{${STORED_DIGITS}}${parts.after})${suffix(`{${VARIANT_DIGITS}}`)}$`)
		: null;
	const pnAny = parts
		? new RegExp(`^(${parts.before})(\\d{1,${STORED_DIGITS}})(${parts.after})${suffix(`{1,${VARIANT_DIGITS}}`)}$`)
		: null;
	// A sequence that a joiner ends is whole; the variant code after it may be partial.
	const pnVariantPartial = parts?.joiner
		? new RegExp(`^(${parts.before})(\\d{1,${STORED_DIGITS}})(${parts.after})(${parts.joiner})(\\d{0,${VARIANT_DIGITS}})$`)
		: null;
	const pnPartial = parts ? new RegExp(`^(${parts.before})(\\d{1,${STORED_DIGITS}})$`) : null;
	const desigPartial = new RegExp(`^(${ALT})-(\\d{1,${STORED_DIGITS}})$`, 'i');
	// Fewer digits than the width with a leading zero is the start of a shown number (WO-00 at
	// width 4 is WO-0001 to WO-0099). Anything else is a whole number (WO-4, WO-0004, WO-00004).
	const lead = (digits: string) =>
		digits.length < width && digits.startsWith('0')
			? '0'.repeat(STORED_DIGITS - width) + digits
			: pad(Number(digits), STORED_DIGITS);
	const full = (digits: string) => pad(Number(digits), STORED_DIGITS);
	// The same rule for a variant code: `-00` is the start of 001 to 009, `-2` is 002.
	const leadVariant = (digits: string) =>
		digits === '' || (digits.length < VARIANT_DIGITS && digits.startsWith('0')) ? digits : pad(Number(digits), VARIANT_DIGITS);
	const code = (j: string | undefined, v: string | undefined) => (j && v ? j + pad(Number(v), VARIANT_DIGITS) : '');

	return {
		width,
		display(text) {
			let out = text.replace(STORED_IN_TEXT, (_m, p: string, d: string) => `${p}-${showSequence(d, width)}`);
			if (pnStored) {
				out = out.replace(
					pnStored,
					(_m, b: string, d: string, a: string, j?: string, v?: string) => b + showSequence(d, width) + a + (j && v ? j + v : '')
				);
			}
			return out;
		},
		canonical(value) {
			const v = value.trim();
			const d = canonicalDesignator(v);
			if (d !== v) return d;
			const m = pnAny?.exec(v);
			return m ? m[1]! + full(m[2]!) + m[3]! + code(m[4], m[5]) : value;
		},
		search(q) {
			const v = q.trim();
			const d = desigPartial.exec(v);
			if (d) return `${d[1]!.toUpperCase()}-${lead(d[2]!)}`;
			const pv = pnVariantPartial?.exec(v);
			if (pv) return pv[1]! + full(pv[2]!) + pv[3]! + pv[4]! + leadVariant(pv[5]!);
			const whole = pnAny?.exec(v);
			if (whole) return whole[1]! + lead(whole[2]!) + whole[3]!;
			const p = pnPartial?.exec(v);
			if (p) return p[1]! + lead(p[2]!);
			return q;
		},
		split(stored) {
			const m = pnSplit?.exec(stored);
			return m ? { base: m[1]!, variant: m[3] || null } : null;
		}
	};
}
