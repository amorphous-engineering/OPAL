import { afterAll } from 'bun:test';
import { mkdirSync, readdirSync, rmSync, statfsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Many tests write a secret without choosing a data folder. A pinned key keeps them from making a key
 * file in the real one, where a live database may be.
 */
process.env.OPAL_SECRETS_KEY ??= 'test-only-secrets-key-0123456789abcdef';

/**
 * Temp folders go in RAM when there is room. Tests with a database file spend nearly all their time
 * waiting for the disk to confirm each commit, and no test needs its commits to survive a power cut.
 * TMPDIR, when set, wins. A folder per run, because a killed run cannot clean up and this memory stays
 * taken until something does: each run removes the ones whose process is gone.
 */
const RAM = '/dev/shm';
const PREFIX = 'opal-test-';
const MIN_FREE_BYTES = 1024 ** 3;

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (e) {
		return (e as { code?: string }).code === 'EPERM';
	}
}

function hasRoom(dir: string): boolean {
	try {
		const { bavail, bsize } = statfsSync(dir);
		return bavail * bsize >= MIN_FREE_BYTES;
	} catch {
		return false;
	}
}

if (!process.env.TMPDIR && hasRoom(RAM)) {
	for (const name of readdirSync(RAM)) {
		const pid = Number(name.slice(PREFIX.length));
		if (name.startsWith(PREFIX) && !alive(pid)) rmSync(join(RAM, name), { recursive: true, force: true });
	}
	const mine = join(RAM, `${PREFIX}${process.pid}`);
	mkdirSync(mine, { recursive: true, mode: 0o700 });
	process.env.TMPDIR = mine;
	afterAll(() => rmSync(mine, { recursive: true, force: true }));
}
