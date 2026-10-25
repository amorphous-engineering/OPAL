/** Check point values against a dataset schema. */
import { OpalError, type DatasetSchema, type PointValues, type SchemaField, isUnitCode, specResult } from '@opal/shared';

const isIsoDate = (v: string) => /^\d{4}-\d{2}-\d{2}([T ].*)?$/.test(v) && !Number.isNaN(Date.parse(v));

function checkValue(f: SchemaField, v: string | number | boolean): string | null {
	switch (f.type) {
		case 'number':
			if (typeof v !== 'number' || !Number.isFinite(v)) return `Field '${f.name}' must be a number`;
			if (f.spec) return null; // out of spec is stored and flagged, never refused
			if (f.min !== undefined && v < f.min) return `Field '${f.name}' is below the minimum ${f.min}`;
			if (f.max !== undefined && v > f.max) return `Field '${f.name}' is above the maximum ${f.max}`;
			return null;
		case 'boolean':
			return typeof v === 'boolean' ? null : `Field '${f.name}' must be true or false`;
		case 'date':
			return typeof v === 'string' && isIsoDate(v) ? null : `Field '${f.name}' must be an ISO 8601 date`;
		case 'text':
			return typeof v === 'string' ? null : `Field '${f.name}' must be text`;
	}
}

/** The spec fields a point misses, by name. */
export function outOfSpecFields(schema: DatasetSchema, values: PointValues): string[] {
	return schema.fields.filter((f) => f.spec && specResult(f.spec, values[f.name]) === 'out_of_spec').map((f) => f.name);
}

/** A schema being saved: units are known codes, a spec does not come with min or max. */
export function checkSchema(schema: DatasetSchema): void {
	for (const f of schema.fields) {
		const bad = (msg: string, key: string) => {
			throw new OpalError(422, 'invalid_input', `${f.name}: ${msg}`, { [`${f.name}.${key}`]: msg });
		};
		if (f.unit && !isUnitCode(f.unit)) bad(`unknown unit '${f.unit}'`, 'unit');
		if (f.spec && (f.min !== undefined || f.max !== undefined)) bad('a spec replaces min and max; set one or the other', 'spec');
	}
}

/**
 * Problems with `values`, by field name. A schema with no fields accepts anything (legacy).
 * A null value counts as absent.
 */
export function pointProblems(schema: DatasetSchema, values: PointValues): Record<string, string> {
	const problems: Record<string, string> = {};
	if (schema.fields.length === 0) return problems;
	const fields = new Map(schema.fields.map((f) => [f.name, f]));
	for (const [name, value] of Object.entries(values)) {
		const f = fields.get(name);
		if (!f) problems[name] = `Unknown field '${name}'`;
		else if (value !== null) {
			const msg = checkValue(f, value);
			if (msg) problems[name] = msg;
		}
	}
	for (const f of schema.fields) {
		if (f.required && (values[f.name] ?? null) === null && !problems[f.name]) {
			problems[f.name] = `Field '${f.name}' is required`;
		}
	}
	return problems;
}

export function checkPoint(schema: DatasetSchema, values: PointValues): void {
	const problems = pointProblems(schema, values);
	const first = Object.values(problems)[0];
	if (first) throw new OpalError(422, 'invalid_input', first, problems);
}
