/**
 * Value formatting. ISO 8601 everywhere (CLAUDE.md rule 3); relative age only
 * in dense index rows, always with the full timestamp as its title.
 */

export function toDate(value: string | Date | null | undefined): Date | null {
	if (!value) return null;
	// Naive server timestamps are UTC.
	const d =
		value instanceof Date
			? value
			: new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(value) ? value : `${value}Z`);
	return Number.isNaN(d.getTime()) ? null : d;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** 2026-10-22 14:05 (local time). */
export function datetime(value: string | Date | null | undefined): string {
	const d = toDate(value);
	if (!d) return '—';
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 2026-10-22 (date-only values are rendered as given, never shifted by timezone). */
export function date(value: string | Date | null | undefined): string {
	if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
	const d = toDate(value);
	if (!d) return '—';
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Full ISO 8601 with offset, for tooltips. */
export function iso(value: string | Date | null | undefined): string {
	const d = toDate(value);
	return d ? d.toISOString() : '';
}

/** Compact age for dense rows: 45s, 12m, 3h, 5d, 7w, 2y. */
export function age(value: string | Date | null | undefined, now = Date.now()): string {
	const d = toDate(value);
	if (!d) return '—';
	const s = Math.max(0, Math.round((now - d.getTime()) / 1000));
	if (s < 60) return `${s}s`;
	if (s < 3600) return `${Math.floor(s / 60)}m`;
	if (s < 86400) return `${Math.floor(s / 3600)}h`;
	if (s < 86400 * 14) return `${Math.floor(s / 86400)}d`;
	if (s < 86400 * 365) return `${Math.floor(s / (86400 * 7))}w`;
	return `${Math.floor(s / (86400 * 365))}y`;
}

/** Quantities: trim trailing zeros from server decimals (1.5000 → 1.5). */
export function qty(value: number | string | null | undefined, uom?: string | null): string {
	if (value === null || value === undefined || value === '') return '—';
	const n = typeof value === 'number' ? value : Number(value);
	if (Number.isNaN(n)) return String(value);
	const s = Number.isInteger(n) ? String(n) : String(Number(n.toFixed(4)));
	return uom && uom !== 'ea' ? `${s} ${uom}` : s;
}

export function money(value: number | string | null | undefined, currency = 'USD'): string {
	if (value === null || value === undefined || value === '') return '—';
	const n = Number(value);
	if (Number.isNaN(n)) return String(value);
	return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(n);
}

/** A unit price: two decimals, up to four when the price has them ($0.0425, never $0.04). */ // added by QA
export function unitMoney(value: number | string | null | undefined, currency = 'USD'): string {
	if (value === null || value === undefined || value === '') return '—';
	const n = Number(value);
	if (Number.isNaN(n)) return String(value);
	return new Intl.NumberFormat(undefined, {
		style: 'currency',
		currency,
		minimumFractionDigits: 2,
		maximumFractionDigits: 4
	}).format(n);
}

/** snake_case / enum values → UPPER WORDS for state text. */
export function stateLabel(value: string | null | undefined): string {
	return value ? value.replace(/_/g, ' ').toUpperCase() : '—';
}

/** Minutes → 1h 30m. */
export function duration(minutes: number | null | undefined): string {
	if (minutes === null || minutes === undefined) return '—';
	const h = Math.floor(minutes / 60);
	const m = Math.round(minutes % 60);
	return h ? (m ? `${h}h ${m}m` : `${h}h`) : `${m}m`;
}
