/**
 * The API boundary for sequence numbers (see `designators.ts` in shared). Inputs that name a
 * record by its number are turned into the stored form; every output string has stored
 * numbers turned into the display width.
 */
import type { NumberCodec } from '@opal/shared';

/** Input fields whose whole value is a number. Free-text fields are never rewritten. */
const NUMBER_KEYS = new Set([
	'opalNumber',
	'woNumber',
	'issueNumber',
	'riskNumber',
	'reqNumber',
	'templateNumber',
	'internalPn',
	'partNumber'
]);

/** Search fields: a whole or partial number becomes what the stored form contains. */
const SEARCH_KEYS = new Set(['q']);

export function canonicalInput(value: unknown, codec: NumberCodec): unknown {
	if (Array.isArray(value)) return value.map((v) => canonicalInput(v, codec));
	// Only plain objects: an uploaded File and the like pass through as they are.
	if (!value || typeof value !== 'object' || value.constructor !== Object) return value;
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(value)) {
		if (typeof v === 'string' && NUMBER_KEYS.has(k)) out[k] = codec.canonical(v);
		else if (typeof v === 'string' && SEARCH_KEYS.has(k)) out[k] = codec.search(v);
		else out[k] = canonicalInput(v, codec);
	}
	return out;
}

export function displayOutput<T>(value: T, codec: NumberCodec): T {
	if (typeof value === 'string') return codec.display(value) as T;
	if (Array.isArray(value)) return value.map((v) => displayOutput(v, codec)) as T;
	if (!value || typeof value !== 'object' || value.constructor !== Object) return value;
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(value)) out[k] = displayOutput(v, codec);
	return out as T;
}
