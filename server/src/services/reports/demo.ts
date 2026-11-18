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
 * `folder` is the demo's own data folder, the one `OPAL_DATA_DIR` names once the demo is live.
 * Blobs and avatars go there, and attachment files are read from its `attachments/`. Never
 * `dataDir()`: this runs before the switch, when that is still the real folder, and a folder
 * upgraded from 1.x keeps the real organization's files in its `attachments/`.
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
import { storeNumbersAtFullWidth } from '../../db/full-width-numbers.ts';
import { renameCheckboxFields } from '../../db/boolean-fields.ts';

/** Where the seed file is. */
export function demoSeedPath(): string {
	const embedded = (globalThis as { __opalEmbedded?: { demoSeed?: string } }).__opalEmbedded?.demoSeed;
	return process.env.OPAL_DEMO_SEED ?? embedded ?? join(import.meta.dir, '../../../assets/demo-seed.db');
}

export function buildDemoContent(db: Db, folder: string): void {
	const seed = Database.deserialize(readFileSync(demoSeedPath()));
	try {
		const version = checkSource(seed, 'demo seed');
		const report = emptyReport('demo seed', 'demo database', version, now());
		importInto(seed, db, report, {
			attachmentsDir: join(folder, 'attachments'),
			blobsDir: join(folder, 'blobs'),
			avatarsDir: join(folder, 'avatars'),
			// Until the two import-only tables are in the schema index, a demo goes without them.
			legacyTables: !!db.$client.query("SELECT 1 FROM sqlite_master WHERE name = 'legacy_audit'").get()
		});
		if (report.failedRows.length) console.warn(`Demo content: ${report.failedRows.length} rows failed`, report.failedRows.slice(0, 5));
		// The imported numbers are at their 1.x width. The demo is switched in without createApp.
		storeNumbersAtFullWidth(db, true);
		renameCheckboxFields(db, true);
	} finally {
		seed.close();
	}
}
