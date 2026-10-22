/** Audit log entry as served by /api/audit (and the overview activity feed). */
import { datetime } from '#lib/format.js';

export interface FieldChange {
	field: string;
	old: unknown;
	new: unknown;
	old_label: string | null;
	new_label: string | null;
}

export interface AuditEntry {
	id: number;
	timestamp: string;
	action: 'create' | 'update' | 'delete' | string;
	entity_type: string;
	entity_label: string;
	record_label: string | null;
	href: string | null;
	user_id: number | null;
	user_name: string | null;
	changes: FieldChange[];
}

export const AUDIT_PAGE_SIZE = 100;

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

/** One value as text. Foreign keys prefer their resolved name; instants render as local time. */
export function formatValue(value: unknown, label?: string | null): string {
	if (label) return label;
	if (value === null || value === undefined || value === '') return '—';
	if (typeof value === 'boolean') return value ? 'yes' : 'no';
	if (typeof value === 'string' && ISO_INSTANT.test(value)) return datetime(value);
	if (typeof value === 'object') return JSON.stringify(value);
	return String(value);
}

/** snake_case column → readable field name. */
export function fieldName(field: string): string {
	return field.replace(/_id$/, '').replace(/_/g, ' ');
}

/** What an entry did, in one short line: the fields touched. */
export function changeSummary(entry: AuditEntry, max = 4): string {
	if (entry.action === 'create') return 'created';
	if (entry.action === 'delete') return 'deleted';
	const names = entry.changes.map((c) => fieldName(c.field));
	if (names.length === 0) return '—';
	return names.length > max
		? `${names.slice(0, max).join(', ')} +${names.length - max}`
		: names.join(', ');
}

export const actionTone = { create: 'ok', update: 'info', delete: 'error' } as const;
