/**
 * Value formatting. ISO 8601 everywhere (CLAUDE.md rule 3); relative age only
 * in dense index rows, always with the full timestamp as its title.
 */

import { session } from '#lib/session.svelte.js';

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

/**
 * How times display: the signed-in user's `timeDisplay` choice (storage is always UTC).
 * Reads the session, so anything that formats inside a template follows a change at once.
 */
export function timeMode(): 'local' | 'utc' {
	return session.user?.time_display === 'utc' ? 'utc' : 'local';
}

/** The browser's short zone name (EDT, CET, GMT+2), or UTC. */
export function zoneLabel(at: Date = new Date()): string {
	if (timeMode() === 'utc') return 'UTC';
	const part = new Intl.DateTimeFormat('en-US', { timeZoneName: 'short' })
		.formatToParts(at)
		.find((p) => p.type === 'timeZoneName');
	return part?.value ?? 'local';
}

/** Calendar and clock fields of an instant in the chosen zone. */
function fields(d: Date) {
	const u = timeMode() === 'utc';
	return {
		y: u ? d.getUTCFullYear() : d.getFullYear(),
		mo: pad((u ? d.getUTCMonth() : d.getMonth()) + 1),
		d: pad(u ? d.getUTCDate() : d.getDate()),
		h: pad(u ? d.getUTCHours() : d.getHours()),
		mi: pad(u ? d.getUTCMinutes() : d.getMinutes()),
		s: pad(u ? d.getUTCSeconds() : d.getSeconds())
	};
}

/** 2026-10-22 14:05 (local zone) or 2026-10-22 14:05Z (UTC). */
export function datetime(value: string | Date | null | undefined): string {
	const d = toDate(value);
	if (!d) return '—';
	const f = fields(d);
	return `${f.y}-${f.mo}-${f.d} ${f.h}:${f.mi}${timeMode() === 'utc' ? 'Z' : ''}`;
}

/** To the second, with the zone named: 2026-10-22 14:05:09Z or 2026-10-22 14:05:09 EDT. */
export function datetimeSec(value: string | Date | null | undefined): string {
	const d = toDate(value);
	if (!d) return '—';
	const f = fields(d);
	const tail = timeMode() === 'utc' ? 'Z' : ` ${zoneLabel(d)}`;
	return `${f.y}-${f.mo}-${f.d} ${f.h}:${f.mi}:${f.s}${tail}`;
}

/** The status bar clock: seconds, no zone (the bar labels the zone). */
export function clock(now: Date): string {
	const f = fields(now);
	return `${f.y}-${f.mo}-${f.d} ${f.h}:${f.mi}:${f.s}`;
}

/** 2026-10-22 (date-only values are rendered as given, never shifted by timezone). */
export function date(value: string | Date | null | undefined): string {
	if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
	// A date stored as midnight UTC (2026-11-03T00:00:00Z) is a calendar date, not an instant.
	if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T00:00:00(\.0+)?Z$/.test(value)) {
		return value.slice(0, 10);
	}
	const d = toDate(value);
	if (!d) return '—';
	const f = fields(d);
	return `${f.y}-${f.mo}-${f.d}`;
}

/** Full ISO 8601 in UTC, for tooltips. */
export function iso(value: string | Date | null | undefined): string {
	const d = toDate(value);
	return d ? d.toISOString() : '';
}

/** Tooltip: the UTC ISO value, plus the same instant in the local zone when that is the choice. */
export function tip(value: string | Date | null | undefined): string {
	const d = toDate(value);
	if (!d) return '';
	return timeMode() === 'utc' ? iso(d) : `${iso(d)}\n${datetimeSec(d)}`;
}

/** The value of an <input type="datetime-local"> for an instant, in the chosen zone. */
export function toInput(value: string | Date | null | undefined): string {
	const d = toDate(value);
	if (!d) return '';
	const f = fields(d);
	return `${f.y}-${f.mo}-${f.d}T${f.h}:${f.mi}`;
}

/** The UTC ISO instant for a datetime-local value typed in the chosen zone. */
export function fromInput(value: string): string | undefined {
	const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(value);
	if (!m) return undefined;
	const [y, mo, d, h, mi] = m.slice(1).map(Number);
	const at =
		timeMode() === 'utc' ? new Date(Date.UTC(y, mo - 1, d, h, mi)) : new Date(y, mo - 1, d, h, mi);
	return Number.isNaN(at.getTime()) ? undefined : at.toISOString();
}

/** The UTC instant at which a YYYY-MM-DD day starts in the chosen zone (plusDays shifts it). */
export function dayStart(day: string, plusDays = 0): string | undefined {
	const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
	if (!m) return undefined;
	const [y, mo, d] = [+m[1], +m[2], +m[3]];
	return (
		timeMode() === 'utc'
			? new Date(Date.UTC(y, mo - 1, d + plusDays))
			: new Date(y, mo - 1, d + plusDays)
	).toISOString();
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

/** Seconds worked → 2h 05m, or 12m 30s under an hour. */
export function workTime(seconds: number): string {
	const s = Math.max(0, Math.floor(seconds));
	const h = Math.floor(s / 3600);
	const m = Math.floor((s % 3600) / 60);
	const pad = (n: number) => String(n).padStart(2, '0');
	return h ? `${h}h ${pad(m)}m` : `${m}m ${pad(s % 60)}s`;
}

/** Minutes → 1h 30m. */
export function duration(minutes: number | null | undefined): string {
	if (minutes === null || minutes === undefined) return '—';
	const h = Math.floor(minutes / 60);
	const m = Math.round(minutes % 60);
	return h ? (m ? `${h}h ${m}m` : `${h}h`) : `${m}m`;
}
