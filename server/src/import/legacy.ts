/**
 * One-time, forward-only import from a Python-era OPAL database into the new schema. Every
 * legacy table is moved or listed as skipped.
 *
 * The importer reads one schema, Alembic head b8d2f1a5c3e0. A database from a 1.x release is
 * first brought forward to that schema (bridge.ts), on the same private copy.
 *
 * The import writes rows directly in one transaction: it is a migration, not a user action.
 * It records one audit row per table. The source file is never opened; a private copy is read.
 */
import { Database } from 'bun:sqlite';
import { now } from '@opal/shared';
import { copyFileSync, existsSync, mkdtempSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import type { Db } from '../db/client.ts';
import { auditLog } from '../db/schema/index.ts';
import { noSignInPeople } from '../services/auth/claim.ts';
import { importAttachments } from './attachments.ts';
import { bridgeToHead, canBridge, LEGACY_HEAD, RELEASED_HEADS } from './bridge.ts';
import {
	type ImportCtx,
	type ImportOptions,
	type ImportReport,
	type ResolvedOptions,
	type Row,
	type SourceTableLine,
	emptyReport,
	fail,
	tableExists
} from './context.ts';
import { importExecutions } from './execution.ts';
import { importAudit, importDesignators, setSequences } from './finish.ts';
import { importInventory } from './inventory.ts';
import { openImportDb } from './open.ts';
import { importPeople, importProject, importRoles, importSettings, NO_ONSHAPE } from './org.ts';
import { importParts, importPurchasing, importSuppliers } from './parts.ts';
import { importProcedures } from './procedures.ts';
import { addProjectFile } from './project-file.ts';
import { importDatasets, importIssues, importNotifications, importRequirements, importRisks } from './tracking.ts';

export { legacyQty, legacyTimestamp } from './context.ts';
export type { ImportCtx, ImportOptions, ImportReport, TableReport } from './context.ts';
export { openSchemaImportDb } from './open.ts';
export { LEGACY_HEAD, RELEASED_HEADS } from './bridge.ts';

export const OLD_VERSION_MESSAGE =
	'This version imports databases from OPAL 1.2.2 through 1.4.0-beta.3, and this one is from none of them. The file was not changed. If it is from an older 1.x, open it once with OPAL 1.3.2, then start this version again. To use this version without it, set OPAL_DATA_DIR to an empty folder.';

/** Tables that are not imported, with the reason. Row counts are read from the source. */
const SKIPPED: Record<string, string> = {
	extension: 'extensions do not carry over to OPAL 2',
	onshape_link: NO_ONSHAPE,
	onshape_sync_log: NO_ONSHAPE,
	webauthn_challenge: 'short-lived sign-in state (rows live 5 minutes)',
	auth_session: 'sessions end at the import; people sign in again'
};

function tableNames(src: Database): string[] {
	return (src.query("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as Row[])
		.map((r) => String(r.name))
		.filter((n) => !n.startsWith('sqlite_') && n !== 'alembic_version');
}

/** Rows in a table. A 1.x search index can fail to answer this, and its _docsize table still knows. */
function countRows(src: Database, table: string): number {
	const count = (t: string) => (src.query(`SELECT COUNT(*) AS n FROM "${t}"`).get() as { n: number }).n;
	try {
		return count(table);
	} catch {
		return tableExists(src, `${table}_docsize`) ? count(`${table}_docsize`) : 0;
	}
}

const FTS_INTERNAL = /_fts_(data|idx|docsize|config|content)$/;

/** Every table of a source file and its rows, before anything has touched it. */
function sourceRows(src: Database): Map<string, number> {
	return new Map(tableNames(src).map((t) => [t, countRows(src, t)]));
}

/**
 * What became of every table of the source file. A table is imported, listed as not imported,
 * or part of a search index. Whatever else is read must have been written, failed or left out.
 */
function accountFor(report: ImportReport, source: Map<string, number>): SourceTableLine[] {
	const failed = new Map<string, number>();
	for (const f of report.failedRows) failed.set(f.table, (failed.get(f.table) ?? 0) + 1);
	return [...source].map(([table, rows]) => {
		const t = report.tables[table];
		if (t) {
			const bad = failed.get(table) ?? 0;
			const leftOut = t.leftOut ?? 0;
			// Writes the import adds on its own (number counters) are more than it read, not fewer.
			const unaccounted = Math.max(0, t.read - t.imported - bad - leftOut);
			const parts = [`imported ${t.imported} of ${t.read} read`];
			if (t.read !== rows) parts.push(`${rows} in the file, ${table === 'app_setting' && report.projectFile ? 'the project file and the bridge' : 'the bridge'} changed the count`);
			if (bad) parts.push(`${bad} failed`);
			if (leftOut) parts.push(`${leftOut} left out, listed under Not imported`);
			if (unaccounted) parts.push(`${unaccounted} skipped, see Warnings`);
			return { table, rows, outcome: parts.join(', '), unaccounted };
		}
		const skipped = report.notImported.find((n) => n.table === table);
		if (skipped) return { table, rows, outcome: `not imported: ${skipped.note}`, unaccounted: 0 };
		if (FTS_INTERNAL.test(table)) return { table, rows, outcome: 'internal to a search index, rebuilt by the server', unaccounted: 0 };
		return { table, rows, outcome: 'no importer', unaccounted: rows };
	});
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
	if (typeof version !== 'string' || !(version === LEGACY_HEAD || canBridge(version))) {
		throw new Error(`Alembic revision ${String(version ?? 'none')}. ${OLD_VERSION_MESSAGE}`);
	}
	return version;
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
		// Listed even when the table is absent, so a reader of any report sees these do not move.
		for (const [t, note] of Object.entries(SKIPPED)) {
			const there = tableExists(src, t);
			c.report.notImported.push({ table: t, rows: there ? countRows(src, t) : 0, note: there ? note : `${note} (no such table in this database)` });
		}
		for (const t of tableNames(src).filter((n) => n.endsWith('_fts'))) {
			c.report.notImported.push({ table: t, rows: countRows(src, t), note: 'search index, rebuilt by the server' });
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
		const before = sourceRows(source.db);
		if (version !== LEGACY_HEAD) report.bridge = bridgeToHead(source.db, version);
		addProjectFile(source.db, srcPath, options.projectFile, report);
		db = await (options.open ?? openImportDb)(destPath);
		importInto(source.db, db, report, {
			attachmentsDir: options.attachmentsDir ?? join(dirname(srcPath), 'attachments'),
			blobsDir: options.blobsDir ?? join(dirname(destPath), 'blobs'),
			avatarsDir: options.avatarsDir ?? join(dirname(destPath), 'avatars'),
			legacyTables: true
		});
		noteExtensionsFolder(dirname(srcPath), report);
		report.sourceTables = accountFor(report, before);
		report.noSignIn = noSignInPeople(db, report);
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

/** Files that extensions installed live next to the database, not in it. */
function noteExtensionsFolder(dir: string, report: ImportReport): void {
	const folder = join(dir, 'extensions');
	if (!existsSync(folder)) return;
	const files = readdirSync(folder);
	if (files.length) report.notImported.push({ table: 'extensions folder', rows: files.length, note: `extensions do not carry over to OPAL 2; the files stay in ${folder}` });
}

export function renderReport(r: ImportReport): string {
	const L: string[] = [];
	const release = RELEASED_HEADS[r.alembicVersion];
	L.push(`OPAL legacy import, ${r.at}`, `Source: ${r.source}`, `Result: ${r.dest}`, `Alembic: ${r.alembicVersion}${release ? ` (OPAL ${release})` : ''}`, '');
	if (r.bridge) {
		L.push(`Brought forward to ${r.bridge.to} on a private copy, ${r.bridge.steps.length} steps. The source file was not changed.`);
		for (const s of r.bridge.steps.filter((x) => x.changes.length)) {
			L.push(`  ${s.revision} ${s.title}${s.pastStamp ? ', which the file was stamped past but did not have' : ''}`);
			for (const change of s.changes) L.push(`    ${change}`);
		}
		L.push(`  Tables that did not exist in the source: ${r.bridge.createdTables.join(', ') || '-'}`);
		for (const c of r.bridge.retiredColumns) L.push(`  Column ${c.table}.${c.column}, ${c.rows} rows with a value: ${c.why}`);
		L.push('');
	}
	if (r.sourceTables.length) {
		L.push('Every table in the source file (rows as it was)');
		const internal = r.sourceTables.filter((t) => t.outcome.startsWith('internal'));
		for (const t of r.sourceTables.filter((x) => !x.outcome.startsWith('internal'))) {
			L.push(`  ${t.table.padEnd(24)} ${String(t.rows).padStart(6)}   ${t.outcome}`);
		}
		if (internal.length) L.push(`  ${internal.length} tables internal to the search indexes, ${internal.reduce((n, t) => n + t.rows, 0)} rows: rebuilt by the server`);
		L.push(`  Rows not accounted for: ${r.sourceTables.reduce((n, t) => n + t.unaccounted, 0)}`, '');
	}
	if (r.projectFile) L.push(`Project configuration read from ${r.projectFile}`, '');
	L.push(`People who cannot sign in until they set a password: ${r.noSignIn.length}`);
	for (const p of r.noSignIn) L.push(`  ${p.id}  ${p.username}${p.isAdmin ? '  (administrator)' : ''}`);
	if (r.noSignIn.length) L.push('  Starting OPAL prints a link for the administrator. An administrator makes links for the others under Users.');
	L.push('');
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
	L.push('', `Receipts with no stock record, held at "Legacy receipt (no stock record)" and adjusted out: ${r.receiptGaps.length}`);
	for (const g of r.receiptGaps) L.push(`  ${g.reference} line ${g.purchaseLineId}  ${g.partNumber}  received ${g.quantity / 10000}  (${g.opalNumber})`);
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

	let report: ImportReport;
	try {
		report = await importLegacy(dbPath, newPath, { blobsDir: join(dir, 'blobs'), avatarsDir: join(dir, 'avatars'), ...options });
	} catch (e) {
		// A half-made result is no use to anyone, and the next start would only delete it.
		for (const suffix of ['', '-wal', '-shm']) rmSync(newPath + suffix, { force: true });
		throw e;
	}
	if (existsSync(`${newPath}-wal`)) throw new Error(`Import left ${newPath}-wal behind; not renaming.`);

	renameSync(dbPath, legacyPath);
	for (const suffix of ['-wal', '-shm']) {
		if (existsSync(dbPath + suffix)) renameSync(dbPath + suffix, legacyPath + suffix);
	}
	renameSync(newPath, join(dir, basename(dbPath)));
	for (const suffix of ['-wal', '-shm']) rmSync(newPath + suffix, { force: true });
	report.source = legacyPath;
	report.dest = dbPath;

	writeReports(report, dir);
	return report;
}

export function writeReports(report: ImportReport, dir: string): void {
	writeFileSync(join(dir, 'import-report.txt'), renderReport(report));
	writeFileSync(join(dir, 'import-report.json'), `${JSON.stringify(report, null, 2)}\n`);
}

/** The one line a person starting OPAL needs. */
export function reportSummary(report: ImportReport, dir: string): string {
	const release = RELEASED_HEADS[report.alembicVersion];
	const problems = `${report.failedRows.length} failed rows, ${report.warnings.length} warnings`;
	const summary = `Imported the ${release ? `OPAL ${release}` : 'legacy'} database: ${problems}. See ${join(dir, 'import-report.txt')}.`;
	if (!report.onshapeKeys.length) return summary;
	return `${summary}\nWarning: Onshape does not carry over to OPAL 2. These keys were not imported: ${report.onshapeKeys.join(', ')}. They are still in plaintext in ${report.source}. Revoke them in Onshape if you no longer need them.`;
}
