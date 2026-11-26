/**
 * The content of a fresh demo: the Mojave Sphinx dataset (`demo/mojave-sphinx`, GPL-3.0, adapted
 * from Half Cat Rocketry's HCR-5100 guidebook).
 *
 * `scripts/load-demo.ts` builds the dataset through OPAL's own operations, which takes about a
 * minute, so a demo never loads it on entry. A pack is built once instead: the loaded database with
 * its sessions, instance id and passwords removed, and its stored files in a `demo_pack_file` table.
 * The release build embeds the pack in the binary. A demo starts as a copy of it.
 *
 * The pack is found, in order: `OPAL_DEMO_PACK`, the copy embedded in the binary
 * (`globalThis.__opalEmbedded.demoPack`), and one built from the sources and cached in
 * `server/node_modules/.cache`, keyed by the dataset, the loader and the schema. The cache outlives a
 * test run, whose temp folder does not.
 */
import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, normalize, relative, sep } from 'node:path';

const SERVER = join(import.meta.dir, '../../..');
const DATASET = join(SERVER, '../demo/mojave-sphinx');
const LOADER = join(SERVER, 'scripts/load-demo.ts');

/** The table in a pack that holds the demo's stored files. Dropped from every copy. */
const FILES = 'demo_pack_file';
/** What a loaded data folder holds besides the database that a demo needs. Never key files. */
const FILE_DIRS = ['blobs', 'avatars'];

const files = (root: string): string[] =>
	readdirSync(root, { recursive: true, withFileTypes: true })
		.filter((e) => e.isFile())
		.map((e) => relative(root, join(e.parentPath, e.name)))
		.sort();

/**
 * Build a pack at `out`: load the dataset into a new data folder, strip what belongs to one
 * instance, and store the folder's files inside. Runs the loader as its own process, because it
 * moves the process clock.
 */
export function buildDemoPack(out: string): void {
	const work = mkdtempSync(join(tmpdir(), 'opal-demo-pack-'));
	try {
		const data = join(work, 'data');
		const env: Record<string, string | undefined> = { ...process.env };
		// The pack is a release database: built by migrations, sealed with no key of this machine.
		for (const k of ['OPAL_DATA_DIR', 'OPAL_DB_FILE', 'OPAL_DEV_SCHEMA', 'OPAL_SECRETS_KEY', 'OPAL_DEMO_PASSWORD']) delete env[k];
		const run = Bun.spawnSync([process.execPath, LOADER, data, DATASET], { cwd: SERVER, env, stdout: 'pipe', stderr: 'pipe' });
		if (run.exitCode !== 0) {
			throw new Error(`Building the demo failed: ${run.stderr.toString().trim() || run.stdout.toString().trim()}`);
		}
		const db = new Database(join(data, 'opal.db'), { strict: true });
		try {
			db.run('PRAGMA wal_checkpoint(TRUNCATE)');
			// A demo signs in only its operator, and each copy is its own instance.
			db.run('DELETE FROM session');
			db.run("DELETE FROM app_setting WHERE key = 'instance_id'");
			db.run('UPDATE user SET password_hash = NULL');
			db.run(`CREATE TABLE ${FILES} (path TEXT PRIMARY KEY, data BLOB NOT NULL)`);
			const put = db.query(`INSERT INTO ${FILES} (path, data) VALUES (?, ?)`);
			for (const dir of FILE_DIRS) {
				const root = join(data, dir);
				if (!existsSync(root)) continue;
				for (const f of files(root)) put.run(join(dir, f).split(sep).join('/'), readFileSync(join(root, f)));
			}
			rmSync(`${out}.tmp`, { force: true });
			db.run('VACUUM INTO ?', [`${out}.tmp`]);
		} finally {
			db.close();
		}
		renameSync(`${out}.tmp`, out);
	} finally {
		rmSync(work, { recursive: true, force: true });
	}
}

let key: string | undefined;

/** What shapes the pack. Service code can too, but rebuilding on every source edit costs a minute. */
function sourceKey(): string {
	if (key) return key;
	const h = createHash('sha256');
	const add = (root: string) => {
		for (const f of files(root)) h.update(f).update(readFileSync(join(root, f)));
	};
	add(DATASET);
	add(join(SERVER, 'drizzle'));
	add(join(SERVER, 'src/db/schema'));
	h.update(readFileSync(LOADER));
	key = h.digest('hex').slice(0, 16);
	return key;
}

/** Where the pack is. Builds and caches one when running from the sources. */
export function demoPackPath(): string {
	const embedded = (globalThis as { __opalEmbedded?: { demoPack?: string } }).__opalEmbedded?.demoPack;
	const given = process.env.OPAL_DEMO_PACK ?? embedded;
	if (given) return given;
	const cacheDir = join(SERVER, 'node_modules/.cache');
	const cached = join(cacheDir, `opal-demo-pack-${sourceKey()}.db`);
	if (!existsSync(cached)) {
		mkdirSync(cacheDir, { recursive: true });
		buildDemoPack(cached);
	}
	return cached;
}

/**
 * Write a new demo database at `file` and its stored files under `folder`, the demo's own data
 * folder. Never `dataDir()`: this runs before the switch, when that is still the real folder.
 * `file` must not be open; anything already there is replaced.
 */
export function writeDemo(file: string, folder: string): void {
	const tmp = `${file}.new`;
	mkdirSync(dirname(file), { recursive: true });
	rmSync(tmp, { force: true });
	copyFileSync(demoPackPath(), tmp);
	const db = new Database(tmp, { strict: true });
	try {
		for (const row of db.query(`SELECT path, data FROM ${FILES}`).all() as { path: string; data: Uint8Array }[]) {
			const rel = normalize(row.path);
			// The pack is ours, but OPAL_DEMO_PACK can name any file: nothing lands outside the folder.
			if (isAbsolute(rel) || rel.startsWith('..') || !FILE_DIRS.includes(rel.split(sep)[0]!)) continue;
			const dest = join(folder, rel);
			mkdirSync(join(dest, '..'), { recursive: true, mode: 0o700 });
			writeFileSync(dest, row.data, { mode: 0o600 });
		}
		db.run(`DROP TABLE ${FILES}`);
		db.run('VACUUM');
	} finally {
		db.close();
	}
	for (const suffix of ['-wal', '-shm']) rmSync(`${file}${suffix}`, { force: true });
	renameSync(tmp, file);
}
