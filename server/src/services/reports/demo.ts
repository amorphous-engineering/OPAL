/**
 * The content of a fresh demo database.
 *
 * The demo is the legacy seeded database (`server/assets/demo-seed.db`, the Mojave Sphinx
 * rocket project at Alembic head b8d2f1a5c3e0), loaded with the same importer as a real
 * upgrade. A new demo database is empty (schema only) when this runs.
 *
 * Contract: `db` is a new, empty database with the current schema. The function fills it
 * synchronously, does not close it, and creates no user for the operator (the lifecycle code
 * matches the operator by email, then by name).
 *
 * The seed file is found, in order: `OPAL_DEMO_SEED`, the copy embedded in the binary
 * (`globalThis.__opalEmbedded.demoSeed`), and `server/assets/demo-seed.db` next to the sources.
 */
import { Database } from 'bun:sqlite';
import { now } from '@opal/shared';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Db } from '../../db/client.ts';
import { checkSource, importInto } from '../../import/legacy.ts';
import { emptyReport } from '../../import/context.ts';
import { dataDir } from '../../paths.ts';

/** Where the seed file is. */
export function demoSeedPath(): string {
	const embedded = (globalThis as { __opalEmbedded?: { demoSeed?: string } }).__opalEmbedded?.demoSeed;
	return process.env.OPAL_DEMO_SEED ?? embedded ?? join(import.meta.dir, '../../../assets/demo-seed.db');
}

export function buildDemoContent(db: Db): void {
	const seed = Database.deserialize(readFileSync(demoSeedPath()));
	try {
		const version = checkSource(seed, 'demo seed');
		const report = emptyReport('demo seed', 'demo database', version, now());
		importInto(seed, db, report, {
			attachmentsDir: join(dataDir(), 'attachments'),
			blobsDir: join(dataDir(), 'blobs'),
			avatarsDir: join(dataDir(), 'avatars'),
			// Until the two import-only tables are in the schema index, a demo goes without them.
			legacyTables: !!db.$client.query("SELECT 1 FROM sqlite_master WHERE name = 'legacy_audit'").get()
		});
		if (report.failedRows.length) console.warn(`Demo content: ${report.failedRows.length} rows failed`, report.failedRows.slice(0, 5));
	} finally {
		seed.close();
	}
}
