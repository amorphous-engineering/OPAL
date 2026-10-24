/**
 * One-time, forward-only import from a Python-era OPAL database (Alembic head
 * b8d2f1a5c3e0) into the new schema. Every legacy table is moved or listed as skipped.
 *
 * The import writes rows directly in one transaction: it is a migration, not a user action.
 * It records one audit row per table. The source file is never opened; a private copy is read.
 */
import { Database } from 'bun:sqlite';
import { now } from '@opal/shared';
import { copyFileSync, existsSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import type { Db } from '../db/client.ts';
import { auditLog } from '../db/schema/index.ts';
import { importAttachments } from './attachments.ts';
import {
	type ImportCtx,
	type ImportOptions,
	type ImportReport,
	type ResolvedOptions,
	type Row,
	emptyReport,
	fail,
	tableExists
} from './context.ts';
import { importExecutions } from './execution.ts';
import { importAudit, importDesignators, setSequences } from './finish.ts';
import { importInventory } from './inventory.ts';
import { openImportDb } from './open.ts';
import { importPeople, importProject, importRoles, importSettings } from './org.ts';
import { importParts, importPurchasing, importSuppliers } from './parts.ts';
import { importProcedures } from './procedures.ts';
import { importDatasets, importIssues, importNotifications, importRequirements, importRisks } from './tracking.ts';

export { legacyQty, legacyTimestamp } from './context.ts';
export type { ImportCtx, ImportOptions, ImportReport, TableReport } from './context.ts';
export { openSchemaImportDb } from './open.ts';

export const LEGACY_HEAD = 'b8d2f1a5c3e0';
export const OLD_VERSION_MESSAGE =
	'This database is from an older OPAL version. Install the last 1.x release, start it once to upgrade the database, then start this version again.';

/** Tables that are not imported, with the reason. Row counts are read from the source. */
const SKIPPED: Record<string, string> = {
	extension: 'extensions are postponed (decision O3)',
	onshape_link: 'Onshape is postponed (decision O3)',
	onshape_sync_log: 'Onshape is postponed (decision O3)',
	webauthn_challenge: 'short-lived sign-in state (rows live 5 minutes)',
	auth_session: 'sessions end at the import; people sign in again'
};

function tableNames(src: Database): string[] {
	return (src.query("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as Row[])
		.map((r) => String(r.name))
		.filter((n) => !n.startsWith('sqlite_') && n !== 'alembic_version');
}

/**
 * Opens a private copy of the source. The old file is never opened, so it stays
 * byte-identical. Read-only opens are not portable: a WAL file with no -wal sidecar
 * needs an immutable URI, and Bun's bundled SQLite on Linux rejects URI filenames.
 */
export function openSource(path: string): { db: Database; close(): void } {
	const dir = mkdtempSync(join(tmpdir(), 'opal-import-src-'));
	const copy = join(dir, 'source.db');
	copyFileSync(path, copy);
	if (existsSync(`${path}-wal`)) copyFileSync(`${path}-wal`, `${copy}-wal`);
	const db = new Database(copy);
	return {
		db,
		close() {
			db.close();
			rmSync(dir, { recursive: true, force: true });
		}
	};
}

export function hasAlembicVersion(path: string): boolean {
	const source = openSource(path);
	try {
		return !!source.db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'alembic_version'").get();
	} finally {
		source.close();
	}
}

/** Checks the source and returns its Alembic version. */
export function checkSource(src: Database, label: string): string {
	if (!tableExists(src, 'alembic_version')) throw new Error(`Not an OPAL database: ${label}`);
	const version = (src.query('SELECT version_num FROM alembic_version').get() as Row | null)?.version_num;
	if (version !== LEGACY_HEAD) throw new Error(OLD_VERSION_MESSAGE);
	return String(version);
}

/**
 * Copies every legacy table into `d`, in one transaction. `d` has the current schema and no
 * rows. Also used for the demo database.
 */
export function importInto(src: Database, d: Db, report: ImportReport, opts: ResolvedOptions): void {
	const sqlite = d.$client;
	const c: ImportCtx = { legacyTables: opts.legacyTables, src, d, report, attachmentsDir: opts.attachmentsDir, blobsDir: opts.blobsDir, avatarsDir: opts.avatarsDir, ids: {}, projectId: 0 };
	// Foreign keys are checked once at the end, so cycles (a risk and its realized issue) and
	// order do not matter. A violation is reported as a failed row.
	sqlite.run('PRAGMA foreign_keys = OFF');
	sqlite.run('BEGIN');
	try {
		importPeople(c);
		importRoles(c);
		importSettings(c);
		c.projectId = importProject(c);
		importParts(c);
		importSuppliers(c);
		importPurchasing(c);
		const blobs = importAttachments(c);
		importProcedures(c, blobs);
		const links = importInventory(c);
		importIssues(c);
		importRisks(c);
		importRequirements(c);
		importDatasets(c);
		importNotifications(c);
		importExecutions(c, links);
		importAudit(c);
		importDesignators(c);
		setSequences(c);

		for (const t of tableNames(src)) {
			if (t in c.report.tables || t in SKIPPED || /_fts(_|$)/.test(t)) continue;
			const rows = (src.query(`SELECT COUNT(*) AS n FROM "${t}"`).get() as Row).n as number;
			c.report.notImported.push({ table: t, rows, note: 'no importer' });
			if (rows > 0) fail(c, t, 0, `${rows} rows have no importer`);
		}
		for (const [t, note] of Object.entries(SKIPPED)) {
			if (!tableExists(src, t)) continue;
			c.report.notImported.push({ table: t, rows: (src.query(`SELECT COUNT(*) AS n FROM "${t}"`).get() as Row).n as number, note });
		}
		for (const t of tableNames(src).filter((n) => n.endsWith('_fts'))) {
			let rows = 0;
			try {
				rows = (src.query(`SELECT COUNT(*) AS n FROM "${t}"`).get() as Row).n as number;
			} catch {
				rows = 0;
			}
			c.report.notImported.push({ table: t, rows, note: 'search index, rebuilt by the server' });
		}

		for (const v of sqlite.query('PRAGMA foreign_key_check').all() as { table: string; rowid: number; parent: string }[]) {
			fail(c, v.table, v.rowid, `foreign key to ${v.parent} has no target`);
		}

		const at = now();
		const entries = [
			...Object.entries(report.tables).map(([name, t]) => ({ table: name, rows: t.imported, read: t.read })),
			...Object.entries(report.derived).map(([name, rows]) => ({ table: name, rows, read: rows }))
		];
		for (const e of entries) {
			d.insert(auditLog)
				.values({ at, entity: 'import', entityId: 0, action: 'create', op: 'legacy.import', after: e })
				.run();
		}
		sqlite.run('COMMIT');
	} catch (e) {
		sqlite.run('ROLLBACK');
		throw e;
	} finally {
		sqlite.run('PRAGMA foreign_keys = ON');
	}
}

export async function importLegacy(srcPath: string, destPath: string, options: ImportOptions & { open?: (path: string) => Promise<Db> } = {}): Promise<ImportReport> {
	if (existsSync(destPath)) throw new Error(`Destination already exists: ${destPath}`);
	const source = openSource(srcPath);
	let db: Db | undefined;
	try {
		const version = checkSource(source.db, srcPath);
		const report = emptyReport(srcPath, destPath, version, now());
		db = await (options.open ?? openImportDb)(destPath);
		importInto(source.db, db, report, {
			attachmentsDir: options.attachmentsDir ?? join(dirname(srcPath), 'attachments'),
			blobsDir: options.blobsDir ?? join(dirname(destPath), 'blobs'),
			avatarsDir: options.avatarsDir ?? join(dirname(destPath), 'avatars'),
			legacyTables: true
		});
		return report;
	} finally {
		source.close();
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
	L.push('Imported (legacy table: rows written of rows read)');
	for (const [name, t] of Object.entries(r.tables)) {
		L.push(`  ${name.padEnd(24)} ${String(t.imported).padStart(6)} of ${String(t.read).padStart(6)}   dropped columns: ${t.droppedColumns.join(', ') || '-'}`);
	}
	L.push('', 'Written to tables without a legacy twin');
	for (const [name, n] of Object.entries(r.derived)) L.push(`  ${name.padEnd(34)} ${String(n).padStart(6)}`);
	L.push('', 'Not imported');
	for (const t of r.notImported) L.push(`  ${t.table.padEnd(24)} ${String(t.rows).padStart(6)} rows   ${t.note}`);
	if (!r.notImported.length) L.push('  -');
	L.push('', `Stock differences closed by an import adjustment: ${r.stockDifferences.length}`);
	for (const s of r.stockDifferences) {
		L.push(`  ${s.opalNumber} (record ${s.stockId}, part ${s.partId}): old quantity ${s.legacyQuantity / 10000}, movements ${s.ledgerSum / 10000}, adjusted by ${s.difference / 10000}`);
	}
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
export async function importInPlace(dbPath: string, options: Parameters<typeof importLegacy>[2] = {}): Promise<ImportReport | null> {
	if (!existsSync(dbPath) || !hasAlembicVersion(dbPath)) return null;
	const dir = dirname(dbPath);
	const legacyPath = join(dir, 'opal.legacy.db');
	const newPath = `${dbPath}.new`;
	if (existsSync(legacyPath)) {
		throw new Error(`Cannot import: ${legacyPath} already exists. Move it, then start again.`);
	}
	for (const suffix of ['', '-wal', '-shm']) rmSync(newPath + suffix, { force: true });

	const report = await importLegacy(dbPath, newPath, { blobsDir: join(dir, 'blobs'), avatarsDir: join(dir, 'avatars'), ...options });
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
