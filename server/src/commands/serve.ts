import { mkdirSync } from 'node:fs';
import { openingKeys } from '../auth/sealed.ts';
import { createApp } from '../app.ts';
import { openDb, type Db } from '../db/client.ts';
import { loadDevSchema } from '../db/dev.ts';
import { scrubDatabase, scrubPending, sweepCopies } from '../db/seal-secrets.ts';
import { importInPlace } from '../import/index.ts';
import { dataDir, dbPath } from '../paths.ts';
import { PluginHost } from '../services/plugins/host.ts';
import { pluginsEnabled, setRuntime } from '../services/plugins/runtime.ts';
import { plugin, user } from '../db/schema/index.ts';
import { armSetupCode } from '../services/auth/setup-code.ts';
import { eq } from 'drizzle-orm';
import { idleTimeoutSeconds, maxRequestBytes } from '../http/limits.ts';
import { hardenDataDir } from '../harden.ts';
import { serialized } from '../registry.ts';
import { versionHoldsBlob } from '../services/procedures/versions.ts';
import { startBlobSweeper } from '../services/platform/attachments.ts';
import { flag } from './args.ts';

/** Longer than the supervisor's health poll by a wide margin. */
const SCRUB_DELAY_MS = 2000;

export async function serve(args: string[]): Promise<void> {
	// Before the folder or any file in it is created.
	hardenDataDir();
	mkdirSync(dataDir(), { recursive: true });
	// A bad key stops here, in words for the person starting OPAL, not at the first saved secret.
	try {
		openingKeys();
	} catch (e) {
		console.error((e as Error).message);
		process.exit(1);
	}
	// A Python-era database is imported once; the old file is kept as opal.legacy.db.
	let report: Awaited<ReturnType<typeof importInPlace>>;
	try {
		report = await importInPlace(dbPath());
	} catch (e) {
		// These messages are written for the person starting OPAL. A stack trace would bury them.
		console.error((e as Error).message);
		process.exit(1);
	}
	if (report) console.log('Imported the legacy database. See import-report.txt next to it.');
	// OPAL_DEV_SCHEMA=1: build a fresh dev database from schema.ts instead of migrations.
	const devSchema = process.env.OPAL_DEV_SCHEMA === '1';
	let db: Db;
	try {
		// Right after an import, opal.legacy.db is the way back, and a copy would only add one more file with plaintext secrets.
		db = devSchema ? await (await loadDevSchema()).openSchemaDb(dbPath()) : openDb(dbPath(), undefined, report ? () => null : undefined, { scrubLater: true });
	} catch (e) {
		console.error((e as Error).message);
		process.exit(1);
	}
	sweepCopies(dbPath());
	const app = createApp({ db, web: true });
	startBlobSweeper(db, serialized, [versionHoldsBlob(db)]);
	const port = Number(flag(args, 'port') ?? process.env.OPAL_PORT ?? 8080);
	const hostname = flag(args, 'host') ?? process.env.OPAL_HOST ?? '0.0.0.0';
	// Settings > System reports the address this process listens on, flags included.
	process.env.OPAL_PORT = String(port);
	process.env.OPAL_HOST = hostname;
	// Bun's own limits, for what the app never sees. JSON bodies get a lower limit in createApp.
	// A connection silent for the idle timeout is closed, so half-sent requests do not pile up.
	// The event stream sends a heartbeat every 5 s, which keeps it open.
	Bun.serve({
		port,
		hostname,
		idleTimeout: idleTimeoutSeconds(),
		maxRequestBodySize: maxRequestBytes(),
		// The socket address, for session records when no proxy sets x-forwarded-for.
		fetch: (req, server) => app.fetch(req, { ip: server.requestIP(req)?.address ?? null, keepOpen: () => server.timeout(req, 0) })
	});
	if (pluginsEnabled()) {
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
	// The compacting that follows the first sealing blocks the server, and on a large file that takes a
	// while. A supervisor gives a new binary a short time to answer, and during a self-update it puts the
	// old binary back if that runs out, which cannot read sealed values. That supervisor is the old
	// version, so nothing new can be asked of it: this waits until it has had its answer.
	if (!devSchema && scrubPending(db.$client)) setTimeout(() => void serialized(async () => scrubDatabase(db.$client)), SCRUB_DELAY_MS);
	const unclaimed = db.select({ id: user.id }).from(user).limit(1).get() === undefined;
	armSetupCode(unclaimed, `http://${hostname === '0.0.0.0' || hostname === '::' ? 'localhost' : hostname}:${port}`);
}
