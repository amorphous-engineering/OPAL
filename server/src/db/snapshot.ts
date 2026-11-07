/**
 * A copy of the database before migrations change it. A migration is the one write nobody can
 * undo from inside the app, and the copy costs seconds, so an upgrade that goes wrong can be
 * walked back by hand. The newest few are kept next to the database.
 */
import type { Database } from 'bun:sqlite';
import { now } from '@opal/shared';
import { chmodSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';

const KEEP = 3;
const MARK = '.pre-migration-';

const stemOf = (path: string) => basename(path, extname(path)) + MARK;

export function snapshotPaths(path: string): string[] {
	const stem = stemOf(path);
	return readdirSync(dirname(path))
		.filter((f) => f.startsWith(stem) && f.endsWith('.db'))
		.sort()
		.map((f) => join(dirname(path), f));
}

/** A copy still being written, or left by a process killed while writing one. Never counted as a copy. */
const UNFINISHED = '.tmp';

function removeUnfinished(path: string): void {
	const stem = stemOf(path);
	for (const f of readdirSync(dirname(path))) {
		if (f.startsWith(stem) && f.endsWith(UNFINISHED)) rmSync(join(dirname(path), f), { force: true });
	}
}

/**
 * Copies the database and returns the copy's path. Throws, with nothing changed, when it cannot. It
 * gets its real name only when complete, so a kill partway cannot push out a good copy or pass for one.
 */
export function snapshotBeforeMigrating(sqlite: Database, path: string): string {
	// Colons are not allowed in Windows file names. The stamp sorts by time.
	const dest = join(dirname(path), `${stemOf(path)}${now().replace(/:/g, '-')}.db`);
	const unfinished = dest + UNFINISHED;
	try {
		removeUnfinished(path);
		sqlite.run('VACUUM INTO ?', [unfinished]);
		// Same people as the database itself: it holds the same password hashes.
		chmodSync(unfinished, 0o600);
		renameSync(unfinished, dest);
	} catch (e) {
		// A half-written copy must not pass for a good one. Its own failure must not hide the cause.
		try {
			rmSync(unfinished, { force: true });
		} catch {
			/* the folder itself may be what is wrong */
		}
		throw new Error(
			`Could not copy the database before upgrading it, so it was left as it was: ${(e as Error).message}. Check the free disk space in ${dirname(path)}, then start again.`
		);
	}
	for (const old of snapshotPaths(path).slice(0, -KEEP)) rmSync(old, { force: true });
	return dest;
}

/** A factory reset erases the organization, and these hold its data too. */
export function removeSnapshots(path: string): void {
	removeUnfinished(path);
	for (const old of snapshotPaths(path)) rmSync(old, { force: true });
}
