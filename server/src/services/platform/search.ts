/**
 * Global search over SQLite FTS5.
 *
 * Each area registers what to index:
 *
 *   registerSearchable({
 *     type: 'issue',
 *     table: issue,
 *     columns: [issue.title, issue.description],      // indexed text
 *     identifier: issue.issueNumber,                  // optional: matches rank first
 *     where: ne(issue.state, 'void'),                 // optional: what stays searchable
 *     hit: (r) => ({ label: r.title, sublabel: r.issueNumber, href: `/issues/${r.id}`, status: r.state }),
 *   });
 *
 * The index is one external-content FTS5 table per entity, `<table>_fts`, with
 * the trigram tokenizer (substring matching) and triggers that keep it in
 * step. Drizzle does not model virtual tables, so the DDL is not in the
 * schema: `ftsStatements()` lists it for the lead's migrations, and
 * `ensureFts(db)` applies it directly (tests). Both are idempotent.
 * Queries shorter than three characters, and databases without the index,
 * fall back to LIKE.
 */
import type { SearchHit } from '@opal/shared';
import { getTableName, inArray, like, or, sql, type SQL } from 'drizzle-orm';
import type { SQLiteColumn, SQLiteTable } from 'drizzle-orm/sqlite-core';
import type { Ctx } from '../../context.ts';
import type { Db } from '../../db/client.ts';

type AnyTable = SQLiteTable & { id: SQLiteColumn; $inferSelect: any };

export interface Searchable<T extends AnyTable = AnyTable> {
	/** Entity type reported in each hit: `part`, `issue`. */
	type: string;
	table: T;
	/** Text columns to index. */
	columns: SQLiteColumn[];
	/** Human identifier (IT-00001). Hits whose identifier contains the query come first. */
	identifier?: SQLiteColumn;
	/** Rows to leave out (superseded, void). */
	where?: SQL;
	hit(row: T['$inferSelect']): Omit<SearchHit, 'entityType' | 'id'>;
}

const searchables = new Map<string, Searchable>();

export function registerSearchable<T extends AnyTable>(spec: Searchable<T>): void {
	searchables.set(spec.type, spec as unknown as Searchable);
}

export function searchableTypes(): string[] {
	return [...searchables.keys()];
}

// -------------------------------------------------------------------- schema

const ftsName = (s: Searchable) => `${getTableName(s.table)}_fts`;
const colNames = (s: Searchable) => s.columns.map((c) => c.name);

export function ftsStatementsFor(s: Searchable): string[] {
	const t = getTableName(s.table);
	const fts = ftsName(s);
	const cols = colNames(s);
	const list = cols.join(', ');
	const vals = (row: 'new' | 'old') => cols.map((c) => `coalesce(${row}.${c}, '')`).join(', ');
	const del = `INSERT INTO ${fts}(${fts}, rowid, ${list}) VALUES('delete', old.id, ${vals('old')})`;
	const ins = `INSERT INTO ${fts}(rowid, ${list}) VALUES (new.id, ${vals('new')})`;
	return [
		`CREATE VIRTUAL TABLE IF NOT EXISTS ${fts} USING fts5(${list}, content='${t}', content_rowid='id', tokenize='trigram')`,
		`CREATE TRIGGER IF NOT EXISTS ${fts}_ai AFTER INSERT ON ${t} BEGIN ${ins}; END`,
		`CREATE TRIGGER IF NOT EXISTS ${fts}_ad AFTER DELETE ON ${t} BEGIN ${del}; END`,
		`CREATE TRIGGER IF NOT EXISTS ${fts}_au AFTER UPDATE ON ${t} BEGIN ${del}; ${ins}; END`
	];
}

/** Statements that fill an index from rows that already exist. Run once, after the create statements. */
export function ftsRebuildStatement(s: Searchable): string {
	return `INSERT INTO ${ftsName(s)}(${ftsName(s)}) VALUES('rebuild')`;
}

/**
 * Every FTS statement for every registered searchable: create tables, triggers,
 * then a rebuild per table. Safe to run twice. Print it with
 * `bun scripts/fts-sql.ts` and put it in a migration after the tables exist.
 */
export function ftsStatements(): string[] {
	const all = [...searchables.values()];
	return [...all.flatMap(ftsStatementsFor), ...all.map(ftsRebuildStatement)];
}

/**
 * Create the indexes on an open database (tests; or at startup, as a safety net
 * that restores triggers a table rebuild dropped). A missing index is also filled.
 */
export function ensureFts(db: Db): void {
	for (const s of searchables.values()) {
		let exists = true;
		try {
			db.all(sql`SELECT rowid FROM ${sql.identifier(ftsName(s))} LIMIT 1`);
		} catch {
			exists = false;
		}
		for (const stmt of ftsStatementsFor(s)) db.run(sql.raw(stmt));
		if (!exists) db.run(sql.raw(ftsRebuildStatement(s)));
	}
}

// --------------------------------------------------------------------- query

function matchIds(db: Db, s: Searchable, q: string, limit: number): number[] | null {
	// A quoted phrase matches as a literal substring under the trigram tokenizer.
	const phrase = `"${q.replaceAll('"', '""')}"`;
	const fts = sql.identifier(ftsName(s));
	try {
		const rows = db.all<{ rowid: number }>(
			sql`SELECT rowid FROM ${fts} WHERE ${fts} MATCH ${phrase} ORDER BY rank LIMIT ${limit * 4}`
		);
		return rows.map((r) => r.rowid);
	} catch {
		return null; // no index yet
	}
}

const escapeLike = (q: string) => q.replace(/[\\%_]/g, (c) => `\\${c}`);

function searchOne(db: Db, s: Searchable, q: string, limit: number): SearchHit[] {
	const table = s.table;
	const pattern = `%${escapeLike(q)}%`;
	const likeAny = or(...s.columns.map((c) => sql`${c} LIKE ${pattern} ESCAPE '\\'`))!;
	const ids = q.length >= 3 ? matchIds(db, s, q, limit) : null;
	const scope = (extra: SQL | undefined) => {
		const parts = [extra, s.where].filter((x): x is SQL => x !== undefined);
		return parts.length ? sql.join(parts, sql` AND `) : undefined;
	};
	let rows: Record<string, unknown>[];
	if (ids) {
		rows = ids.length
			? (db.select().from(table).where(scope(inArray(table.id, ids))).all() as Record<string, unknown>[])
			: [];
		const rank = new Map(ids.map((id, i) => [id, i]));
		rows.sort((a, b) => rank.get(a.id as number)! - rank.get(b.id as number)!);
	} else {
		rows = db.select().from(table).where(scope(likeAny)).orderBy(sql`${table.id} DESC`).limit(limit).all() as Record<string, unknown>[];
	}
	if (s.identifier) {
		const idCol = s.identifier;
		const byNumber = db
			.select()
			.from(table)
			.where(scope(like(idCol, pattern)))
			.orderBy(idCol)
			.limit(limit)
			.all() as Record<string, unknown>[];
		const seen = new Set(byNumber.map((r) => r.id));
		rows = [...byNumber, ...rows.filter((r) => !seen.has(r.id))];
	}
	return rows.slice(0, limit).map((r) => ({
		entityType: s.type,
		id: r.id as number,
		...s.hit(r)
	}));
}

/** Hits from every registered entity type, up to `limit` each. */
export function search(ctx: Ctx, q: string, limit: number): SearchHit[] {
	const term = q.trim();
	if (!term) return [];
	return [...searchables.values()].flatMap((s) => searchOne(ctx.db, s, term, limit));
}

