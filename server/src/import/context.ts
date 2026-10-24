/**
 * Shared state and helpers of the legacy import. Every table importer gets one `ImportCtx`.
 */
import type { Database } from 'bun:sqlite';
import { QTY_SCALE } from '@opal/shared';
import type { Db } from '../db/client.ts';
import { legacyRow } from '../db/schema/legacy.ts';

export type Row = Record<string, unknown>;

export interface TableReport {
	read: number;
	imported: number;
	/** Legacy columns that have no home in the new schema. */
	droppedColumns: string[];
}

export interface StockDifference {
	stockId: number;
	opalNumber: string;
	partId: number;
	legacyQuantity: number;
	ledgerSum: number;
	difference: number;
	move: string;
}

export interface ImportReport {
	source: string;
	dest: string;
	alembicVersion: string;
	at: string;
	/** Per legacy table: rows read and rows written to its main new table. */
	tables: Record<string, TableReport>;
	/** Rows written to tables that have no legacy twin. */
	derived: Record<string, number>;
	/** Tables that are not imported, and why. */
	notImported: { table: string; rows: number; note: string }[];
	/** Parts with deleted_at set, imported as obsolete. */
	obsoleteParts: { id: number; internalPn: string }[];
	/** Parts without a part number, given LEGACY-<id>. */
	placeholderPns: { id: number; internalPn: string }[];
	/** Stock records whose old quantity differs from the sum of the built moves. */
	stockDifferences: StockDifference[];
	/** Purchase lines whose legacy received quantity had no receive moves; a holding stock record took the gap. */
	receiptGaps: { purchaseLineId: number; reference: string; partNumber: string; quantity: number; opalNumber: string }[];
	/** Rows with values outside the new enums, and what they became. */
	warnings: string[];
	failedRows: { table: string; id: number; reason: string }[];
}

export interface ImportOptions {
	/** Folder that holds the legacy files. Default: `<source folder>/attachments`. */
	attachmentsDir?: string;
	/** Where blob files go. Default: `<destination folder>/blobs`. */
	blobsDir?: string;
	/** Where avatar files go. Default: `<destination folder>/avatars`. */
	avatarsDir?: string;
}

export interface ResolvedOptions {
	attachmentsDir: string;
	blobsDir: string;
	avatarsDir: string;
	/** False when the destination has no legacy_audit and legacy_row tables. Their rows are then lost. */
	legacyTables: boolean;
}

export interface ImportCtx {
	legacyTables: boolean;
	src: Database;
	d: Db;
	report: ImportReport;
	attachmentsDir: string;
	blobsDir: string;
	avatarsDir: string;
	/** Ids that exist in the destination, per new table. Filled as tables are written. */
	ids: Record<string, Set<number>>;
	projectId: number;
}

export function emptyReport(source: string, dest: string, version: string, at: string): ImportReport {
	return {
		source,
		dest,
		alembicVersion: version,
		at,
		tables: {},
		derived: {},
		notImported: [],
		obsoleteParts: [],
		placeholderPns: [],
		stockDifferences: [],
		receiptGaps: [],
		warnings: [],
		failedRows: []
	};
}

// ---------------------------------------------------------------- value conversion

/** '2026-10-24 09:16:24.601408' (naive UTC) to '2026-10-24T09:16:24.601Z'. */
export function legacyTimestamp(v: unknown): string | null {
	if (v === null || v === undefined || v === '') return null;
	const s = String(v).trim();
	const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.(\d+))?\s*(Z|[+-]\d{2}:?\d{2})?$/.exec(s);
	if (!m) {
		// A bare date (a DATE column read as a timestamp) is midnight UTC.
		if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return `${s}T00:00:00.000Z`;
		throw new RangeError(`Unreadable timestamp: ${s}`);
	}
	const ms = (m[3] ?? '').slice(0, 3).padEnd(3, '0');
	const tz = m[4] && m[4] !== 'Z' ? (m[4].includes(':') ? m[4] : `${m[4].slice(0, 3)}:${m[4].slice(3)}`) : 'Z';
	const d = new Date(`${m[1]}T${m[2]}.${ms}${tz}`);
	if (Number.isNaN(d.getTime())) throw new RangeError(`Unreadable timestamp: ${s}`);
	return d.toISOString();
}

export const ts = (v: unknown): string | null => legacyTimestamp(v);

export function tsReq(v: unknown): string {
	const t = legacyTimestamp(v);
	if (t === null) throw new RangeError('Missing timestamp');
	return t;
}

/** A calendar date, YYYY-MM-DD. */
export function dateOnly(v: unknown): string | null {
	if (v === null || v === undefined || v === '') return null;
	const s = String(v).trim();
	return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null;
}

export function legacyQty(v: unknown): number | null {
	if (v === null || v === undefined) return null;
	return Math.round(Number(v) * QTY_SCALE);
}

export const bool = (v: unknown) => Number(v) !== 0;
export const str = (v: unknown) => (v === null || v === undefined ? null : String(v));
export const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));

/** A JSON column read from SQLite: text, or already parsed. */
export function json<T = unknown>(v: unknown): T | null {
	if (v === null || v === undefined || v === '') return null;
	if (typeof v !== 'string') return v as T;
	try {
		return JSON.parse(v) as T;
	} catch {
		return null;
	}
}

export function oneOf<T extends string>(
	c: ImportCtx,
	value: unknown,
	allowed: readonly T[],
	fallback: T,
	what: string
): T {
	const v = String(value ?? '').toLowerCase();
	if ((allowed as readonly string[]).includes(v)) return v as T;
	c.report.warnings.push(`${what}: "${String(value)}" is not valid, used "${fallback}"`);
	return fallback;
}

export function chunks<T>(rows: T[], size: number): T[][] {
	const out: T[][] = [];
	for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
	return out;
}

// ---------------------------------------------------------------- reading

export function tableExists(src: Database, name: string): boolean {
	return !!src.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
}

export function columns(src: Database, table: string): string[] {
	return (src.query(`PRAGMA table_info("${table}")`).all() as Row[]).map((r) => String(r.name));
}

/**
 * Reads every row of a legacy table in id order and records the read count and the columns
 * the importer does not use. `used` lists the columns that have a home.
 */
export function readTable(c: ImportCtx, table: string, used: readonly string[], order = 'id'): Row[] {
	if (!tableExists(c.src, table)) {
		c.report.tables[table] = { read: 0, imported: 0, droppedColumns: [] };
		return [];
	}
	const rows = c.src.query(`SELECT * FROM "${table}" ORDER BY ${order}`).all() as Row[];
	c.report.tables[table] = {
		read: rows.length,
		imported: 0,
		droppedColumns: columns(c.src, table).filter((col) => !used.includes(col))
	};
	return rows;
}

export function fail(c: ImportCtx, table: string, id: number, reason: string): void {
	c.report.failedRows.push({ table, id, reason });
}

/** Keeps the rows that pass `why` (null: fine). A row that fails is reported, with the reason. */
export function keep<T extends Row>(c: ImportCtx, table: string, rows: T[], why: (r: T) => string | null): T[] {
	return rows.filter((r) => {
		const reason = why(r);
		if (reason === null) return true;
		fail(c, table, Number(r.id ?? 0), reason);
		return false;
	});
}

export function warn(c: ImportCtx, message: string): void {
	c.report.warnings.push(message);
}

/** Keeps a legacy row that has no home, with the reason. */
export function keepLegacyRow(c: ImportCtx, table: string, row: Row, reason: string): void {
	if (!c.legacyTables) {
		warn(c, `${table} ${String(row.id ?? '')}: not kept (${reason}); the destination has no legacy_row table`);
		return;
	}
	c.d.insert(legacyRow)
		.values({
			tableName: table,
			rowId: typeof row.id === 'number' ? row.id : null,
			reason,
			data: JSON.parse(JSON.stringify(row, (_k, v) => (v instanceof Uint8Array ? `<${v.byteLength} bytes>` : v)))
		})
		.run();
	c.report.derived.legacy_row = (c.report.derived.legacy_row ?? 0) + 1;
}

/**
 * An id that must name an existing row of `table`, or null. A dangling reference is cleared
 * and reported once per source row.
 */
export function ref(c: ImportCtx, table: string, value: unknown, what: string): number | null {
	if (value === null || value === undefined) return null;
	const id = Number(value);
	if (c.ids[table]?.has(id)) return id;
	warn(c, `${what}: ${table} ${id} does not exist, cleared`);
	return null;
}

export function track(c: ImportCtx, table: string, ids: Iterable<number>): void {
	const set = (c.ids[table] ??= new Set());
	for (const i of ids) set.add(i);
}

// ---------------------------------------------------------------- writing

type InsertTable = Parameters<Db['insert']>[0];

/**
 * Inserts rows in chunks. A chunk that a constraint rejects is retried row by row, and the
 * rows that still fail are reported as failed. Returns the ids that were written.
 */
export function insertRows(
	c: ImportCtx,
	legacyTable: string,
	table: InsertTable,
	rows: Record<string, unknown>[],
	opts: { count?: boolean; idOf?: (r: any) => number } = {}
): number[] {
	const written: number[] = [];
	const idOf = opts.idOf ?? ((r: any) => Number(r.id ?? 0));
	const one = (r: any) => {
		try {
			c.d.insert(table).values(r).run();
			written.push(idOf(r));
		} catch (e) {
			fail(c, legacyTable, idOf(r), e instanceof Error ? e.message : String(e));
		}
	};
	for (const part of chunks(rows, 40)) {
		try {
			c.d.insert(table).values(part as any).run();
			for (const r of part) written.push(idOf(r));
		} catch {
			for (const r of part) one(r);
		}
	}
	if (opts.count !== false) {
		const t = c.report.tables[legacyTable];
		if (t) t.imported += written.length;
	}
	return written;
}

export function derived(c: ImportCtx, name: string, n: number): void {
	c.report.derived[name] = (c.report.derived[name] ?? 0) + n;
}
