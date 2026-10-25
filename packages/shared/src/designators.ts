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

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The format around `{sequence}` as two regex sources. Null when the format has no sequence. */
function schemeParts(s: PartNumberScheme): { before: string; after: string } | null {
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
	const at = s.format.indexOf('{sequence}');
	if (at < 0) return null;
	return { before: src(s.format.slice(0, at)), after: src(s.format.slice(at + '{sequence}'.length)) };
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
	 * `WO-00` at width 4 finds WO-0000000001 to WO-0000000099.
	 */
	search(q: string): string;
}

export function numberCodec(width: number, scheme: PartNumberScheme = FALLBACK_SCHEME): NumberCodec {
	const parts = schemeParts(scheme);
	const pnStored = parts
		? new RegExp(`(?<![\\w-])(${parts.before})(\\d{${STORED_DIGITS}})(${parts.after})(?![\\w])`, 'g')
		: null;
	const pnAny = parts ? new RegExp(`^(${parts.before})(\\d{1,${STORED_DIGITS}})(${parts.after})$`) : null;
	const pnPartial = parts ? new RegExp(`^(${parts.before})(\\d{1,${STORED_DIGITS}})$`) : null;
	const desigPartial = new RegExp(`^(${ALT})-(\\d{1,${STORED_DIGITS}})$`, 'i');
	// Fewer digits than the width with a leading zero is the start of a shown number (WO-00 at
	// width 4 is WO-0001 to WO-0099). Anything else is a whole number (WO-4, WO-0004, WO-00004).
	const lead = (digits: string) =>
		digits.length < width && digits.startsWith('0')
			? '0'.repeat(STORED_DIGITS - width) + digits
			: pad(Number(digits), STORED_DIGITS);

	return {
		width,
		display(text) {
			let out = text.replace(STORED_IN_TEXT, (_m, p: string, d: string) => `${p}-${showSequence(d, width)}`);
			if (pnStored) out = out.replace(pnStored, (_m, b: string, d: string, a: string) => b + showSequence(d, width) + a);
			return out;
		},
		canonical(value) {
			const v = value.trim();
			const d = canonicalDesignator(v);
			if (d !== v) return d;
			const m = pnAny?.exec(v);
			return m ? m[1]! + pad(Number(m[2]), STORED_DIGITS) + m[3]! : value;
		},
		search(q) {
			const v = q.trim();
			const d = desigPartial.exec(v);
			if (d) return `${d[1]!.toUpperCase()}-${lead(d[2]!)}`;
			const full = pnAny?.exec(v);
			if (full) return full[1]! + lead(full[2]!) + full[3]!;
			const p = pnPartial?.exec(v);
			if (p) return p[1]! + lead(p[2]!);
			return q;
		}
	};
}
