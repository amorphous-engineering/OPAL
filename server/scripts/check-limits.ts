/**
 * Read-only check of a COPY of a database: lists stored values longer than the limit the API now
 * accepts for that field. Such a value can stop a record from opening where a schema is shared with a
 * read, and it cannot be saved again unchanged.
 *
 *   cd server && bun scripts/check-limits.ts /path/to/copy-of/opal.db
 *
 * It opens the file read-only and refuses the default data folder. Copy opal.db with its -wal and
 * -shm files.
 */
import { Database } from 'bun:sqlite';
import { contracts } from '@opal/shared';
import { getTableColumns, getTableName, is, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { SQLiteTable } from 'drizzle-orm/sqlite-core';
import { realpathSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import * as schema from '../src/db/schema/index.ts';

export interface OverLimit {
	table: string;
	column: string;
	id: unknown;
	/** The JSON key inside the column, when the value sits inside one. */
	key?: string;
	length: number;
	limit: number;
}

/** The largest limit any operation accepts, per field name. */
export function limitsByField(): Map<string, number> {
	const limits = new Map<string, number>();
	const seen = new Set<unknown>();
	const note = (key: string, max: number | null | undefined) => {
		if (max != null) limits.set(key, Math.max(limits.get(key) ?? 0, max));
	};
	const walk = (s: any, key: string): void => {
		const def = s?._zod?.def;
		if (!def) return;
		if (def.type === 'string') return note(key, s.maxLength);
		if (seen.has(s)) return;
		seen.add(s);
		if (def.type === 'object') for (const [k, v] of Object.entries(def.shape)) walk(v, k);
		else if (def.type === 'array') walk(def.element, key);
		else if (def.type === 'union') for (const o of def.options) walk(o, key);
		else if (def.type === 'pipe') {
			walk(def.in, key);
			walk(def.out, key);
		} else if (def.innerType) walk(def.innerType, key);
	};
	const ops = (node: any): void => {
		if (!node || typeof node !== 'object') return;
		if (node.input && node.output) return walk(node.input, '');
		for (const v of Object.values(node)) ops(v);
	};
	ops(contracts);
	limits.delete('');
	return limits;
}

export function overLimits(file: string): { over: OverLimit[]; skipped: string[] } {
	const sqlite = new Database(file, { readonly: true });
	const db = drizzle(sqlite);
	const limits = limitsByField();
	const over: OverLimit[] = [];
	const skipped: string[] = [];
	// The audit log keeps whatever was written. It is history and is never parsed as a record.
	for (const table of Object.values(schema)) {
		if (!is(table, SQLiteTable) || getTableName(table) === 'audit_log') continue;
		const name = getTableName(table);
		const columns = getTableColumns(table) as Record<string, any>;
		if (!columns.id) continue;
		for (const [key, col] of Object.entries(columns)) {
			try {
				if (col.dataType === 'json') {
					const walk = (v: unknown, k: string, id: unknown): void => {
						if (typeof v === 'string') {
							const limit = limits.get(k);
							if (limit !== undefined && v.length > limit) over.push({ table: name, column: col.name, id, key: k, length: v.length, limit });
						} else if (Array.isArray(v)) v.forEach((x) => walk(x, k, id));
						else if (v && typeof v === 'object') for (const [ck, cv] of Object.entries(v)) walk(cv, ck, id);
					};
					for (const r of db.select({ id: columns.id, v: col }).from(table).all()) walk(r.v, key, r.id);
				} else if (col.dataType === 'string') {
					const limit = limits.get(key);
					if (limit === undefined) continue;
					const n = sql<number>`length(${col})`;
					for (const r of db.select({ id: columns.id, n }).from(table).where(sql`length(${col}) > ${limit}`).all()) {
						over.push({ table: name, column: col.name, id: r.id, length: r.n, limit });
					}
				}
			} catch {
				skipped.push(`${name}.${col.name}`);
			}
		}
	}
	sqlite.close();
	return { over, skipped };
}

function defaultDatabase(): string {
	if (platform() === 'darwin') return join(homedir(), 'Library', 'Application Support', 'OPAL', 'opal.db');
	if (platform() === 'win32') return join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'OPAL', 'opal.db');
	return join(process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'), 'opal', 'opal.db');
}

if (import.meta.main) {
	const file = process.argv[2];
	if (!file) {
		console.error('Usage: bun scripts/check-limits.ts /path/to/copy-of/opal.db');
		process.exit(2);
	}
	const real = realpathSync(file);
	let live: string | null = null;
	try {
		live = realpathSync(defaultDatabase());
	} catch {
		/* no default database on this machine */
	}
	if (real === live) {
		console.error('This is the default database. Copy it and its -wal and -shm files elsewhere, and check the copy.');
		process.exit(2);
	}
	const { over, skipped } = overLimits(real);
	for (const o of over) {
		console.log(`${o.table}.${o.column}${o.key ? ` (${o.key})` : ''} id=${String(o.id)} length=${o.length} limit=${o.limit}`);
	}
	if (skipped.length) console.log(`Not checked, because this database has no such column yet: ${skipped.join(', ')}`);
	console.log(over.length ? `${over.length} stored value(s) over the limits.` : 'No stored value is over the limits.');
}
