/**
 * Which stored text mentions a blob hash. A published version holds hashes in its snapshot, an
 * execution copies step text that links `/api/blobs/<sha>`, and imported or plugin data may hold
 * one too. Rather than list every such column (and miss the next one), look in every text column
 * of every table except the ones that merely log or link blobs.
 */
import { getTableColumns, getTableName, is, like, or, sql } from 'drizzle-orm';
import { SQLiteTable, type SQLiteColumn } from 'drizzle-orm/sqlite-core';
import type { Db } from '../../db/client.ts';
import * as schema from '../../db/schema/index.ts';

/** The audit log records the hash of every upload; the blob and attachment tables are the store itself. */
const IGNORED = new Set(['blob', 'attachment', 'audit_log', 'legacy_audit']);

let scanned: { table: SQLiteTable; columns: SQLiteColumn[] }[] | undefined;

function textTables() {
	if (scanned) return scanned;
	scanned = [];
	for (const v of Object.values(schema)) {
		if (!is(v, SQLiteTable) || IGNORED.has(getTableName(v))) continue;
		const columns = Object.values(getTableColumns(v)).filter(
			(c) => c.columnType === 'SQLiteText' || c.columnType === 'SQLiteTextJson'
		) as SQLiteColumn[];
		if (columns.length) scanned.push({ table: v, columns });
	}
	return scanned;
}

/** Names of the tables the scan reads. */
export const blobScanTables = (): string[] => textTables().map((t) => getTableName(t.table));

/** True when any text column holds `sha256`. Cost grows with the data, so use it for rare questions. */
export function textHoldsBlob(db: Db): (sha256: string) => boolean {
	return (sha256) => {
		const pattern = `%${sha256}%`;
		return textTables().some(
			({ table, columns }) =>
				!!db
					.select({ one: sql`1` })
					.from(table)
					.where(or(...columns.map((c) => like(c, pattern))))
					.limit(1)
					.get()
		);
	};
}
