/**
 * Owner-only data. The database holds password hashes, session and API token hashes and the OIDC client
 * secret, so other local accounts must not read it.
 *
 * `hardenDataDir` runs first in `serve` and `import`, before anything is created: it sets the umask (every
 * file written afterwards is `0600`, every folder `0700`), creates a missing data folder `0700` and
 * tightens the things OPAL itself keeps there. A folder that already exists stays as it is, and so does
 * anything else in it: the folder may be shared, and another program's files are not ours to change. A
 * symlink is not followed. Windows has no meaningful modes, so it does nothing there. A failure warns and
 * carries on.
 *
 * The supervisor skips the umask: it writes nothing in the data folder, and an update it installs must
 * keep the mode of the binary it replaces. The server it starts sets its own.
 */
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { dataDir, dbPath } from './paths.ts';

/** Remove group and other bits from one path. Quiet when it is not there or not ours. */
function restrict(path: string, warn: string[]): void {
	try {
		const stat = lstatSync(path);
		if (stat.isSymbolicLink()) return;
		const mode = stat.mode & 0o7777;
		if (mode & 0o077) chmodSync(path, mode & ~0o077);
	} catch (e) {
		if ((e as { code?: string }).code !== 'ENOENT') warn.push(`${path}: ${(e as Error).message}`);
	}
}

/** What OPAL keeps in its data folder: the database and its copies, reports, files, the auth secret. */
const OURS = /^(opal\.|demo\.|import-report\.|\.opal_auth_secret$|blobs$|avatars$|plugins$|plugin-data$)/;

export function hardenDataDir(opts: { umask?: boolean } = {}): void {
	if (process.platform === 'win32') return;
	if (opts.umask !== false) process.umask(0o077);
	const warn: string[] = [];
	const dir = dataDir();
	try {
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true, mode: 0o700 });
			chmodSync(dir, 0o700);
		}
	} catch (e) {
		warn.push(`${dir}: ${(e as Error).message}`);
	}
	try {
		for (const name of readdirSync(dir)) if (OURS.test(name)) restrict(join(dir, name), warn);
	} catch (e) {
		warn.push(`${dir}: ${(e as Error).message}`);
	}
	const db = dbPath();
	if (dirname(db) !== dir && existsSync(db)) for (const f of [db, `${db}-wal`, `${db}-shm`]) restrict(f, warn);
	if (warn.length) console.warn(`Could not restrict permissions on the data folder: ${warn.join('; ')}`);
}
