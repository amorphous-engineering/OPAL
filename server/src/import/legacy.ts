/**
 * One-time, forward-only import from a Python-era OPAL database (Alembic head
 * b8d2f1a5c3e0) into the new schema. Phase 0 covers user, api_token and part.
 */
import { Database } from 'bun:sqlite';
import { PART_STATES, PROCUREMENT, QTY_SCALE, TRACKING_TYPES, now } from '@opal/shared';
import { existsSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { openDb } from '../db/client.ts';
import { apiToken, auditLog, part, user } from '../db/schema.ts';

export const LEGACY_HEAD = 'b8d2f1a5c3e0';
export const OLD_VERSION_MESSAGE =
	'This database is from an older OPAL version. Install the last 1.x release, start it once to upgrade the database, then start this version again.';

type Row = Record<string, unknown>;

export interface TableReport {
	read: number;
	imported: number;
	/** Legacy columns that have no home in the new schema. */
	droppedColumns: string[];
}

export interface ImportReport {
	source: string;
	dest: string;
	alembicVersion: string;
	at: string;
	tables: Record<'user' | 'api_token' | 'part', TableReport>;
	notImported: { table: string; rows: number; note: string }[];
	/** Parts with deleted_at set, imported as obsolete. */
	obsoleteParts: { id: number; internalPn: string }[];
	/** Parts without a part number, given LEGACY-<id>. */
	placeholderPns: { id: number; internalPn: string }[];
	/** Rows with values outside the new enums, and what they became. */
	warnings: string[];
	failedRows: { table: string; id: number; reason: string }[];
}

/** Columns the importer reads, per table. Everything else is dropped. */
const MAPPED = {
	user: [
		'id', 'username', 'name', 'email', 'password_hash', 'oidc_issuer', 'oidc_subject',
		'is_active', 'is_admin', 'created_at', 'updated_at'
	],
	api_token: [
		'id', 'user_id', 'name', 'token_hash', 'last_used_at', 'expires_at', 'revoked_at',
		'created_at'
	],
	part: [
		'id', 'internal_pn', 'external_pn', 'name', 'description', 'category', 'unit_of_measure',
		'tracking_type', 'procurement', 'tier', 'reorder_point', 'is_tooling',
		'calibration_interval_days', 'lifecycle_state', 'deleted_at', 'activated_at',
		'activated_by_id', 'created_at', 'updated_at'
	]
} as const;

/** '2026-10-24 09:16:24.601408' (naive UTC) to '2026-10-24T09:16:24.601Z'. */
export function legacyTimestamp(v: unknown): string | null {
	if (v === null || v === undefined || v === '') return null;
	const s = String(v).trim();
	const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.(\d+))?\s*(Z|[+-]\d{2}:?\d{2})?$/.exec(s);
	if (!m) throw new RangeError(`Unreadable timestamp: ${s}`);
	const ms = (m[3] ?? '').slice(0, 3).padEnd(3, '0');
	const tz = m[4] && m[4] !== 'Z' ? (m[4].includes(':') ? m[4] : `${m[4].slice(0, 3)}:${m[4].slice(3)}`) : 'Z';
	const d = new Date(`${m[1]}T${m[2]}.${ms}${tz}`);
	if (Number.isNaN(d.getTime())) throw new RangeError(`Unreadable timestamp: ${s}`);
	return d.toISOString();
}

function ts(v: unknown): string | null {
	return legacyTimestamp(v);
}

function tsReq(v: unknown): string {
	const t = legacyTimestamp(v);
	if (t === null) throw new RangeError('Missing timestamp');
	return t;
}

export function legacyQty(v: unknown): number | null {
	if (v === null || v === undefined) return null;
	return Math.round(Number(v) * QTY_SCALE);
}

const bool = (v: unknown) => Number(v) !== 0;
const str = (v: unknown) => (v === null || v === undefined ? null : String(v));
const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));

function tableNames(src: Database): string[] {
	return (
		src
			.query("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
			.all() as Row[]
	)
		.map((r) => String(r.name))
		.filter((n) => !n.startsWith('sqlite_') && n !== 'alembic_version' && !/_fts(_|$)/.test(n));
}

function columns(src: Database, table: string): string[] {
	return (src.query(`PRAGMA table_info("${table}")`).all() as Row[]).map((r) => String(r.name));
}

function dropped(src: Database, table: keyof typeof MAPPED): string[] {
	const mapped: readonly string[] = MAPPED[table];
	return columns(src, table).filter((c) => !mapped.includes(c));
}

/**
 * Read-only open. A WAL-mode file with no -wal sidecar cannot be opened plain read-only
 * (SQLite cannot create the -shm), and holds nothing outside the main file, so open it immutable.
 */
function openSource(path: string): Database {
	const wal = `${path}-wal`;
	if (existsSync(wal) && statSync(wal).size > 0) return new Database(path, { readonly: true });
	return new Database(`file:${encodeURI(path)}?mode=ro&immutable=1`, { readonly: true });
}

export function hasAlembicVersion(path: string): boolean {
	const src = openSource(path);
	try {
		return !!src
			.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'alembic_version'")
			.get();
	} finally {
		src.close();
	}
}

function oneOf<T extends string>(
	value: unknown,
	allowed: readonly T[],
	fallback: T,
	what: string,
	warnings: string[]
): T {
	const v = String(value ?? '').toLowerCase();
	if ((allowed as readonly string[]).includes(v)) return v as T;
	warnings.push(`${what}: "${String(value)}" is not valid, used "${fallback}"`);
	return fallback;
}

function chunks<T>(rows: T[], size: number): T[][] {
	const out: T[][] = [];
	for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
	return out;
}

export function importLegacy(srcPath: string, destPath: string): ImportReport {
	if (existsSync(destPath)) throw new Error(`Destination already exists: ${destPath}`);
	const src = openSource(srcPath);
	let db: ReturnType<typeof openDb> | undefined;
	try {
		const hasVersion = src
			.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'alembic_version'")
			.get();
		if (!hasVersion) throw new Error(`Not an OPAL database: ${srcPath}`);
		const version = (src.query('SELECT version_num FROM alembic_version').get() as Row | null)
			?.version_num;
		if (version !== LEGACY_HEAD) throw new Error(OLD_VERSION_MESSAGE);

		const report: ImportReport = {
			source: srcPath,
			dest: destPath,
			alembicVersion: String(version),
			at: now(),
			tables: {
				user: { read: 0, imported: 0, droppedColumns: dropped(src, 'user') },
				api_token: { read: 0, imported: 0, droppedColumns: dropped(src, 'api_token') },
				part: { read: 0, imported: 0, droppedColumns: dropped(src, 'part') }
			},
			notImported: [],
			obsoleteParts: [],
			placeholderPns: [],
			warnings: [],
			failedRows: []
		};

		const users = src.query('SELECT * FROM user ORDER BY id').all() as Row[];
		const tokens = src.query('SELECT * FROM api_token ORDER BY id').all() as Row[];
		const parts = src.query('SELECT * FROM part ORDER BY id').all() as Row[];
		report.tables.user.read = users.length;
		report.tables.api_token.read = tokens.length;
		report.tables.part.read = parts.length;

		const userRows = users.map((r) => ({
			id: Number(r.id),
			username: String(r.username),
			name: String(r.name),
			email: str(r.email),
			passwordHash: str(r.password_hash),
			oidcIssuer: str(r.oidc_issuer),
			oidcSubject: str(r.oidc_subject),
			isActive: bool(r.is_active),
			isAdmin: bool(r.is_admin),
			createdAt: tsReq(r.created_at),
			updatedAt: tsReq(r.updated_at)
		}));
		const tokenRows = tokens.map((r) => ({
			id: Number(r.id),
			userId: Number(r.user_id),
			name: String(r.name),
			tokenHash: String(r.token_hash),
			lastUsedAt: ts(r.last_used_at),
			expiresAt: ts(r.expires_at),
			revokedAt: ts(r.revoked_at),
			createdAt: tsReq(r.created_at)
		}));
		const partRows = parts.map((r) => {
			const id = Number(r.id);
			let internalPn = str(r.internal_pn);
			if (!internalPn) {
				internalPn = `LEGACY-${id}`;
				report.placeholderPns.push({ id, internalPn });
			}
			let state = oneOf(r.lifecycle_state, PART_STATES, 'draft', `part ${id} lifecycle_state`, report.warnings);
			if (r.deleted_at) {
				state = 'obsolete';
				report.obsoleteParts.push({ id, internalPn });
			}
			return {
				id,
				internalPn,
				externalPn: str(r.external_pn),
				name: String(r.name),
				description: str(r.description),
				category: str(r.category),
				unitOfMeasure: String(r.unit_of_measure),
				trackingType: oneOf(r.tracking_type, TRACKING_TYPES, 'bulk', `part ${id} tracking_type`, report.warnings),
				procurement: oneOf(r.procurement, PROCUREMENT, 'make', `part ${id} procurement`, report.warnings),
				tier: Number(r.tier),
				reorderPoint: legacyQty(r.reorder_point),
				isTooling: bool(r.is_tooling),
				calibrationIntervalDays: num(r.calibration_interval_days),
				state,
				activatedAt: ts(r.activated_at),
				activatedById: num(r.activated_by_id),
				createdAt: tsReq(r.created_at),
				updatedAt: tsReq(r.updated_at)
			};
		});

		// Parts reference users; a dangling activator would fail the FK. Clear it and say so.
		const userIds = new Set(userRows.map((u) => u.id));
		for (const p of partRows) {
			if (p.activatedById !== null && !userIds.has(p.activatedById)) {
				report.warnings.push(`part ${p.id}: activated_by_id ${p.activatedById} has no user, cleared`);
				p.activatedById = null;
			}
		}

		for (const t of tableNames(src)) {
			if (t in MAPPED) continue;
			const rows = (src.query(`SELECT COUNT(*) AS n FROM "${t}"`).get() as Row).n as number;
			report.notImported.push({ table: t, rows, note: 'not imported (Phase 1)' });
		}

		db = openDb(destPath);
		const d = db;
		// The import is a migration, not a user action: it writes no per-row audit rows,
		// only the one summary row per table below.
		d.transaction((tx) => {
			for (const c of chunks(userRows, 50)) tx.insert(user).values(c).run();
			for (const c of chunks(tokenRows, 50)) tx.insert(apiToken).values(c).run();
			for (const c of chunks(partRows, 50)) tx.insert(part).values(c).run();
			report.tables.user.imported = userRows.length;
			report.tables.api_token.imported = tokenRows.length;
			report.tables.part.imported = partRows.length;

			// Ids are never reused: counters sit at or above the highest imported id.
			for (const [name, ids] of [
				['user', userRows],
				['api_token', tokenRows],
				['part', partRows]
			] as const) {
				const max = ids.reduce((m, r) => Math.max(m, r.id), 0);
				if (max === 0) continue;
				const seq = d.$client.query('UPDATE sqlite_sequence SET seq = MAX(seq, ?) WHERE name = ?');
				if (seq.run(max, name).changes === 0) {
					d.$client.query('INSERT INTO sqlite_sequence (name, seq) VALUES (?, ?)').run(name, max);
				}
			}

			const at = now();
			for (const [name, t] of Object.entries(report.tables)) {
				tx.insert(auditLog)
					.values({
						at,
						entity: 'import',
						entityId: 0,
						action: 'create',
						op: 'legacy.import',
						after: { table: name, rows: t.imported, read: t.read }
					})
					.run();
			}
		});
		return report;
	} finally {
		src.close();
		if (db) {
			// Fold the WAL into the main file before close, so the file is complete on its own
			// when importInPlace renames it. A rename leaves the -wal sidecar behind.
			db.$client.run('PRAGMA wal_checkpoint(TRUNCATE)');
			db.$client.run('PRAGMA journal_mode = DELETE');
			db.$client.close(true);
		}
	}
}

export function renderReport(r: ImportReport): string {
	const L: string[] = [];
	L.push(`OPAL legacy import, ${r.at}`, `Source: ${r.source}`, `Result: ${r.dest}`, `Alembic: ${r.alembicVersion}`, '');
	L.push('Imported');
	for (const [name, t] of Object.entries(r.tables)) {
		L.push(`  ${name.padEnd(12)} ${String(t.imported).padStart(6)} of ${t.read}`);
		L.push(`    dropped columns: ${t.droppedColumns.join(', ') || '-'}`);
	}
	L.push('', 'Not imported (Phase 1)');
	for (const t of r.notImported) L.push(`  ${t.table.padEnd(32)} ${String(t.rows).padStart(6)} rows`);
	if (!r.notImported.length) L.push('  -');
	L.push('', `Obsolete parts (had deleted_at): ${r.obsoleteParts.length}`);
	for (const p of r.obsoleteParts) L.push(`  ${p.id}  ${p.internalPn}`);
	L.push('', `Parts given a placeholder number: ${r.placeholderPns.length}`);
	for (const p of r.placeholderPns) L.push(`  ${p.id}  ${p.internalPn}`);
	L.push('', `Warnings: ${r.warnings.length}`);
	for (const w of r.warnings) L.push(`  ${w}`);
	L.push('', `Failed rows: ${r.failedRows.length}`);
	for (const f of r.failedRows) L.push(`  ${f.table} ${f.id}: ${f.reason}`);
	return `${L.join('\n')}\n`;
}

/**
 * If the file at dbPath is a legacy database, import into <dbPath>.new, then rename the
 * old file to opal.legacy.db and the new one to opal.db. The old file is never changed.
 * Returns null when the file is already in the new format.
 */
export function importInPlace(dbPath: string): ImportReport | null {
	if (!existsSync(dbPath) || !hasAlembicVersion(dbPath)) return null;
	const dir = dirname(dbPath);
	const legacyPath = join(dir, 'opal.legacy.db');
	const newPath = `${dbPath}.new`;
	if (existsSync(legacyPath)) {
		throw new Error(`Cannot import: ${legacyPath} already exists. Move it, then start again.`);
	}
	for (const suffix of ['', '-wal', '-shm']) rmSync(newPath + suffix, { force: true });

	const report = importLegacy(dbPath, newPath);
	if (existsSync(`${newPath}-wal`)) throw new Error(`Import left ${newPath}-wal behind; not renaming.`);

	renameSync(dbPath, legacyPath);
	for (const suffix of ['-wal', '-shm']) {
		if (existsSync(dbPath + suffix)) renameSync(dbPath + suffix, legacyPath + suffix);
	}
	renameSync(newPath, join(dir, basename(dbPath)));
	for (const suffix of ['-wal', '-shm']) rmSync(newPath + suffix, { force: true });
	report.source = legacyPath;
	report.dest = dbPath;

	writeFileSync(join(dir, 'import-report.txt'), renderReport(report));
	writeFileSync(join(dir, 'import-report.json'), `${JSON.stringify(report, null, 2)}\n`);
	return report;
}
