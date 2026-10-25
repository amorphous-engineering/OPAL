// What the client shows about a number field's spec and a value against it. The same
// `specResult` and `specText` run on the server, so the flag here matches the blocker there.
import { specResult, specText, unitSymbol } from '@opal/shared';
import type { DocField } from './types.js';

export const unitOf = (f: DocField): string => (f.type === 'number' ? unitSymbol(f.unit) : '');

/** "12.125 – 12.25 in", or the older min / max with the unit; empty when the field has none. */
export function limitsText(f: DocField): string {
	if (f.spec) return specText(f.spec, f.unit);
	if (f.min == null && f.max == null) return unitSymbol(f.unit);
	const range = `${f.min ?? '…'} – ${f.max ?? '…'}`;
	return f.unit ? `${range} ${unitSymbol(f.unit)}` : range;
}

/** True when a value of a number field misses its spec. */
export const outOfSpec = (f: DocField, value: unknown): boolean =>
	f.type === 'number' && specResult(f.spec, value) === 'out_of_spec';

/** Names of the number fields of a step whose captured value misses the spec. */
export const outOfSpecFields = (
	fields: DocField[] | undefined,
	captured: Record<string, unknown> | null | undefined
): DocField[] => (fields ?? []).filter((f) => outOfSpec(f, captured?.[f.name]));
