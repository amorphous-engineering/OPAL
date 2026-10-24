/** audit_log, designator_sequence and the id counters. */
import { sql } from 'drizzle-orm';
import { designatorSequence, part, stockRecord } from '../db/schema/index.ts';
import { legacyAudit } from '../db/schema/legacy.ts';
import { validatePartNumber } from '../services/org/numbering.ts';
import { type ImportCtx, type Row, chunks, readTable, tableExists, warn } from './context.ts';

/** Legacy audit rows go into legacy_audit as they were. */
export function importAudit(c: ImportCtx): void {
	const rows = readTable(c, 'audit_log', ['id', 'timestamp', 'table_name', 'record_id', 'action', 'user_id', 'old_values', 'new_values']);
	if (!c.legacyTables) {
		warn(c, `audit_log: ${rows.length} rows not kept; the destination has no legacy_audit table`);
		return;
	}
	const text = (v: unknown) => (v === null || v === undefined ? null : typeof v === 'string' ? v : JSON.stringify(v));
	for (const part of chunks(rows, 100)) {
		c.d.insert(legacyAudit)
			.values(part.map((r) => ({
				id: Number(r.id),
				timestamp: String(r.timestamp),
				tableName: String(r.table_name),
				recordId: Number(r.record_id),
				action: String(r.action),
				userId: r.user_id === null ? null : Number(r.user_id),
				oldValues: text(r.old_values),
				newValues: text(r.new_values)
			})))
			.run();
	}
	c.report.tables.audit_log!.imported = rows.length;
}

const NUMBERED: [string, string, string][] = [
	['OPAL', 'stock_record', 'opal_number'],
	['WO', 'execution', 'work_order_number'],
	['IT', 'issue', 'issue_number'],
	['RISK', 'risk', 'risk_number'],
	['REQ', 'requirement', 'req_number'],
	['T', 'procedure', 'template_number']
];

/**
 * Every counter sits at or above the highest number in use: the legacy counter, and the
 * highest number found in the imported rows.
 */
export function importDesignators(c: ImportCtx): void {
	const level = new Map<string, number>();
	const bump = (prefix: string, n: number) => {
		if (Number.isFinite(n) && n > (level.get(prefix) ?? 0)) level.set(prefix, n);
	};
	let read = 0;
	if (tableExists(c.src, 'designator_sequence')) {
		const rows = c.src.query('SELECT designator_type, last_value FROM designator_sequence').all() as Row[];
		read = rows.length;
		for (const r of rows) bump(String(r.designator_type), Number(r.last_value));
	}
	const t = (c.report.tables.designator_sequence = { read, imported: 0, droppedColumns: ['created_at', 'updated_at'] });

	const sqlite = c.d.$client;
	for (const [prefix, table, column] of NUMBERED) {
		let exists = false;
		try {
			exists = !!sqlite.query(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(table);
		} catch {
			exists = false;
		}
		if (!exists) continue;
		const re = new RegExp(`^${prefix}-(\\d+)$`);
		for (const r of sqlite.query(`SELECT "${column}" AS v FROM "${table}"`).all() as Row[]) {
			const m = re.exec(String(r.v ?? ''));
			if (m) bump(prefix, Number(m[1]));
		}
	}
	// Serial numbers: SN-<part number>, three digits.
	const serials = c.d
		.select({ pn: part.internalPn, serial: stockRecord.serialNumber })
		.from(stockRecord)
		.innerJoin(part, sql`${part.id} = ${stockRecord.partId}`)
		.all();
	for (const s of serials) if (s.serial && /^\d+$/.test(s.serial)) bump(`SN-${s.pn}`, Number(s.serial));
	// Part numbers: PN-<tier>, the sequence of the highest number that matches the scheme.
	for (const p of c.d.select({ tier: part.tier, pn: part.internalPn }).from(part).all()) {
		try {
			bump(`PN-${p.tier}`, validatePartNumber(c.d, p.tier, p.pn));
		} catch {
			// A number outside the scheme (CAD designator, LEGACY-<id>) has no sequence.
		}
	}

	for (const [prefix, lastValue] of level) {
		c.d.insert(designatorSequence).values({ prefix, lastValue }).onConflictDoUpdate({ target: designatorSequence.prefix, set: { lastValue } }).run();
		t.imported++;
	}
	void warn;
}

/** Autoincrement counters sit above the highest id of each table. */
export function setSequences(c: ImportCtx): void {
	const sqlite = c.d.$client;
	const tables = sqlite
		.query("SELECT name FROM sqlite_master WHERE type = 'table' AND sql LIKE '%AUTOINCREMENT%'")
		.all() as { name: string }[];
	for (const { name } of tables) {
		const max = (sqlite.query(`SELECT MAX(id) AS m FROM "${name}"`).get() as { m: number | null }).m ?? 0;
		if (max === 0) continue;
		const set = sqlite.query('UPDATE sqlite_sequence SET seq = MAX(seq, ?) WHERE name = ?');
		if (set.run(max, name).changes === 0) sqlite.query('INSERT INTO sqlite_sequence (name, seq) VALUES (?, ?)').run(name, max);
	}
}
