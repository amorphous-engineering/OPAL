import { mkdirSync } from 'node:fs';
import { createApp } from '../app.ts';
import { openDb } from '../db/client.ts';
import { importInPlace } from '../import/index.ts';
import { dataDir, dbPath } from '../paths.ts';
import { flag } from './args.ts';

export function serve(args: string[]): void {
	mkdirSync(dataDir(), { recursive: true });
	// A Python-era database is imported once; the old file is kept as opal.legacy.db.
	const report = importInPlace(dbPath());
	if (report) console.log('Imported the legacy database. See import-report.txt next to it.');
	const db = openDb(dbPath());
	const app = createApp({ db, web: true });
	const port = Number(flag(args, 'port') ?? process.env.OPAL_PORT ?? 8080);
	const hostname = flag(args, 'host') ?? process.env.OPAL_HOST ?? '0.0.0.0';
	Bun.serve({ port, hostname, fetch: app.fetch });
	console.log(`OPAL listening on http://${hostname}:${port} (data: ${dataDir()})`);
}
