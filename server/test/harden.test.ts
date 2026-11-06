import { describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, statSync, writeFileSync } from 'node:fs';
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
			expect(mode(dir)).toBe(0o700);
			for (const f of ['opal.db', 'opal.db-wal', 'opal.db-shm', 'opal.legacy.db']) expect(mode(join(dir, f))).toBe(0o600);
			expect(mode(join(dir, 'blobs'))).toBe(0o700);
		} finally {
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
