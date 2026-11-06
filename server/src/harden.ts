/**
 * Owner-only data folder. The database holds password hashes, session and API token hashes and
 * the OIDC client secret, so other local accounts must not read it.
 *
 * `hardenDataDir` runs first in `serve` and `supervise`, before anything is created: it sets the
 * umask (every file the server, an import or a plugin child writes afterwards is `0600`, every
 * folder `0700`), creates the data folder `0700` and tightens what an older run left behind.
 * Windows has no meaningful modes, so it does nothing there. A failure warns and carries on.
 */
import { chmodSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { dataDir, dbPath } from './paths.ts';

/** Remove group and other bits from one path. Quiet when it is not there or not ours. */
function restrict(path: string, warn: string[]): void {
	try {
		const mode = statSync(path).mode & 0o7777;
		if (mode & 0o077) chmodSync(path, mode & ~0o077);
	} catch (e) {
		if ((e as { code?: string }).code !== 'ENOENT') warn.push(`${path}: ${(e as Error).message}`);
	}
}

export function hardenDataDir(): void {
	if (process.platform === 'win32') return;
	process.umask(0o077);
	const warn: string[] = [];
	const dir = dataDir();
	try {
		mkdirSync(dir, { recursive: true, mode: 0o700 });
	} catch (e) {
		warn.push(`${dir}: ${(e as Error).message}`);
	}
	restrict(dir, warn);
	// Everything below is reached only through the folder, so its top level is enough. The database
	// may sit elsewhere (OPAL_DB_FILE), with its WAL and shared-memory files beside it.
	try {
		for (const name of readdirSync(dir)) restrict(join(dir, name), warn);
	} catch (e) {
		warn.push(`${dir}: ${(e as Error).message}`);
	}
	const db = dbPath();
	if (dirname(db) !== dir && existsSync(db)) for (const f of [db, `${db}-wal`, `${db}-shm`]) restrict(f, warn);
	if (warn.length) console.warn(`Could not restrict permissions on the data folder: ${warn.join('; ')}`);
}
