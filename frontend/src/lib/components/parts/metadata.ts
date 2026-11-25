import type { CustomFieldDef } from '@opal/shared';

/** Custom-field values as their controls hold them: text for inputs and selects, flags for checkboxes. */
export interface MetaValues {
	text: Record<string, string>;
	bool: Record<string, boolean>;
	/** Keys no custom field defines, as a JSON object, or '' for none. */
	extra: string;
}

/** Controls' values for `meta`; a missing key falls back to `fallback(field)` (the default on create). */
export function metaValues(
	fields: CustomFieldDef[],
	meta: Record<string, unknown> | null,
	fallback: (f: CustomFieldDef) => unknown = () => undefined
): MetaValues {
	const m = meta ?? {};
	const seed = (f: CustomFieldDef) => m[f.key] ?? fallback(f);
	const known = new Set(fields.map((f) => f.key));
	const extra = Object.fromEntries(Object.entries(m).filter(([k]) => !known.has(k)));
	return {
		text: Object.fromEntries(
			fields.filter((f) => f.type !== 'boolean').map((f) => [f.key, String(seed(f) ?? '')])
		),
		bool: Object.fromEntries(
			fields.filter((f) => f.type === 'boolean').map((f) => [f.key, Boolean(seed(f))])
		),
		extra: Object.keys(extra).length ? JSON.stringify(extra, null, 2) : ''
	};
}

/** The metadata object to send, or null for none. Throws with a message a person can act on. */
export function buildMetadata(
	fields: CustomFieldDef[],
	v: MetaValues
): Record<string, unknown> | null {
	let meta: Record<string, unknown> = {};
	if (v.extra.trim()) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(v.extra);
		} catch {
			throw new Error('Other metadata is not valid JSON');
		}
		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
			throw new Error('Other metadata must be a JSON object');
		meta = parsed as Record<string, unknown>;
	}
	for (const f of fields) {
		if (f.type === 'boolean') {
			if (v.bool[f.key]) meta[f.key] = true;
			continue;
		}
		const t = v.text[f.key];
		if (t !== '' && t !== undefined) meta[f.key] = f.type === 'number' ? Number(t) : t;
		else if (f.required) throw new Error(`${f.label} is required`);
	}
	return Object.keys(meta).length ? meta : null;
}
