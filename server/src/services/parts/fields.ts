/** Project-defined part fields (`custom_fields` in the project configuration). */
import { type CustomFieldDef, CUSTOM_FIELD_TYPES, OpalError } from '@opal/shared';
import type { Db } from '../../db/client.ts';
import { getProjectConfig } from '../org/project.ts';

type Spec = unknown;
const isType = (v: unknown): v is CustomFieldDef['type'] => (CUSTOM_FIELD_TYPES as readonly unknown[]).includes(v);
const title = (key: string) => key.replaceAll('_', ' ').trim().replace(/\b\w/g, (c) => c.toUpperCase());

/**
 * Normalise the stored definitions. Accepts `key: type`, `key: [options]` and
 * `key: {label, type, options, default, required}` so hand-written configs stay valid.
 */
export function customFieldDefs(raw: Record<string, Spec>): CustomFieldDef[] {
	return Object.entries(raw).map(([key, spec]): CustomFieldDef => {
		const label = title(key);
		if (Array.isArray(spec)) {
			return { key, label, type: 'select', options: spec.map(String), default: null, required: false };
		}
		if (spec && typeof spec === 'object') {
			const s = spec as Record<string, unknown>;
			const options = Array.isArray(s.options) ? s.options.map(String) : [];
			const kind = s.type ?? (options.length ? 'select' : 'text');
			return {
				key,
				label: typeof s.label === 'string' ? s.label : label,
				type: isType(kind) ? kind : 'text',
				options,
				default: s.default ?? null,
				required: Boolean(s.required)
			};
		}
		return { key, label, type: isType(spec) ? spec : 'text', options: [], default: null, required: false };
	});
}

export function projectFieldDefs(db: Db): CustomFieldDef[] {
	return customFieldDefs(getProjectConfig(db)?.customFields ?? {});
}

/**
 * Check `metadata` against the project's field definitions. Keys without a definition pass
 * through untouched. Returns the cleaned object, or null when empty.
 */
export function validateMetadata(
	db: Db,
	metadata: Record<string, unknown> | null | undefined,
	opts: { requireAll: boolean }
): Record<string, unknown> | null {
	const defs = projectFieldDefs(db);
	const meta: Record<string, unknown> = { ...(metadata ?? {}) };
	const problems: Record<string, string> = {};
	for (const f of defs) {
		const v = meta[f.key];
		if (v === undefined || v === null || v === '') {
			delete meta[f.key];
			if (f.required && opts.requireAll) problems[`metadata.${f.key}`] = `${f.label} is required`;
			continue;
		}
		if (f.type === 'number' && (typeof v !== 'number' || !Number.isFinite(v))) problems[`metadata.${f.key}`] = `${f.label} must be a number`;
		else if (f.type === 'boolean' && typeof v !== 'boolean') problems[`metadata.${f.key}`] = `${f.label} must be true or false`;
		else if (f.type === 'text' && typeof v !== 'string') problems[`metadata.${f.key}`] = `${f.label} must be text`;
		else if (f.type === 'select' && (typeof v !== 'string' || (f.options.length && !f.options.includes(v)))) {
			problems[`metadata.${f.key}`] = `${f.label} must be one of ${f.options.join(', ')}`;
		}
	}
	if (Object.keys(problems).length) throw new OpalError(422, 'invalid_input', 'Invalid input', problems);
	return Object.keys(meta).length ? meta : null;
}
