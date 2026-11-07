/**
 * The capture fields of a step. 1.x kept them as free JSON and its MCP tools took any type, so a
 * released database can hold what OPAL 2 refuses to send, and one such field stops the whole
 * procedure opening. A field is kept in the shape OPAL 2 reads: nothing about it is refused here.
 */
import { DATA_FIELD_TYPES, type ProcedureDataField, type ProcedureDataSchema, zProcedureDataField } from '@opal/shared';
import { type ImportCtx, json, warn } from './context.ts';

/** Other names for a type OPAL 2 has. 1.3.2's own seed writes `string`. */
const SAME_TYPE: Record<string, ProcedureDataField['type']> = { string: 'text', checkbox: 'boolean' };
const NAME_MAX = 100;

function typeOf(c: ImportCtx, type: unknown, where: string): ProcedureDataField['type'] {
	if (typeof type === 'string') {
		if (SAME_TYPE[type]) return SAME_TYPE[type];
		if ((DATA_FIELD_TYPES as readonly string[]).includes(type)) return type as ProcedureDataField['type'];
	}
	warn(c, `${where}: type ${JSON.stringify(type)} is not in OPAL 2, read as text`);
	return 'text';
}

/** Captured values are stored by field name, so a name changes only when it cannot stand. */
function nameOf(c: ImportCtx, name: unknown, label: unknown, position: number, taken: Set<string>, where: string): string {
	const given = typeof name === 'string' ? name.trim() : '';
	const wanted = given || (typeof label === 'string' && label.trim()) || `field_${position + 1}`;
	let chosen = wanted.slice(0, NAME_MAX);
	for (let n = 2; taken.has(chosen); n++) chosen = `${wanted.slice(0, NAME_MAX - String(n).length - 1)}_${n}`;
	if (chosen !== given) warn(c, `${where}: name ${JSON.stringify(name ?? null)} is not usable, named "${chosen}"`);
	taken.add(chosen);
	return chosen;
}

/** The field with every property OPAL 2 refuses or has no place for left out, and said so. */
function readable(c: ImportCtx, field: Record<string, unknown>, where: string): ProcedureDataField {
	const known = Object.keys(zProcedureDataField.shape);
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(field)) {
		if (value === null) continue;
		if (known.includes(key)) out[key] = value;
		else warn(c, `${where}: property "${key}" has no place in OPAL 2, left out`);
	}
	const checked = zProcedureDataField.safeParse(out);
	if (checked.success) return checked.data;
	for (const key of new Set(checked.error.issues.map((i) => String(i.path[0])))) {
		warn(c, `${where}: property "${key}" is ${JSON.stringify(out[key])}, not what OPAL 2 reads, left out`);
		delete out[key];
	}
	return zProcedureDataField.parse(out);
}

/** A step's capture fields as OPAL 2 reads them, or null when it has none. */
export function captureFieldsFrom(c: ImportCtx, value: unknown, owner: string): ProcedureDataSchema | null {
	const schema = json<{ fields?: unknown }>(value);
	if (!schema || !Array.isArray(schema.fields)) return null;
	const taken = new Set<string>();
	const fields = schema.fields.flatMap((raw: unknown, i) => {
		if (!raw || typeof raw !== 'object') {
			warn(c, `${owner}: field ${i + 1} is ${JSON.stringify(raw)}, left out`);
			return [];
		}
		const f = raw as Record<string, unknown>;
		const where = `${owner}, field ${i + 1}`;
		const name = nameOf(c, f.name, f.label, i, taken, where);
		return [readable(c, { ...f, name, type: typeOf(c, f.type, where) }, where)];
	});
	return fields.length ? { fields } : null;
}
