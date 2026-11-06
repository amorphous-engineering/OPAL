import { describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { authSecret, rotateAuthSecret } from '../src/auth/signing.ts';
import { hardenDataDir } from '../src/harden.ts';

const mode = (p: string) => statSync(p).mode & 0o777;
const posix = process.platform === 'win32' ? test.skip : test;

describe('data folder permissions', () => {
	posix('the data folder is created owner-only and new files in it are owner-only', () => {
		const old = process.umask();
		const dir = join(mkdtempSync(join(tmpdir(), 'opal-harden-')), 'data');
		process.env.OPAL_DATA_DIR = dir;
		try {
			hardenDataDir();
			expect(mode(dir)).toBe(0o700);
			writeFileSync(join(dir, 'opal.db'), 'x');
			mkdirSync(join(dir, 'blobs'));
			expect(mode(join(dir, 'opal.db'))).toBe(0o600);
			expect(mode(join(dir, 'blobs'))).toBe(0o700);
		} finally {
			process.umask(old);
		}
	});

	posix('an existing folder and its database files are tightened, keeping the owner bits', () => {
		const old = process.umask();
		const dir = mkdtempSync(join(tmpdir(), 'opal-harden-'));
		process.env.OPAL_DATA_DIR = dir;
		delete process.env.OPAL_DB_FILE;
		try {
			chmodSync(dir, 0o775);
			for (const [f, m] of [['opal.db', 0o644], ['opal.db-wal', 0o644], ['opal.db-shm', 0o644], ['opal.legacy.db', 0o664]] as const) {
				writeFileSync(join(dir, f), 'x');
				chmodSync(join(dir, f), m);
			}
			mkdirSync(join(dir, 'blobs'));
			chmodSync(join(dir, 'blobs'), 0o775);
			hardenDataDir();
			// The folder existed, so it may be shared; what OPAL keeps inside is what gets tightened.
			expect(mode(dir)).toBe(0o775);
			for (const f of ['opal.db', 'opal.db-wal', 'opal.db-shm', 'opal.legacy.db']) expect(mode(join(dir, f))).toBe(0o600);
			expect(mode(join(dir, 'blobs'))).toBe(0o700);
		} finally {
			process.umask(old);
		}
	});

	posix('another program\'s files and links in a shared folder are left alone', () => {
		const old = process.umask();
		const base = mkdtempSync(join(tmpdir(), 'opal-harden-'));
		const dir = join(base, 'shared');
		mkdirSync(dir);
		const nas = join(base, 'nas-blobs');
		mkdirSync(nas);
		chmodSync(nas, 0o775);
		process.env.OPAL_DATA_DIR = dir;
		delete process.env.OPAL_DB_FILE;
		try {
			writeFileSync(join(dir, 'backup-notes.txt'), 'x');
			chmodSync(join(dir, 'backup-notes.txt'), 0o664);
			symlinkSync(nas, join(dir, 'blobs'));
			hardenDataDir();
			expect(mode(join(dir, 'backup-notes.txt'))).toBe(0o664);
			expect(mode(nas)).toBe(0o775);
		} finally {
			process.umask(old);
		}
	});

	posix('the supervisor keeps its umask, so an update keeps the mode of the binary it replaces', () => {
		const old = process.umask(0o022);
		process.env.OPAL_DATA_DIR = mkdtempSync(join(tmpdir(), 'opal-harden-'));
		try {
			hardenDataDir({ umask: false });
			expect(process.umask()).toBe(0o022);
		} finally {
			process.umask(old);
		}
	});

	posix('a database under another name in the data folder is tightened too', () => {
		const old = process.umask();
		const dir = mkdtempSync(join(tmpdir(), 'opal-harden-'));
		process.env.OPAL_DATA_DIR = dir;
		process.env.OPAL_DB_FILE = join(dir, 'custom.db');
		try {
			writeFileSync(process.env.OPAL_DB_FILE, 'x');
			chmodSync(process.env.OPAL_DB_FILE, 0o644);
			hardenDataDir();
			expect(mode(process.env.OPAL_DB_FILE)).toBe(0o600);
		} finally {
			delete process.env.OPAL_DB_FILE;
			process.umask(old);
		}
	});

	posix('the auth secret file is created with mode 0600 whatever the umask', () => {
		const dir = mkdtempSync(join(tmpdir(), 'opal-harden-'));
		process.env.OPAL_DATA_DIR = dir;
		delete process.env.OPAL_AUTH_SECRET;
		const old = process.umask(0o022);
		try {
			rotateAuthSecret();
			authSecret();
			expect(mode(join(dir, '.opal_auth_secret'))).toBe(0o600);
		} finally {
			process.umask(old);
			rotateAuthSecret();
		}
	});
});
