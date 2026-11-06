import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { chmodSync, cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addKeyToFile, authSettingScope, isSealed, KEY_FILE, keyFilePath, openSealed, seal, readStored } from '../../src/auth/sealed.ts';
import { rotateSecretsKey } from '../../src/commands/secrets.ts';
import type { Ctx } from '../../src/context.ts';
import { MIGRATIONS_DIR, openDb, type Db } from '../../src/db/client.ts';
import { holdsPlaintextSecret, sweepCopies } from '../../src/db/seal-secrets.ts';
import { auditLog, plugin, pluginSetting, user } from '../../src/db/schema/index.ts';
import { hardenDataDir } from '../../src/harden.ts';
import { oidcActive, readSettings, writeSetting } from '../../src/services/auth/settings.ts';
import { missingSettings, saveSettings } from '../../src/services/plugins/settings.ts';
import { findPlugin, settingValues, toDetail, unreadableSettings } from '../../src/services/plugins/store.ts';

const OIDC = 'oidc-client-secret-from-rc24';
const OLD_OIDC = 'an-older-secret-replaced-long-ago';
const PLUGIN = 'plugin-api-key-from-rc24';
const LATE = 'was-a-plain-setting-until-an-update';
const RC24 = '0004_skip_required_gate';

const saved = { dir: process.env.OPAL_DATA_DIR, key: process.env.OPAL_SECRETS_KEY, oidc: process.env.OPAL_OIDC_CLIENT_SECRET };
let dir: string;
let path: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'opal-sealed-'));
	path = join(dir, 'opal.db');
	process.env.OPAL_DATA_DIR = dir;
	// These tests are about the key file. The rest of the suite pins a key.
	delete process.env.OPAL_SECRETS_KEY;
	delete process.env.OPAL_SECRETS_KEY_PREVIOUS;
	delete process.env.OPAL_OIDC_CLIENT_SECRET;
});
afterEach(() => {
	for (const [k, v] of [['OPAL_DATA_DIR', saved.dir], ['OPAL_SECRETS_KEY', saved.key], ['OPAL_OIDC_CLIENT_SECRET', saved.oidc]] as const) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
	delete process.env.OPAL_SECRETS_KEY_PREVIOUS;
	rmSync(dir, { recursive: true, force: true });
});

const ts = '2026-01-01T00:00:00.000Z';
const sys = (db: Db): Ctx => ({ db, actor: { kind: 'system' }, op: 'test' }) as Ctx;

/** The migrations as they were when rc.24 shipped. */
function migrationsOfRc24(): string {
	const folder = mkdtempSync(join(dir, 'migrations-'));
	cpSync(MIGRATIONS_DIR, folder, { recursive: true });
	const journal = join(folder, 'meta/_journal.json');
	const data = JSON.parse(readFileSync(journal, 'utf8')) as { entries: { tag: string }[] };
	data.entries = data.entries.slice(0, data.entries.findIndex((e) => e.tag === RC24) + 1);
	writeFileSync(journal, JSON.stringify(data));
	return folder;
}

const manifest = {
	id: 'echo',
	name: 'Echo',
	version: '1.0.0',
	opal: '>=2.0.0',
	main: 'a.js',
	permissions: { ops: [], events: [] },
	settings: [
		{ key: 'apiKey', label: 'API key', type: 'secret', required: true },
		{ key: 'late', label: 'Late', type: 'secret' },
		{ key: 'url', label: 'URL', type: 'text' }
	]
};

/** A database as rc.24 left it: secrets in plaintext, and one it overwrote still in freed space. */
function rc24Database(): void {
	const db = openDb(path, migrationsOfRc24());
	const sqlite = db.$client;
	const rows = (table: string, columns: string, ...values: unknown[]) =>
		sqlite.run(`INSERT INTO ${table} (${columns}) VALUES (${values.map(() => '?').join(', ')})`, values as never[]);
	rows('auth_setting', 'key, value, created_at, updated_at', 'oidc_enabled', 'true', ts, ts);
	rows('auth_setting', 'key, value, created_at, updated_at', 'oidc_issuer', 'https://id.example.com', ts, ts);
	rows('auth_setting', 'key, value, created_at, updated_at', 'oidc_client_id', 'opal', ts, ts);
	rows('auth_setting', 'key, value, created_at, updated_at', 'oidc_client_secret', OLD_OIDC, ts, ts);
	sqlite.run('UPDATE auth_setting SET value = ? WHERE key = ?', [OIDC, 'oidc_client_secret']);
	rows('user', 'username, name, created_at, updated_at', 'plugin.echo', 'Echo', ts, ts);
	const userId = (sqlite.query('SELECT id FROM user').get() as { id: number }).id;
	rows('plugin', 'key, source, sha, version, manifest, enabled, user_id, created_at, updated_at', 'echo', 'local:/x', 'local', '1.0.0', JSON.stringify(manifest), 1, userId, ts, ts);
	rows('plugin_setting', 'plugin_id, key, value, secret, created_at, updated_at', 1, 'apiKey', JSON.stringify(PLUGIN), 1, ts, ts);
	rows('plugin_setting', 'plugin_id, key, value, secret, created_at, updated_at', 1, 'url', JSON.stringify('http://visible.test'), 0, ts, ts);
	// A setting a plugin update made secret. rc.24 kept the old flag and logged the value.
	rows('plugin_setting', 'plugin_id, key, value, secret, created_at, updated_at', 1, 'late', JSON.stringify(LATE), 0, ts, ts);
	const lateId = (sqlite.query("SELECT id FROM plugin_setting WHERE key = 'late'").get() as { id: number }).id;
	rows('audit_log', 'at, entity, entity_id, action, op, after', ts, 'plugin_setting', lateId, 'create', 'test', JSON.stringify({ key: 'late', value: LATE, secret: false }));
	sqlite.run('PRAGMA user_version = 0');
	sqlite.close();
}

/** The bytes of the database and whatever sits beside it, as a backup would see them. */
function rawBytes(file = path): string {
	return [file, `${file}-wal`, `${file}-shm`]
		.filter((f) => existsSync(f))
		.map((f) => readFileSync(f).toString('latin1'))
		.join('');
}
const copies = () => readdirSync(dir).filter((f) => f.includes('.pre-migration-'));
const pluginRow = (db: Db) => findPlugin(db, 'echo')!;

describe('sealing a value', () => {
	test('it opens only in the place it was sealed for, and never reads the same twice', () => {
		const a = seal('value', authSettingScope('a'));
		expect(a).not.toContain('value');
		expect(isSealed(a)).toBe(true);
		expect(a).not.toBe(seal('value', authSettingScope('a')));
		expect(readStored(a, authSettingScope('a'))).toBe('value');
		expect(readStored(a, authSettingScope('b'))).toBeNull();
	});

	test('a changed byte does not open', () => {
		const a = seal('value', 's');
		const flipped = a.slice(0, -2) + (a.endsWith('AA') ? 'BB' : 'AA');
		expect(readStored(flipped, 's')).toBeNull();
	});

	test('a value that was never sealed reads as itself', () => {
		expect(readStored('plain', 's')).toBe('plain');
	});
});

describe('the key', () => {
	const posix = process.platform === 'win32' ? test.skip : test;

	test('an instance with no secrets makes no key file', () => {
		const db = openDb(path);
		db.$client.close();
		expect(existsSync(join(dir, KEY_FILE))).toBe(false);
	});

	posix('the file is owner-only whatever the umask, and the data folder hardening covers it', () => {
		const old = process.umask(0o022);
		try {
			seal('value', 's');
			expect(statSync(join(dir, KEY_FILE)).mode & 0o777).toBe(0o600);
			chmodSync(join(dir, KEY_FILE), 0o644);
			hardenDataDir({ umask: false });
			expect(statSync(join(dir, KEY_FILE)).mode & 0o777).toBe(0o600);
		} finally {
			process.umask(old);
		}
	});

	test('a damaged key file is never replaced', () => {
		writeFileSync(join(dir, KEY_FILE), 'short');
		expect(() => seal('value', 's')).toThrow('not a usable secrets key');
		expect(readFileSync(join(dir, KEY_FILE), 'utf8')).toBe('short');
	});

	test('a key too short to trust is refused', () => {
		process.env.OPAL_SECRETS_KEY = 'hunter2';
		expect(() => seal('value', 's')).toThrow('too short');
	});

	test('a key that cannot be saved is an error, never a throwaway key', () => {
		const notAFolder = join(dir, 'a-file');
		writeFileSync(notAFolder, '');
		process.env.OPAL_DATA_DIR = notAFolder;
		expect(() => seal('value', 's')).toThrow();
	});

	test('the variable wins over the file, and is never written to disk', () => {
		process.env.OPAL_SECRETS_KEY = 'a-key-from-the-service-manager-0123456789';
		const sealed = seal('value', 's');
		expect(existsSync(join(dir, KEY_FILE))).toBe(false);
		delete process.env.OPAL_SECRETS_KEY;
		expect(readStored(sealed, 's')).toBeNull();
	});
});

describe('upgrading an rc.24 database', () => {
	test('a copied opal.db holds no plaintext secret, not even an overwritten one', () => {
		rc24Database();
		// These must be in the file to begin with, or the check below proves nothing.
		for (const secret of [OIDC, OLD_OIDC, PLUGIN, LATE]) expect(rawBytes()).toContain(secret);
		const db = openDb(path);
		db.$client.close();
		const bytes = rawBytes();
		for (const secret of [OIDC, OLD_OIDC, PLUGIN, LATE]) expect(bytes).not.toContain(secret);
		// A setting that is not secret stays as it was.
		expect(bytes).toContain('http://visible.test');
	});

	test('the bytes are clean while the server still has the database open', () => {
		rc24Database();
		const db = openDb(path);
		const copied = join(dir, 'copied.db');
		cpSync(path, copied);
		for (const secret of [OIDC, OLD_OIDC, PLUGIN, LATE]) {
			expect(readFileSync(copied).toString('latin1')).not.toContain(secret);
			expect(rawBytes()).not.toContain(secret);
		}
		db.$client.close();
	});

	test('single sign-on and plugins read the same values after the upgrade', () => {
		rc24Database();
		const db = openDb(path);
		const s = readSettings(db);
		expect(s.oidcClientSecret).toBe(OIDC);
		expect(s.oidcClientSecretUnreadable).toBe(false);
		expect(oidcActive(s)).toBe(true);
		const row = pluginRow(db);
		expect(settingValues(db, row)).toEqual({ apiKey: PLUGIN, url: 'http://visible.test', late: LATE });
		expect(missingSettings(sys(db), row)).toEqual([]);
		db.$client.close();
	});

	test('a setting that became secret loses its value from the audit log and gains its flag', () => {
		rc24Database();
		const db = openDb(path);
		const late = db.select().from(pluginSetting).all().find((s) => s.key === 'late')!;
		expect(late.secret).toBe(true);
		expect(JSON.stringify(db.select().from(auditLog).all())).not.toContain(LATE);
		expect(JSON.stringify(db.select().from(auditLog).all())).toContain('[redacted]');
		db.$client.close();
	});

	test('the copy taken before the upgrade keeps its plaintext, as the way back, and is named at each start', () => {
		rc24Database();
		openDb(path).$client.close();
		const [copy] = copies();
		expect(copy).toBeDefined();
		const old = new Database(join(dir, copy!), { readonly: true });
		const row = old.query("SELECT value FROM auth_setting WHERE key = 'oidc_client_secret'").get() as { value: string };
		old.close();
		expect(row.value).toBe(OIDC);

		const warn = spyOn(console, 'warn').mockImplementation(() => {});
		try {
			expect(sweepCopies(path)).toBe(true);
			expect(warn.mock.calls.flat().join(' ')).toContain(copy!);
		} finally {
			warn.mockRestore();
		}
		expect(readFileSync(join(dir, copy!)).toString('latin1')).toContain(OIDC);
	});

	test('the first sealing takes a copy even when no migration is due', () => {
		rc24Database();
		openDb(path).$client.close();
		for (const c of copies()) rmSync(join(dir, c));
		// As if a version that cannot seal wrote one back, on the current schema.
		const raw = new Database(path, { strict: true });
		raw.run('UPDATE auth_setting SET value = ? WHERE key = ?', [OIDC, 'oidc_client_secret']);
		raw.close();
		openDb(path).$client.close();
		expect(copies()).toHaveLength(1);
		expect(rawBytes()).not.toContain(OIDC);
	});

	test('a later start copies nothing and rewrites nothing', () => {
		rc24Database();
		openDb(path).$client.close();
		const before = copies().length;
		const row = () => {
			const raw = new Database(path, { readonly: true });
			const value = (raw.query("SELECT value FROM auth_setting WHERE key = 'oidc_client_secret'").get() as { value: string }).value;
			raw.close();
			return value;
		};
		const first = row();
		openDb(path).$client.close();
		expect(row()).toBe(first);
		expect(copies()).toHaveLength(before);
	});

	test('a copy taken after sealing holds no plaintext', () => {
		rc24Database();
		const db = openDb(path);
		db.$client.run('VACUUM INTO ?', [join(dir, 'later.db')]);
		db.$client.close();
		const bytes = readFileSync(join(dir, 'later.db')).toString('latin1');
		for (const secret of [OIDC, OLD_OIDC, PLUGIN]) expect(bytes).not.toContain(secret);
	});

	test('going back to the old copy and forward again ends up sealed', () => {
		rc24Database();
		openDb(path).$client.close();
		const [copy] = copies();
		for (const f of [path, `${path}-wal`, `${path}-shm`]) rmSync(f, { force: true });
		renameSync(join(dir, copy!), path);
		const db = openDb(path);
		expect(readSettings(db).oidcClientSecret).toBe(OIDC);
		db.$client.close();
		for (const secret of [OIDC, OLD_OIDC, PLUGIN]) expect(rawBytes()).not.toContain(secret);
	});

	test('the check before migrating never stops an upgrade over a schema it does not know', () => {
		const odd = new Database(':memory:');
		odd.run('CREATE TABLE plugin (id INTEGER PRIMARY KEY)');
		odd.run('CREATE TABLE plugin_setting (id INTEGER PRIMARY KEY)');
		expect(holdsPlaintextSecret(odd)).toBe(false);
		odd.close();
	});

	test('a scrub that did not finish runs at the next start', () => {
		rc24Database();
		openDb(path).$client.close();
		// As a failed VACUUM leaves it: rows sealed, old bytes still there, marker clear.
		const raw = new Database(path, { strict: true });
		raw.run('PRAGMA user_version = 0');
		raw.close();
		const db = openDb(path);
		expect((db.$client.query('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(1);
		db.$client.close();
	});
});

describe('a backup restored without its key', () => {
	function lostKey() {
		rc24Database();
		openDb(path).$client.close();
		renameSync(join(dir, KEY_FILE), join(dir, 'kept-key'));
	}

	test('the server starts, the records are there, and each lost secret is named', () => {
		lostKey();
		const error = spyOn(console, 'error').mockImplementation(() => {});
		try {
			const db = openDb(path);
			expect(db.select().from(user).all()).toHaveLength(1);
			const message = error.mock.calls.flat().join(' ');
			expect(message).toContain('oidc_client_secret');
			expect(message).toContain('plugin echo: apiKey');
			db.$client.close();
		} finally {
			error.mockRestore();
		}
	});

	test('nothing makes a new key until a secret is entered again', () => {
		lostKey();
		openDb(path).$client.close();
		expect(existsSync(join(dir, KEY_FILE))).toBe(false);
	});

	test('single sign-on reports the secret as unreadable, and never sends the sealed text', () => {
		lostKey();
		const db = openDb(path);
		const s = readSettings(db);
		expect(s.oidcClientSecret).toBe('');
		expect(s.oidcClientSecretUnreadable).toBe(true);
		db.$client.close();
	});

	test('the variable brings single sign-on back without the key', () => {
		lostKey();
		process.env.OPAL_OIDC_CLIENT_SECRET = 'fresh-from-the-provider';
		const db = openDb(path);
		const s = readSettings(db);
		expect(s.oidcClientSecret).toBe('fresh-from-the-provider');
		expect(s.oidcClientSecretUnreadable).toBe(false);
		db.$client.close();
	});

	test('a plugin gets no sealed text, says what is lost, and counts it as missing', () => {
		lostKey();
		const db = openDb(path);
		const row = pluginRow(db);
		expect(settingValues(db, row)).toEqual({ url: 'http://visible.test' });
		expect(unreadableSettings(db, row).sort()).toEqual(['apiKey', 'late']);
		expect(missingSettings(sys(db), row).map((d) => d.key)).toEqual(['apiKey']);
		const detail = toDetail(db, row).settings.find((s) => s.key === 'apiKey')!;
		expect(detail).toMatchObject({ value: null, set: false, unreadable: true });
		db.$client.close();
	});

	test('entering a secret again works and clears the state', () => {
		lostKey();
		const db = openDb(path);
		writeSetting(sys(db), 'oidc_client_secret', 'entered-again');
		expect(readSettings(db)).toMatchObject({ oidcClientSecret: 'entered-again', oidcClientSecretUnreadable: false });
		const row = pluginRow(db);
		saveSettings(sys(db), row, { apiKey: 'entered-again-too', late: '' });
		expect(settingValues(db, row)).toMatchObject({ apiKey: 'entered-again-too' });
		expect(unreadableSettings(db, row)).toEqual([]);
		db.$client.close();
	});

	test('restoring the key brings everything back', () => {
		lostKey();
		renameSync(join(dir, 'kept-key'), join(dir, KEY_FILE));
		const db = openDb(path);
		expect(readSettings(db).oidcClientSecret).toBe(OIDC);
		expect(settingValues(db, pluginRow(db))).toMatchObject({ apiKey: PLUGIN });
		db.$client.close();
	});
});

describe('rotating the key', () => {
	const sealedSecret = () => {
		const raw = new Database(path, { readonly: true });
		const value = (raw.query("SELECT value FROM auth_setting WHERE key = 'oidc_client_secret'").get() as { value: string }).value;
		raw.close();
		return value;
	};

	test('everything is resealed, the old key is gone, and the values are the same', () => {
		rc24Database();
		openDb(path).$client.close();
		const oldKey = readFileSync(keyFilePath(), 'utf8').trim();
		const oldSealed = sealedSecret();
		expect(rotateSecretsKey()).toBe(true);
		const lines = readFileSync(keyFilePath(), 'utf8').trim().split('\n');
		expect(lines).toHaveLength(1);
		expect(lines[0]).not.toBe(oldKey);
		expect(openSealed(sealedSecret(), authSettingScope('oidc_client_secret'), [oldKey])).toBeNull();
		expect(rawBytes()).not.toContain(oldSealed);
		const db = openDb(path);
		expect(readSettings(db).oidcClientSecret).toBe(OIDC);
		expect(settingValues(db, pluginRow(db))).toMatchObject({ apiKey: PLUGIN, late: LATE });
		db.$client.close();
	});

	test('a copy sealed with the old key is resealed too, and a plaintext copy stays as it is', () => {
		rc24Database();
		const db = openDb(path);
		const later = join(dir, 'opal.pre-migration-2099.db');
		db.$client.run('VACUUM INTO ?', [later]);
		db.$client.close();
		const [plain] = copies().filter((c) => !c.includes('2099'));
		expect(rotateSecretsKey()).toBe(true);
		const copied = new Database(later, { readonly: true });
		const value = (copied.query("SELECT value FROM auth_setting WHERE key = 'oidc_client_secret'").get() as { value: string }).value;
		copied.close();
		expect(readStored(value, authSettingScope('oidc_client_secret'))).toBe(OIDC);
		expect(readFileSync(join(dir, plain!)).toString('latin1')).toContain(OIDC);
	});

	test('a rotation that stopped halfway loses nothing, and running it again finishes', () => {
		rc24Database();
		openDb(path).$client.close();
		addKeyToFile();
		expect(readFileSync(keyFilePath(), 'utf8').trim().split('\n')).toHaveLength(2);
		let db = openDb(path);
		expect(readSettings(db).oidcClientSecret).toBe(OIDC);
		db.$client.close();
		expect(rotateSecretsKey()).toBe(true);
		expect(readFileSync(keyFilePath(), 'utf8').trim().split('\n')).toHaveLength(1);
		db = openDb(path);
		expect(readSettings(db).oidcClientSecret).toBe(OIDC);
		db.$client.close();
	});

	test('with the key in the variable, the old one goes in _PREVIOUS for one start', () => {
		const first = 'first-key-in-the-service-manager-0123456789';
		const second = 'second-key-in-the-service-manager-0123456789';
		process.env.OPAL_SECRETS_KEY = first;
		rc24Database();
		openDb(path).$client.close();
		process.env.OPAL_SECRETS_KEY = second;
		process.env.OPAL_SECRETS_KEY_PREVIOUS = first;
		openDb(path).$client.close();
		delete process.env.OPAL_SECRETS_KEY_PREVIOUS;
		const db = openDb(path);
		expect(readSettings(db).oidcClientSecret).toBe(OIDC);
		db.$client.close();
	});

	test('moving from the file to the variable reseals at the next start', () => {
		rc24Database();
		openDb(path).$client.close();
		process.env.OPAL_SECRETS_KEY = 'a-key-moved-to-the-service-manager-0123456789';
		openDb(path).$client.close();
		rmSync(join(dir, KEY_FILE));
		const db = openDb(path);
		expect(readSettings(db).oidcClientSecret).toBe(OIDC);
		expect(existsSync(join(dir, KEY_FILE))).toBe(false);
		db.$client.close();
	});
});

describe('secrets set by environment variable', () => {
	test('one never reaches the database, and a stored row still wins', () => {
		process.env.OPAL_OIDC_CLIENT_SECRET = 'only-in-the-environment';
		const db = openDb(path);
		expect(readSettings(db).oidcClientSecret).toBe('only-in-the-environment');
		writeSetting(sys(db), 'oidc_issuer', 'https://id.example.com');
		db.$client.close();
		expect(rawBytes()).not.toContain('only-in-the-environment');
		const again = openDb(path);
		writeSetting(sys(again), 'oidc_client_secret', 'typed-in-settings');
		expect(readSettings(again).oidcClientSecret).toBe('typed-in-settings');
		// Cleared means cleared: an empty row still wins, as it always has.
		writeSetting(sys(again), 'oidc_client_secret', '');
		expect(readSettings(again).oidcClientSecret).toBe('');
		again.$client.close();
	});
});

describe('saving a secret', () => {
	test('saving the same value writes nothing and no audit row, and the stored text is sealed', () => {
		const db = openDb(path);
		const ctx = sys(db);
		writeSetting(ctx, 'oidc_client_secret', 'typed-value');
		const count = () => db.select().from(auditLog).all().length;
		const before = count();
		writeSetting(ctx, 'oidc_client_secret', 'typed-value');
		expect(count()).toBe(before);
		db.$client.close();
		expect(rawBytes()).not.toContain('typed-value');
	});

	test('a plugin secret is sealed, and neither its value nor its sealed text reach the audit log', () => {
		const db = openDb(path);
		const ctx = sys(db);
		const u = db.insert(user).values({ username: 'plugin.echo', name: 'Echo', createdAt: ts, updatedAt: ts }).returning().get();
		db.insert(plugin).values({ key: 'echo', source: 'local:/x', sha: 'local', version: '1.0.0', manifest: manifest as never, enabled: false, userId: u.id, createdAt: ts, updatedAt: ts }).run();
		const row = pluginRow(db);
		saveSettings(ctx, row, { apiKey: 'typed-plugin-key', url: 'http://visible.test' });
		const stored = db.select().from(pluginSetting).all().find((s) => s.key === 'apiKey')!;
		expect(isSealed(stored.value)).toBe(true);
		const audit = JSON.stringify(db.select().from(auditLog).all().filter((r) => r.entity === 'plugin_setting'));
		expect(audit).not.toContain('typed-plugin-key');
		expect(audit).not.toContain(stored.value as string);
		const n = db.select().from(auditLog).all().length;
		saveSettings(ctx, row, { apiKey: 'typed-plugin-key' });
		expect(db.select().from(auditLog).all().length).toBe(n);
		expect(toDetail(db, row).settings.find((s) => s.key === 'apiKey')).toMatchObject({ value: null, set: true, unreadable: false });
		db.$client.close();
		expect(rawBytes()).not.toContain('typed-plugin-key');
	});

	test('a text setting that happens to look sealed is only text', () => {
		const db = openDb(path);
		const u = db.insert(user).values({ username: 'plugin.echo', name: 'Echo', createdAt: ts, updatedAt: ts }).returning().get();
		db.insert(plugin).values({ key: 'echo', source: 'local:/x', sha: 'local', version: '1.0.0', manifest: manifest as never, enabled: false, userId: u.id, createdAt: ts, updatedAt: ts }).run();
		const row = pluginRow(db);
		saveSettings(sys(db), row, { url: 'opal-sealed:v1:not-really' });
		expect(settingValues(db, row)).toMatchObject({ url: 'opal-sealed:v1:not-really' });
		expect(unreadableSettings(db, row)).toEqual([]);
		db.$client.close();
	});
});
