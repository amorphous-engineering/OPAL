/**
 * Server health for the status bar, the supervisor and outside monitors.
 *
 * The checks are cheap enough to run every few seconds: no table scans, no write locks.
 * The route is public, so a detail never names a file path.
 */
import type { Health } from '@opal/shared';
import { accessSync, constants, mkdirSync, statfsSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import type { Db } from '../../db/client.ts';
import { dataDir } from '../../paths.ts';
import { VERSION } from '../../version.ts';
import { blobDir } from './attachments.ts';

/** Below this, uploads and the WAL can fail soon. */
export const MIN_FREE_BYTES = 1024 ** 3;

type Check = Health['checks'][number];

const message = (e: unknown) => (e as { code?: string })?.code ?? (e as Error)?.message ?? 'failed';

function database(db: Db): Check {
	try {
		db.get(sql`select count(*) from sqlite_master`);
		// '' for an in-memory database, which is always writable.
		const file = db.all<{ name: string; file: string }>(sql`pragma database_list`).find((d) => d.name === 'main')?.file;
		if (file) accessSync(file, constants.W_OK);
		return { name: 'database', ok: true, detail: null };
	} catch (e) {
		return { name: 'database', ok: false, detail: message(e) };
	}
}

function storage(): Check {
	try {
		mkdirSync(blobDir(), { recursive: true });
		accessSync(blobDir(), constants.W_OK);
		return { name: 'storage', ok: true, detail: null };
	} catch (e) {
		return { name: 'storage', ok: false, detail: message(e) };
	}
}

function disk(minFree: number): Check {
	try {
		const s = statfsSync(dataDir());
		const free = s.bavail * s.bsize;
		const gib = (free / 1024 ** 3).toFixed(1);
		return { name: 'disk', ok: free >= minFree, detail: `${gib} GiB free` };
	} catch (e) {
		return { name: 'disk', ok: false, detail: message(e) };
	}
}

export function health(db: Db, minFree = MIN_FREE_BYTES): Health {
	const checks = [database(db), storage(), disk(minFree)];
	const status = !checks[0]!.ok ? 'down' : checks.every((c) => c.ok) ? 'ok' : 'degraded';
	return { status, version: VERSION, checks };
}
