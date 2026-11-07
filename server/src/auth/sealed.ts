/**
 * Secrets stored in the database are sealed with a key kept outside it: AES-256-GCM, with the place
 * the value belongs to bound in, so a sealed value cannot be moved to another setting.
 *
 * The key is OPAL_SECRETS_KEY, else the file `.opal_secrets_key` in the data folder. It is not derived
 * from the auth secret on purpose: that one may change at any time at the cost of a few signed links,
 * and it falls back to a throwaway value when it cannot be saved. Losing this key loses the secrets,
 * so a key that cannot be saved is an error, and a damaged key file is never replaced.
 *
 * The file holds one key per line. The first seals; all of them open. A rotation that stops halfway
 * leaves both, so nothing stored becomes unreadable.
 *
 * The file is read on every use. It is small, and no copy in memory can disagree with it after a
 * rotation, a factory reset or a move of the data folder.
 */
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { closeSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { dataDir } from '../paths.ts';

const PREFIX = 'opal-sealed:v1:';
const IV_BYTES = 12;
const TAG_BYTES = 16;
const MIN_KEY_CHARS = 32;

export const KEY_FILE = '.opal_secrets_key';

/** Where a sealed value belongs. A value opens only in the place it was sealed for. */
export const authSettingScope = (key: string) => `auth_setting/${key}`;
export const pluginSettingScope = (pluginKey: string, key: string) => `plugin_setting/${pluginKey}/${key}`;

/**
 * The demo points OPAL_DATA_DIR at its own attachments folder, but it runs on the same key, so the
 * key stays with the real folder for as long as the demo is on.
 */
let pinnedFolder: string | undefined;
export function pinKeyFolder(dir: string | undefined): void {
	pinnedFolder = dir;
}

export const keyFilePath = () => join(pinnedFolder ?? dataDir(), KEY_FILE);

function fileKeys(): string[] {
	const path = keyFilePath();
	let text: string;
	try {
		text = readFileSync(path, 'utf8');
	} catch (e) {
		if ((e as { code?: string }).code === 'ENOENT') return [];
		throw new Error(`Could not read the secrets key ${path}: ${(e as Error).message}`);
	}
	const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
	if (!lines.length || lines.some((l) => l.length < MIN_KEY_CHARS)) {
		throw new Error(`${path} is not a usable secrets key. Restore it from a backup. If there is none, delete it and enter the stored secrets again.`);
	}
	return lines;
}

function envKey(name: 'OPAL_SECRETS_KEY' | 'OPAL_SECRETS_KEY_PREVIOUS'): string | undefined {
	const value = process.env[name]?.trim();
	if (!value) return undefined;
	if (value.length < MIN_KEY_CHARS) {
		throw new Error(`${name} is too short: use at least ${MIN_KEY_CHARS} characters, for example from \`openssl rand -hex 32\`.`);
	}
	return value;
}

/** Durable before it is used: a secret sealed with a key that a crash then loses is gone. Returns the temp file. */
function writeTemp(path: string, keys: string[]): string {
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const tmp = `${path}.${randomBytes(6).toString('hex')}.tmp`;
	const fd = openSync(tmp, 'wx', 0o600);
	try {
		writeSync(fd, `${keys.join('\n')}\n`);
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	return tmp;
}

function syncFolder(dir: string): void {
	try {
		const d = openSync(dir, 'r');
		try {
			fsyncSync(d);
		} finally {
			closeSync(d);
		}
	} catch {
		/* Windows cannot open a folder */
	}
}

/** Replaces the file. Through a link, so a key kept on another volume stays there. */
function writeKeyFile(keys: string[]): void {
	let path = keyFilePath();
	try {
		path = realpathSync(path);
	} catch {
		/* no file yet */
	}
	renameSync(writeTemp(path, keys), path);
	syncFolder(dirname(path));
}

const newKey = () => randomBytes(32).toString('hex');

/**
 * The first key. Two processes can both find none, and one may already have sealed a value with
 * its key, so the file that got there first stays: a link refuses to replace it, where a rename would not.
 */
function createKeyFile(): string {
	const path = keyFilePath();
	const made = newKey();
	const tmp = writeTemp(path, [made]);
	try {
		linkSync(tmp, path);
	} catch (e) {
		const code = (e as { code?: string }).code;
		if (code === 'EEXIST') {
			const [winner] = fileKeys();
			if (!winner) throw new Error(`${path} exists but cannot be read as a secrets key.`);
			return winner;
		}
		if (code !== 'EPERM' && code !== 'ENOTSUP' && code !== 'ENOSYS') throw e;
		// A folder with no hard links. The file is still complete when it appears.
		renameSync(tmp, path);
	} finally {
		rmSync(tmp, { force: true });
	}
	syncFolder(dirname(path));
	return made;
}

/** The key that seals now, or none before the first secret. Asking never makes one. */
const currentKey = () => envKey('OPAL_SECRETS_KEY') ?? fileKeys()[0];

/** The key that seals. Made on first need, so an instance with no secrets has no key to look after. */
const sealingKey = () => currentKey() ?? createKeyFile();

/** Every key that may open a value, the sealing key first. A file left after moving to the variable still counts. */
export function openingKeys(): string[] {
	const keys = [envKey('OPAL_SECRETS_KEY'), ...fileKeys(), envKey('OPAL_SECRETS_KEY_PREVIOUS')].filter((k): k is string => !!k);
	return [...new Set(keys)];
}

const derive = (material: string) => Buffer.from(hkdfSync('sha256', material, Buffer.alloc(0), 'opal-sealed-v1', 32));

export const isSealed = (value: unknown): value is string => typeof value === 'string' && value.startsWith(PREFIX);

export function seal(plain: string, scope: string): string {
	const iv = randomBytes(IV_BYTES);
	const cipher = createCipheriv('aes-256-gcm', derive(sealingKey()), iv);
	cipher.setAAD(Buffer.from(scope));
	const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
	return PREFIX + Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64url');
}

function openWith(material: string, sealed: string, scope: string): string | null {
	const raw = Buffer.from(sealed.slice(PREFIX.length), 'base64url');
	if (raw.length < IV_BYTES + TAG_BYTES) return null;
	try {
		const decipher = createDecipheriv('aes-256-gcm', derive(material), raw.subarray(0, IV_BYTES));
		decipher.setAAD(Buffer.from(scope));
		decipher.setAuthTag(raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
		return Buffer.concat([decipher.update(raw.subarray(IV_BYTES + TAG_BYTES)), decipher.final()]).toString('utf8');
	} catch {
		return null;
	}
}

/** The plain value and whether it was sealed with the key in charge, or null when no key opens it. */
export function openSealed(sealed: string, scope: string, keys = openingKeys()): { plain: string; current: boolean } | null {
	// By value, not position: with only OPAL_SECRETS_KEY_PREVIOUS set, the one key there is does not seal.
	const sealing = currentKey();
	for (const key of keys) {
		const plain = openWith(key, sealed, scope);
		if (plain !== null) return { plain, current: key === sealing };
	}
	return null;
}

/**
 * The value a stored text stands for: a value not yet sealed is itself, and null means it cannot be
 * read. A broken key reads as null too. It stops the server at start, and a sign-in page must not
 * fail because the file changed under a running one.
 */
export function readStored(stored: string, scope: string): string | null {
	if (!isSealed(stored)) return stored;
	try {
		return openSealed(stored, scope)?.plain ?? null;
	} catch (e) {
		console.error((e as Error).message);
		return null;
	}
}

/** Puts a new sealing key in front of the old ones. A rotation that stopped halfway reuses the one it made. */
export function addKeyToFile(): void {
	const keys = fileKeys();
	if (keys.length < 2) writeKeyFile([newKey(), ...keys]);
}

export function dropOldKeysFromFile(): void {
	const [first] = fileKeys();
	if (first) writeKeyFile([first]);
}

/** A factory reset: the secrets it erased go with their key. */
export function removeKeyFile(): void {
	rmSync(keyFilePath(), { force: true });
}
