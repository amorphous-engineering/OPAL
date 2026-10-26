import { mkdirSync } from 'node:fs';
import { createApp } from '../app.ts';
import { openDb } from '../db/client.ts';
import { loadDevSchema } from '../db/dev.ts';
import { importInPlace } from '../import/index.ts';
import { dataDir, dbPath } from '../paths.ts';
import { PluginHost } from '../services/plugins/host.ts';
import { setRuntime } from '../services/plugins/runtime.ts';
import { plugin } from '../db/schema/index.ts';
import { eq } from 'drizzle-orm';
import { flag } from './args.ts';

export async function serve(args: string[]): Promise<void> {
	mkdirSync(dataDir(), { recursive: true });
	// A Python-era database is imported once; the old file is kept as opal.legacy.db.
	const report = await importInPlace(dbPath());
	if (report) console.log('Imported the legacy database. See import-report.txt next to it.');
	// OPAL_DEV_SCHEMA=1: build a fresh dev database from schema.ts instead of migrations.
	const db = process.env.OPAL_DEV_SCHEMA === '1' ? await (await loadDevSchema()).openSchemaDb(dbPath()) : openDb(dbPath());
	const app = createApp({ db, web: true });
	const port = Number(flag(args, 'port') ?? process.env.OPAL_PORT ?? 8080);
	const hostname = flag(args, 'host') ?? process.env.OPAL_HOST ?? '0.0.0.0';
	// Settings > System reports the address this process listens on, flags included.
	process.env.OPAL_PORT = String(port);
	process.env.OPAL_HOST = hostname;
	// The event stream stays open; Bun's default 10 s idle limit would cut it.
	Bun.serve({
		port,
		hostname,
		idleTimeout: 0,
		// The socket address, for session records when no proxy sets x-forwarded-for.
		fetch: (req, server) => app.fetch(req, { ip: server.requestIP(req)?.address ?? null })
	});
	if (process.env.OPAL_PLUGINS !== '0') {
		const host = new PluginHost(db);
		setRuntime(host);
		for (const row of db.select({ key: plugin.key }).from(plugin).where(eq(plugin.enabled, true)).all()) void host.start(row.key);
		let quitting = false;
		for (const sig of ['SIGINT', 'SIGTERM'] as const) {
			process.on(sig, () => {
				if (quitting) return;
				quitting = true;
				void host.stopAll().finally(() => process.exit(0));
			});
		}
	}
	console.log(`OPAL listening on http://${hostname}:${port} (data: ${dataDir()})`);
}
