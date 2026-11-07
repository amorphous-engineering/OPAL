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
	linkSync,
	lstatSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	readSync,
	renameSync,
	rmdirSync,
	rmSync,
	statSync,
	unlinkSync,
	writeFileSync,
	writeSync
} from 'node:fs';
import { basename, dirname, join, relative, sep } from 'node:path';
import { KEY_FILE as SECRETS_KEY_FILE, keysInFile } from '../../auth/sealed.ts';
import { lastApplied, migrationFiles } from '../../db/client.ts';
import { instanceIdOf } from '../../db/instance-id.ts';
import { unreadableSecrets } from '../../db/seal-secrets.ts';
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

/** Present in the data folder from before a restore reads its backup in full until the database is in place. */
export const RESTORE_MARKER = '.opal-restore-unfinished';

/** What the marker holds, so that a second run can tell whether it is finishing the same restore. */
interface RestoreMarker {
	backup: string;
	/** The hash of the backup's manifest, which names the hash of every file in it. */
	manifest: string;
	startedAt: string;
}

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
	/** Which instance this is a backup of. `--keep` leaves any other alone, and a backup from before these existed. */
	instanceId?: string;
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

/**
 * Whether the keys that went into the backup open what went into it. They may not: a key in the
 * environment is left out, and a rotation between the database copy and the key copy leaves the new key
 * beside values sealed with the old one. It reads only the copies, because a restore has only those.
 */
function secretsOpen(work: string, warnings: string[]): boolean {
	let sqlite: Database | undefined;
	try {
		const keys = keysInFile(join(work, SECRETS_KEY_FILE));
		sqlite = new Database(join(work, DB_FILE), { readonly: true, strict: true });
		const unreadable = unreadableSecrets(sqlite, keys);
		if (unreadable.length) {
			warnings.push(`These stored secrets do not open with the keys in this backup, so they will need entering again after a restore: ${list(unreadable)}. The key that opens them is not in the backup: it may be OPAL_SECRETS_KEY, or the key file changed during this backup.`);
		}
		return !unreadable.length;
	} catch (e) {
		warnings.push(`Could not check that the stored secrets open with the keys in this backup: ${(e as Error).message}`);
		return false;
	} finally {
		sqlite?.close();
	}
}

/** Fills `work` and returns what the manifest records. Throws when the copy is not complete and sound. */
function fill(work: string, source: string, warnings: string[]): Pick<Manifest, 'counts' | 'files'> & { secretsOpen: boolean; instanceId: string | null } {
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

	const opens = secretsOpen(work, warnings);

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
	const copied = new Database(copyDb, { readonly: true });
	let instanceId: string | null;
	try {
		instanceId = instanceIdOf(copied);
	} finally {
		copied.close();
	}
	return {
		files,
		secretsOpen: opens,
		instanceId,
		counts: {
			databaseBytes: statSync(copyDb).size,
			attachments: blobs.length,
			avatars: Object.keys(files).filter((f) => f.startsWith('avatars/')).length,
			keyFiles,
			pluginFiles
		}
	};
}

/**
 * What sits at a path inside a backup, looking at every step without following links. Hashing a FIFO would
 * wait forever, and a link would bring in something from outside the backup.
 */
function entryKind(folder: string, rel: string): 'file' | 'absent' | 'other' {
	const steps = rel.split('/');
	let path = folder;
	for (const [i, step] of steps.entries()) {
		path = join(path, step);
		let stat;
		try {
			stat = lstatSync(path);
		} catch (e) {
			if (isMissing(e)) return 'absent';
			throw e;
		}
		if (i === steps.length - 1 ? !stat.isFile() : !stat.isDirectory()) return 'other';
	}
	return 'file';
}

function readManifest(folder: string): Manifest | null {
	try {
		if (entryKind(folder, MANIFEST) !== 'file') return null;
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
 * Removes this instance's finished backups beyond the newest `keep`, counting the one just written. Only a
 * folder with a finished name and a valid manifest is a candidate, and only if the manifest names this
 * instance, because a folder may be shared. The manifest goes first, so a crash in the middle cannot leave
 * a part of a backup that still reads as finished.
 */
function prune(parent: string, keep: number, written: string, instanceId: string | null, warnings: string[]): { removed: string[]; leftAlone: number } {
	const others = backupFolders(parent).finished.filter((n) => n !== written);
	if (!instanceId) {
		warnings.push('This database has no instance id yet, so --keep removed nothing. Start OPAL once with this version, and the next backup will prune.');
		return { removed: [], leftAlone: others.length };
	}
	const ours = others.filter((n) => readManifest(join(parent, n))?.instanceId === instanceId);
	// Newest first. The one just written always stays, even if the clock has moved backwards.
	const excess = ours.reverse().slice(keep - 1);
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
	return { removed, leftAlone: others.length - ours.length };
}

export interface BackupResult {
	path: string;
	counts: Counts;
	/** Every stored secret in this backup opens with the keys in this backup. */
	secretsOpen: boolean;
	removed: string[];
	/** With `--keep`: finished backups here of another instance, or from before instances had ids. */
	leftAlone: number;
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
		let opens: boolean;
		let instanceId: string | null;
		try {
			const filled = fill(work, source, warnings);
			counts = filled.counts;
			opens = filled.secretsOpen;
			instanceId = filled.instanceId;
			const manifest: Manifest = {
				format: FORMAT,
				formatVersion: FORMAT_VERSION,
				createdAt: now(),
				opalVersion: VERSION,
				...(instanceId ? { instanceId } : {}),
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
		const { removed, leftAlone } = opts.keep === undefined ? { removed: [], leftAlone: 0 } : prune(parent, opts.keep, name, instanceId, warnings);
		return { path: final, counts, secretsOpen: opens, removed, leftAlone, unfinished: backupFolders(parent).unfinished, warnings };
	} finally {
		if (umask !== undefined) process.umask(umask);
	}
}

const notABackup = (folder: string, why: string) => new Error(`${folder} is not a complete OPAL backup: ${why}.`);

/** What can be said about a backup from its manifest alone, which takes no time. */
function readBackup(folder: string): Manifest {
	if (!existsSync(folder) || !statSync(folder).isDirectory()) throw notABackup(folder, 'there is no such folder');
	if (entryKind(folder, MANIFEST) === 'absent') throw notABackup(folder, `it has no ${MANIFEST}, which is written last. It may be from an interrupted backup`);
	const manifest = readManifest(folder);
	if (!manifest) throw notABackup(folder, `its ${MANIFEST} cannot be read`);
	if (manifest.formatVersion !== FORMAT_VERSION) throw new Error(`${folder} has backup format ${manifest.formatVersion}, which this version of OPAL cannot read. It was made by OPAL ${manifest.opalVersion}.`);
	const strange = Object.keys(manifest.files).filter((p) => !isSafePath(p));
	if (strange.length) throw notABackup(folder, `its ${MANIFEST} names unexpected paths: ${list(strange)}`);
	if (!manifest.files[DB_FILE]) throw notABackup(folder, `its ${MANIFEST} names no database`);
	return manifest;
}

/** Reads a backup and proves it complete. Throws, saying what is wrong, when it is not. Writes nothing. */
export function verifyBackup(folder: string): Manifest {
	const manifest = readBackup(folder);
	const paths = Object.keys(manifest.files);
	const kinds = new Map(paths.map((rel) => [rel, entryKind(folder, rel)]));
	const irregular = paths.filter((rel) => kinds.get(rel) === 'other');
	if (irregular.length) throw notABackup(folder, `${plural(irregular.length, 'path')} in its ${MANIFEST} not a regular file: ${list(irregular)}`);
	const absent = paths.filter((rel) => kinds.get(rel) === 'absent');
	if (absent.length) throw notABackup(folder, `${plural(absent.length, 'file')} missing: ${list(absent)}`);
	const damaged = paths.filter((rel) => hashFile(join(folder, ...rel.split('/'))) !== manifest.files[rel]);
	if (damaged.length) throw notABackup(folder, `${plural(damaged.length, 'file')} changed since the backup was written: ${list(damaged)}`);

	const copyDb = join(folder, DB_FILE);
	checkIntegrity(copyDb);
	const unlisted = needs(copyDb).blobs.filter((sha) => !manifest.files[`blobs/${sha}`]);
	if (unlisted.length) throw notABackup(folder, `the database needs ${plural(unlisted.length, 'attachment file')} it does not hold: ${list(unlisted)}`);

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

/** What a marker says. Empty: a crash in the moment after making it, before any other file was written. */
function readRestoreMarker(path: string): RestoreMarker | 'blank' | 'none' {
	let text: string;
	try {
		text = readFileSync(path, 'utf8');
	} catch (e) {
		if (isMissing(e)) return 'none';
		throw e;
	}
	if (!text.trim()) return 'blank';
	try {
		const parsed = JSON.parse(text) as RestoreMarker;
		if (typeof parsed?.manifest === 'string' && typeof parsed.backup === 'string') return parsed;
	} catch {
		/* said below */
	}
	throw new Error(`${path} cannot be read, so nothing can say which backup this folder was being restored from. Move the folder aside and restore into an empty one.`);
}

/** Throws when a folder holds a restore that is running or stopped partway. `serve` must not start on it: it would run with an empty database. */
export function assertNoUnfinishedRestore(): void {
	const marker = join(dataDir(), RESTORE_MARKER);
	if (!existsSync(marker)) return;
	let started: ReturnType<typeof readRestoreMarker> = 'blank';
	try {
		started = readRestoreMarker(marker);
	} catch {
		/* the name of the backup is a courtesy here */
	}
	const again = typeof started === 'object' ? `\`opal restore ${started.backup}\`` : '`opal restore` with the same backup';
	throw new Error(`A restore into ${dataDir()} is running or did not finish. If it stopped, run ${again} again.`);
}

export interface RestoreResult {
	path: string;
	counts: Counts;
	createdAt: string;
	opalVersion: string;
}

/** Takes the database out of `incoming` without replacing anything: a link refuses an existing file, where a rename would not. */
function publishDatabase(incoming: string, target: string, refuse: (what: string) => Error): void {
	try {
		linkSync(incoming, target);
	} catch (e) {
		const code = (e as { code?: string }).code;
		if (code === 'EEXIST') throw refuse(basename(target));
		if (code !== 'EPERM' && code !== 'ENOTSUP' && code !== 'ENOSYS') throw e;
		// A folder with no hard links. The check just before this one is all there is.
		renameRetrying(incoming, target);
		return;
	}
	unlinkSync(incoming);
}

/**
 * Restores into the data folder, which must hold nothing yet. The marker comes first, before the backup
 * is read in full, because that can take minutes and `serve` must refuse the folder from the start. The
 * database arrives last. A repeated restore of the same backup writes over what the last one left, or
 * only clears the marker if the database had already arrived. There is no way to restore over a database.
 *
 * `stages` lets a test act at the moments another process could.
 */
export function restoreBackup(folder: string, stages: { verifying?: () => void; publishing?: () => void } = {}): RestoreResult {
	const target = dbPath();
	const dir = dataDir();
	const marker = join(dir, RESTORE_MARKER);
	const incoming = `${target}.restoring`;
	const liveFiles = [target, `${target}-wal`, `${target}-shm`];
	const hasDatabase = () => liveFiles.some((p) => existsSync(p));
	const replaces = `Restore never replaces one. Set OPAL_DATA_DIR to an empty folder, or move this one aside first.`;

	const started = readRestoreMarker(marker);
	if (started === 'none') {
		if (hasDatabase()) throw new Error(`${dir} already has a database (${target}). ${replaces}`);
		if (existsSync(dir)) {
			const present = readdirSync(dir);
			if (present.length) throw new Error(`${dir} is not empty (${list(present)}). Restore only writes into an empty folder. Set OPAL_DATA_DIR to an empty one, or move these aside first.`);
		}
	}

	const manifest = readBackup(folder);
	const manifestHash = hashFile(join(folder, MANIFEST));
	const result: RestoreResult = { path: target, counts: manifest.counts, createdAt: manifest.createdAt, opalVersion: manifest.opalVersion };
	const removeMarker = () => {
		unlinkSync(marker);
		fsyncFolder(dir);
	};
	if (typeof started === 'object' && started.manifest !== manifestHash) {
		throw new Error(`The restore into ${dir} was from ${started.backup}, and ${folder} is a different backup. Run it again with that one, or move this folder aside and restore into an empty one.`);
	}
	if (started !== 'none' && hasDatabase()) {
		// The last run stopped between putting the database in place and removing the marker, or something else made this file.
		const unopened = !existsSync(`${target}-wal`) && !existsSync(`${target}-shm`);
		if (typeof started !== 'object' || !unopened || !existsSync(target) || hashFile(target) !== manifest.files[DB_FILE]) {
			throw new Error(`${dir} has a database (${target}) that is not the one in ${folder}, so something else made or opened it during the restore. ${replaces}`);
		}
		rmSync(incoming, { force: true });
		fsyncFolder(dirname(target));
		removeMarker();
		return result;
	}

	const hadFolder = existsSync(dir);
	// Creates a missing data folder owner-only and sets the umask for what follows.
	hardenDataDir();
	mkdirSync(dir, { recursive: true });
	const says = `${JSON.stringify({ backup: folder, manifest: manifestHash, startedAt: now() } satisfies RestoreMarker)}\n`;
	if (started === 'none') {
		let fd: number;
		try {
			fd = openSync(marker, 'wx', 0o600);
		} catch (e) {
			if ((e as { code?: string }).code === 'EEXIST') throw new Error(`Another restore into ${dir} has just started.`);
			throw e;
		}
		try {
			writeSync(fd, says);
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
	} else if (started === 'blank') {
		writeFileSync(marker, says, { mode: 0o600 });
	}
	fsyncFolder(dir);

	try {
		stages.verifying?.();
		verifyBackup(folder);
	} catch (e) {
		// Nothing is written yet, so a first run leaves the folder as it found it. A later run still has an unfinished folder.
		if (typeof started !== 'object') {
			removeMarker();
			try {
				if (!hadFolder) rmdirSync(dir);
			} catch {
				/* something else has moved in, and the error that brought us here says more */
			}
		}
		throw e;
	}

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
	write(DB_FILE, incoming);
	for (const place of places) fsyncFolder(place);
	stages.publishing?.();

	// The marker keeps out anything that starts from here on, but not a server already past its own check when the marker appeared.
	const refuse = (what: string) =>
		new Error(`Something else wrote to ${dir} during this restore: ${what}. Nothing was replaced, and the restored database is not in place. Stop whatever is using this folder, move it aside and restore into an empty one.`);
	const ours = new Set([RESTORE_MARKER, basename(incoming), ...Object.keys(manifest.files).filter((rel) => rel !== DB_FILE).map((rel) => rel.split('/')[0]!)]);
	const appeared = new Set([...readdirSync(dir).filter((name) => !ours.has(name)), ...liveFiles.filter((p) => existsSync(p)).map((p) => basename(p))]);
	if (appeared.size) throw refuse(list([...appeared]));
	publishDatabase(incoming, target, refuse);
	fsyncFolder(dirname(target));
	removeMarker();
	return result;
}
