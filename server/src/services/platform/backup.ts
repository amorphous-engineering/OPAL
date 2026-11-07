/**
 * `opal backup` and `opal restore`. A backup is one folder that a second process writes while OPAL
 * keeps running, and that restores to a working instance on its own.
 *
 * What a restored instance needs from the data folder:
 *   opal.db          a consistent copy, made with VACUUM INTO on a read-only connection. In WAL mode
 *                    this holds a read transaction, which does not block OPAL's writers. Nothing else
 *                    here touches the database, so the rest of the backup costs the server only disk.
 *   blobs/           every file the copy has a `blob` row for
 *   avatars/         every file a profile in the copy names
 *   .opal_*          key files: the auth secret today, and the key that opens stored secrets. They match
 *                    by pattern so a key file added later is carried without a change here.
 *   plugins/         installed plugin code, which a restored instance runs from the same place
 *   plugin-data/     state a plugin keeps. Plugins write it on their own schedule, so unlike the
 *                    database this copy is not from one moment.
 *
 * Left out, because nothing reads them once OPAL runs: the demo database and its files, the
 * pre-migration copies, opal.legacy.db and the import reports.
 *
 * The folder is named `opal-backup-<time>` only once it is complete. Until then it is `<name>.partial`
 * and holds no manifest, so a crash at any point leaves something that neither `--keep` nor `restore`
 * takes for a finished backup.
 */
import { Database } from 'bun:sqlite';
import { now } from '@opal/shared';
import { createHash } from 'node:crypto';
import {
	chmodSync,
	closeSync,
	copyFileSync,
	existsSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	readSync,
	renameSync,
	rmSync,
	statSync,
	unlinkSync,
	writeFileSync,
	writeSync
} from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { lastApplied, migrationFiles } from '../../db/client.ts';
import { hardenDataDir } from '../../harden.ts';
import { dataDir, dbPath } from '../../paths.ts';
import { VERSION } from '../../version.ts';
import { avatarDir } from '../org/avatars.ts';
import { pluginDataRoot, pluginsRoot } from '../plugins/store.ts';
import { blobDir } from './attachments.ts';

const FORMAT = 'opal-backup';
const FORMAT_VERSION = 1;
const MANIFEST = 'manifest.json';
const DB_FILE = 'opal.db';

/** `opal-backup-2026-11-06T21-39-20-123Z`. Windows file names cannot hold colons. The name sorts by time. */
const FINISHED_NAME = /^opal-backup-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/;
const OURS_NAME = /^opal-backup-/;
const HASH = /^[0-9a-f]{64}$/;
const KEY_FILE = /^\.opal_[a-z_]+$/;
/** Anything else in a manifest did not come from `opal backup`, and restore must not write it. */
const MANIFEST_PATH = /^(opal\.db|(blobs|avatars)\/[0-9a-f]{64}|\.opal_[a-z_]+|(plugins|plugin-data)\/[^\\:]+)$/;
const isSafePath = (p: string) => MANIFEST_PATH.test(p) && !p.split('/').some((s) => s === '..' || s === '.' || s === '');

/** Present in the data folder from the first file a restore writes until the database is in place. */
export const RESTORE_MARKER = '.opal-restore-unfinished';

/**
 * A file can vanish after the copy was taken: a replaced avatar goes at once, an unreferenced blob when the
 * sweeper reaches it. A fresh copy of the database no longer names it, so try again before giving up.
 */
const SNAPSHOT_ATTEMPTS = 3;

export interface Counts {
	databaseBytes: number;
	attachments: number;
	avatars: number;
	keyFiles: number;
	pluginFiles: number;
}

interface Manifest {
	format: typeof FORMAT;
	formatVersion: number;
	createdAt: string;
	opalVersion: string;
	counts: Counts;
	/** Every file in the backup, by path with forward slashes, with its SHA-256. */
	files: Record<string, string>;
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

function list(items: string[], shown = 5): string {
	const more = items.length - shown;
	return items.slice(0, shown).join(', ') + (more > 0 ? ` and ${more} more` : '');
}

/** Windows has no meaningful modes. */
function setMode(path: string, mode: number): void {
	if (process.platform !== 'win32') chmodSync(path, mode);
}

/** Durable before the rename that says it is done. Windows cannot open a folder, so that part is skipped there. */
function fsyncFolder(path: string): void {
	let fd: number | undefined;
	try {
		fd = openSync(path, 'r');
		fsyncSync(fd);
	} catch {
		/* Windows */
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}

/** The file's SHA-256, read from disk. `flush` also makes it durable, and needs write access (a backup may sit on read-only media). */
function hashFile(path: string, flush = false): string {
	const hash = createHash('sha256');
	const fd = openSync(path, flush ? 'r+' : 'r');
	try {
		const chunk = Buffer.allocUnsafe(1024 * 1024);
		for (let n = readSync(fd, chunk); n > 0; n = readSync(fd, chunk)) hash.update(chunk.subarray(0, n));
		if (flush) fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	return hash.digest('hex');
}

/** Copies a file owner-only. The owner's execute bit stays: plugin code may carry one. Returns the copy's hash. */
function copyPrivate(from: string, to: string): string {
	mkdirSync(dirname(to), { recursive: true });
	copyFileSync(from, to);
	setMode(to, (statSync(from).mode & 0o700) | 0o600);
	return hashFile(to, true);
}

const isMissing = (e: unknown) => (e as { code?: string }).code === 'ENOENT';

/** A virus scanner or indexer on Windows can hold a new file or folder for a moment. */
function renameRetrying(from: string, to: string): void {
	for (let attempt = 1; ; attempt++) {
		try {
			renameSync(from, to);
			return;
		} catch (e) {
			const code = (e as { code?: string }).code;
			if (process.platform !== 'win32' || attempt >= 5 || !(code === 'EPERM' || code === 'EACCES' || code === 'EBUSY')) throw e;
			Bun.sleepSync(200 * attempt);
		}
	}
}

/** What a database copy needs beside it. Plain queries, because the program may be newer than the database. */
function needs(path: string): { blobs: string[]; avatars: string[] } {
	const sqlite = new Database(path, { readonly: true });
	try {
		const has = (name: string) => !!sqlite.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
		if (!has('blob') || !has('user_profile')) {
			throw new Error('This is not an OPAL 2 database. If it is a 1.x database, start OPAL once to import it, then back up.');
		}
		const rows = <T>(q: string) => sqlite.query(q).all() as T[];
		return {
			blobs: rows<{ sha256: string }>('SELECT sha256 FROM blob').map((r) => r.sha256),
			avatars: rows<{ avatar_hash: string }>('SELECT DISTINCT avatar_hash FROM user_profile WHERE avatar_hash IS NOT NULL').map((r) => r.avatar_hash)
		};
	} finally {
		sqlite.close();
	}
}

/** Throws unless SQLite reports the file sound. */
function checkIntegrity(path: string): void {
	let result: { integrity_check: string }[];
	const sqlite = new Database(path, { readonly: true });
	try {
		result = sqlite.query('PRAGMA integrity_check').all() as { integrity_check: string }[];
	} catch (e) {
		throw new Error(`The database copy cannot be read: ${(e as Error).message}`);
	} finally {
		sqlite.close();
	}
	if (result.length !== 1 || result[0]!.integrity_check !== 'ok') {
		throw new Error(`The database copy failed its integrity check: ${list(result.map((r) => r.integrity_check), 3)}`);
	}
}

function snapshotInto(source: string, dest: string): void {
	rmSync(dest, { force: true });
	const sqlite = new Database(source, { readonly: true });
	try {
		sqlite.run('PRAGMA busy_timeout = 30000');
		sqlite.run('VACUUM INTO ?', [dest]);
	} finally {
		sqlite.close();
	}
}

/** Files under `root`, by path relative to it. A plugin may delete one at any moment. Links are reported, not followed. */
function walk(root: string, links: string[]): string[] {
	const out: string[] = [];
	const visit = (dir: string) => {
		let entries;
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch (e) {
			if (isMissing(e)) return;
			throw e;
		}
		for (const e of entries) {
			const path = join(dir, e.name);
			if (e.isDirectory()) visit(path);
			else if (e.isFile()) out.push(path);
			else if (e.isSymbolicLink()) links.push(path);
		}
	};
	visit(root);
	return out;
}

const toManifestPath = (rel: string) => rel.split(sep).join('/');

/** Fills `work` and returns what the manifest records. Throws when the copy is not complete and sound. */
function fill(work: string, source: string, warnings: string[]): Pick<Manifest, 'counts' | 'files'> {
	const files: Record<string, string> = {};
	const copyDb = join(work, DB_FILE);
	const copy = (from: string, rel: string) => {
		files[rel] = copyPrivate(from, join(work, ...rel.split('/')));
	};

	/**
	 * The database copy decides which blobs belong. An upload writes its file before it inserts its row, so
	 * every row in the copy had a file on disk at that moment. A blob added after the copy has no row in it:
	 * it is not needed and not copied, and the next backup takes it. Half-written uploads and files with no
	 * row are skipped the same way. Blob files are never rewritten, so copying them late cannot tear them.
	 */
	let blobs: string[] = [];
	let avatars: string[] = [];
	let missingBlobs = 0;
	let missingAvatars: string[] = [];
	for (let attempt = 1; attempt <= SNAPSHOT_ATTEMPTS; attempt++) {
		try {
			snapshotInto(source, copyDb);
		} catch (e) {
			throw new Error(`Could not copy the database: ${(e as Error).message}. Check the free disk space in ${work}.`);
		}
		({ blobs, avatars } = needs(copyDb));
		missingBlobs = 0;
		missingAvatars = [];
		for (const sha of blobs) {
			const rel = `blobs/${sha}`;
			if (rel in files) continue;
			try {
				if (!HASH.test(sha)) throw new Error(`The blob table names a file that is not a hash: ${sha}`);
				copy(join(blobDir(), sha), rel);
			} catch (e) {
				if (!isMissing(e)) throw e;
				missingBlobs++;
			}
		}
		for (const hash of avatars) {
			const rel = `avatars/${hash}`;
			if (rel in files || !HASH.test(hash)) continue;
			try {
				copy(join(avatarDir(), hash), rel);
			} catch (e) {
				if (!isMissing(e)) throw e;
				missingAvatars.push(hash);
			}
		}
		if (!missingBlobs && !missingAvatars.length) break;
	}

	// Verify what is on the backup's disk, not what was meant to be written.
	checkIntegrity(copyDb);
	const damaged = blobs.filter((sha) => files[`blobs/${sha}`] !== undefined && files[`blobs/${sha}`] !== sha);
	if (damaged.length) {
		throw new Error(`${plural(damaged.length, 'attachment file')} in ${blobDir()} no longer match their hash, so they are damaged: ${list(damaged)}. Replace them from an older backup.`);
	}
	const absent = blobs.filter((sha) => files[`blobs/${sha}`] === undefined);
	if (absent.length) {
		throw new Error(`${plural(absent.length, 'attachment file')} the database needs are missing from ${blobDir()}: ${list(absent)}. Replace them from an older backup.`);
	}
	// A lost photo reads the same in the restored instance as it does now, and blocks no record.
	if (missingAvatars.length) warnings.push(`${plural(missingAvatars.length, 'avatar file')} named by a profile are missing from ${avatarDir()}, so the backup does not have them either: ${list(missingAvatars)}`);

	if (process.env.OPAL_SECRETS_KEY) {
		warnings.push('OPAL_SECRETS_KEY is set, so the key to stored secrets is not in this backup. Keep it separately, or those secrets must be entered again after a restore.');
	}

	// After the database copy: a key that sealed a value in the copy was on disk before that value was saved.
	let keyFiles = 0;
	// OPAL_DB_FILE can put the database somewhere else, with no data folder at all.
	for (const name of existsSync(dataDir()) ? readdirSync(dataDir()) : []) {
		if (KEY_FILE.test(name) && statSync(join(dataDir(), name)).isFile()) {
			copy(join(dataDir(), name), name);
			keyFiles++;
		}
	}

	let pluginFiles = 0;
	const links: string[] = [];
	const unportable: string[] = [];
	for (const [root, prefix] of [
		[pluginsRoot(), 'plugins'],
		[pluginDataRoot(), 'plugin-data']
	] as const) {
		for (const path of walk(root, links)) {
			const rel = `${prefix}/${toManifestPath(relative(root, path))}`;
			// Restore refuses such a path, and one bad name must not cost the whole backup.
			if (!isSafePath(rel)) {
				unportable.push(path);
				continue;
			}
			try {
				copy(path, rel);
				pluginFiles++;
			} catch (e) {
				if (!isMissing(e)) throw e;
			}
		}
	}
	if (links.length) warnings.push(`Symbolic links are not backed up: ${list(links)}`);
	if (unportable.length) warnings.push(`File names with a colon or backslash are not backed up: ${list(unportable)}`);

	files[DB_FILE] = hashFile(copyDb, true);
	return {
		files,
		counts: {
			databaseBytes: statSync(copyDb).size,
			attachments: blobs.length,
			avatars: Object.keys(files).filter((f) => f.startsWith('avatars/')).length,
			keyFiles,
			pluginFiles
		}
	};
}

function readManifest(folder: string): Manifest | null {
	try {
		const parsed = JSON.parse(readFileSync(join(folder, MANIFEST), 'utf8')) as Manifest;
		if (parsed?.format !== FORMAT || typeof parsed.files !== 'object' || parsed.files === null) return null;
		return parsed;
	} catch {
		return null;
	}
}

function backupFolders(parent: string): { finished: string[]; unfinished: string[] } {
	const finished: string[] = [];
	const unfinished: string[] = [];
	for (const e of readdirSync(parent, { withFileTypes: true })) {
		// A link is not a folder this command made, whatever it is called.
		if (!e.isDirectory() || !OURS_NAME.test(e.name)) continue;
		if (FINISHED_NAME.test(e.name) && readManifest(join(parent, e.name))) finished.push(e.name);
		else unfinished.push(e.name);
	}
	return { finished: finished.sort(), unfinished: unfinished.sort() };
}

/**
 * Removes finished backups beyond the newest `keep`, counting the one just written. Only a folder with a
 * finished name and a valid manifest is a candidate. The manifest goes first, so a crash in the middle
 * cannot leave a part of a backup that still reads as finished.
 */
function prune(parent: string, keep: number, written: string, warnings: string[]): string[] {
	const others = backupFolders(parent).finished.filter((n) => n !== written);
	// Newest first. The one just written always stays, even if the clock has moved backwards.
	const excess = others.reverse().slice(keep - 1);
	const removed: string[] = [];
	for (const name of excess) {
		const path = join(parent, name);
		try {
			unlinkSync(join(path, MANIFEST));
			rmSync(path, { recursive: true, force: true });
			removed.push(name);
		} catch (e) {
			warnings.push(`Could not remove the old backup ${path}: ${(e as Error).message}`);
		}
	}
	return removed;
}

export interface BackupResult {
	path: string;
	counts: Counts;
	removed: string[];
	unfinished: string[];
	warnings: string[];
}

/** Writes one complete backup under `parent`. Throws, leaving no finished folder and removing nothing, if it cannot. */
export function takeBackup(parent: string, opts: { keep?: number } = {}): BackupResult {
	// Does not call hardenDataDir: a backup must not change the folder it reads.
	const umask = process.platform === 'win32' ? undefined : process.umask(0o077);
	try {
		const source = dbPath();
		if (existsSync(join(dataDir(), RESTORE_MARKER))) throw new Error(`A restore into ${dataDir()} did not finish, so it holds no complete instance to back up.`);
		if (!existsSync(source)) throw new Error(`There is no database at ${source}, so there is nothing to back up. Set OPAL_DATA_DIR to the data folder.`);
		mkdirSync(parent, { recursive: true, mode: 0o700 });
		const name = `opal-backup-${now().replace(/[:.]/g, '-')}`;
		const final = join(parent, name);
		const work = `${final}.partial`;
		const warnings: string[] = [];
		mkdirSync(work, { mode: 0o700 });
		let counts: Counts;
		try {
			const filled = fill(work, source, warnings);
			counts = filled.counts;
			const manifest: Manifest = {
				format: FORMAT,
				formatVersion: FORMAT_VERSION,
				createdAt: now(),
				opalVersion: VERSION,
				counts,
				files: filled.files
			};
			const fd = openSync(join(work, MANIFEST), 'wx', 0o600);
			try {
				writeSync(fd, `${JSON.stringify(manifest, null, 1)}\n`);
				fsyncSync(fd);
			} finally {
				closeSync(fd);
			}
			for (const dir of new Set(Object.keys(filled.files).map((f) => dirname(join(work, ...f.split('/')))))) fsyncFolder(dir);
			fsyncFolder(work);
			renameRetrying(work, final);
			fsyncFolder(parent);
		} catch (e) {
			// Ours, and known to be incomplete. A crash cannot run this, and leaves `.partial` for a person to delete.
			try {
				rmSync(work, { recursive: true, force: true });
			} catch {
				/* the error that brought us here says more */
			}
			throw e;
		}
		const removed = opts.keep === undefined ? [] : prune(parent, opts.keep, name, warnings);
		return { path: final, counts, removed, unfinished: backupFolders(parent).unfinished, warnings };
	} finally {
		if (umask !== undefined) process.umask(umask);
	}
}

/** Reads a backup and proves it complete. Throws, saying what is wrong, when it is not. Writes nothing. */
export function verifyBackup(folder: string): Manifest {
	const notABackup = (why: string) => new Error(`${folder} is not a complete OPAL backup: ${why}.`);
	if (!existsSync(folder) || !statSync(folder).isDirectory()) throw notABackup('there is no such folder');
	if (!existsSync(join(folder, MANIFEST))) throw notABackup(`it has no ${MANIFEST}, which is written last. It may be from an interrupted backup`);
	const manifest = readManifest(folder);
	if (!manifest) throw notABackup(`its ${MANIFEST} cannot be read`);
	if (manifest.formatVersion !== FORMAT_VERSION) throw new Error(`${folder} has backup format ${manifest.formatVersion}, which this version of OPAL cannot read. It was made by OPAL ${manifest.opalVersion}.`);
	const paths = Object.keys(manifest.files);
	const strange = paths.filter((p) => !isSafePath(p));
	if (strange.length) throw notABackup(`its ${MANIFEST} names unexpected paths: ${list(strange)}`);
	if (!manifest.files[DB_FILE]) throw notABackup(`its ${MANIFEST} names no database`);

	const absent: string[] = [];
	const damaged: string[] = [];
	for (const rel of paths) {
		const path = join(folder, ...rel.split('/'));
		if (!existsSync(path)) absent.push(rel);
		else if (hashFile(path) !== manifest.files[rel]) damaged.push(rel);
	}
	if (absent.length) throw notABackup(`${plural(absent.length, 'file')} missing: ${list(absent)}`);
	if (damaged.length) throw notABackup(`${plural(damaged.length, 'file')} changed since the backup was written: ${list(damaged)}`);

	const copyDb = join(folder, DB_FILE);
	checkIntegrity(copyDb);
	const unlisted = needs(copyDb).blobs.filter((sha) => !manifest.files[`blobs/${sha}`]);
	if (unlisted.length) throw notABackup(`the database needs ${plural(unlisted.length, 'attachment file')} it does not hold: ${list(unlisted)}`);

	const sqlite = new Database(copyDb, { readonly: true });
	let applied: number;
	try {
		applied = lastApplied(sqlite);
	} finally {
		sqlite.close();
	}
	// An older program would run on a schema it has never seen, with nothing to stop it.
	const newest = Math.max(0, ...migrationFiles().map((m) => m.folderMillis));
	if (applied > newest) throw new Error(`${folder} was made by OPAL ${manifest.opalVersion}, whose database is newer than this version (${VERSION}) can run. Install that version or a later one, then restore.`);
	return manifest;
}

/** Throws when a folder holds a restore that stopped partway. `serve` must not start on it: it would run with an empty database. */
export function assertNoUnfinishedRestore(): void {
	if (existsSync(join(dataDir(), RESTORE_MARKER))) {
		throw new Error(`A restore into ${dataDir()} did not finish. Run \`opal restore\` again with the same backup.`);
	}
}

export interface RestoreResult {
	path: string;
	counts: Counts;
	createdAt: string;
	opalVersion: string;
}

/**
 * Restores into the data folder, which must hold nothing yet. The database arrives last, by rename: until
 * then the marker tells `serve` and a repeated restore that this folder is unfinished. A repeated restore
 * writes over what the last one left. There is no way to restore over a database.
 */
export function restoreBackup(folder: string): RestoreResult {
	const target = dbPath();
	const dir = dataDir();
	const marker = join(dir, RESTORE_MARKER);
	if ([target, `${target}-wal`, `${target}-shm`].some((p) => existsSync(p))) {
		throw new Error(`${dir} already has a database (${target}). Restore never replaces one. Set OPAL_DATA_DIR to an empty folder, or move this one aside first.`);
	}
	const resuming = existsSync(marker);
	if (!resuming && existsSync(dir)) {
		const present = readdirSync(dir);
		if (present.length) throw new Error(`${dir} is not empty (${list(present)}). Restore only writes into an empty folder. Set OPAL_DATA_DIR to an empty one, or move these aside first.`);
	}

	const manifest = verifyBackup(folder);

	// Creates a missing data folder owner-only and sets the umask for what follows.
	hardenDataDir();
	mkdirSync(dir, { recursive: true });
	writeFileSync(marker, `Restoring ${folder} at ${now()}\n`, { mode: 0o600 });
	fsyncFolder(dir);

	const places = new Set<string>();
	const write = (rel: string, to: string) => {
		if (copyPrivate(join(folder, ...rel.split('/')), to) !== manifest.files[rel]) {
			throw new Error(`The copy of ${rel} in ${dirname(to)} does not match the backup. Check that disk, then run this again.`);
		}
		places.add(dirname(to));
	};
	for (const rel of Object.keys(manifest.files)) {
		if (rel !== DB_FILE) write(rel, join(dir, ...rel.split('/')));
	}
	const incoming = `${target}.restoring`;
	write(DB_FILE, incoming);
	for (const place of places) fsyncFolder(place);
	renameRetrying(incoming, target);
	fsyncFolder(dirname(target));
	unlinkSync(marker);
	fsyncFolder(dir);
	return { path: target, counts: manifest.counts, createdAt: manifest.createdAt, opalVersion: manifest.opalVersion };
}
