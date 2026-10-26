import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { now } from '@opal/shared';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../../src/app.ts';
import type { Actor } from '../../src/context.ts';
import { openSchemaDb } from '../../src/db/dev-schema.ts';
import { auditLog, part, user } from '../../src/db/schema/index.ts';
import { serialized } from '../../src/registry.ts';
import { writeSetting } from '../../src/services/auth/settings.ts';
import { forgetLifecycle } from '../../src/services/reports/lifecycle.ts';

let dir: string;
const saved = { d: process.env.OPAL_DATA_DIR, f: process.env.OPAL_DB_FILE, s: process.env.OPAL_DEV_SCHEMA };

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'opal-life-'));
	process.env.OPAL_DATA_DIR = dir;
	delete process.env.OPAL_DB_FILE;
	process.env.OPAL_DEV_SCHEMA = '1';
});
afterEach(() => {
	for (const [k, v] of [['OPAL_DATA_DIR', saved.d], ['OPAL_DB_FILE', saved.f], ['OPAL_DEV_SCHEMA', saved.s]] as const) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
	rmSync(dir, { recursive: true, force: true });
});

async function boot(admin = true) {
	const db = await openSchemaDb(join(dir, 'opal.db'));
	forgetLifecycle(db);
	const ts = now();
	const op = db.insert(user).values({ username: 'ada', name: 'Ada', email: 'ada@x.test', passwordHash: 'h', isAdmin: admin, createdAt: ts, updatedAt: ts }).returning().get();
	db.insert(part).values({ internalPn: 'R-1', name: 'Real Part', unitOfMeasure: 'ea', trackingType: 'bulk', procurement: 'buy', tier: 3, createdAt: ts, updatedAt: ts }).run();
	const actor: Actor = { kind: 'user', userId: op.id, isAdmin: admin, sessionId: 1 };
	const app = createApp({ db, resolveActor: () => actor });
	const call = async (method: string, path: string, body?: unknown) => {
		const res = await app.request(`/api${path}`, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
		return { status: res.status, body: (await res.json().catch(() => null)) as any, res };
	};
	// The switch runs in the write queue after the request: wait for it.
	const settled = () => serialized(async () => undefined);
	return { db, call, settled, op };
}

const parts = (db: Awaited<ReturnType<typeof boot>>['db']) => db.select().from(part).all().map((p) => p.name);

describe('demo database', () => {
	test('entering switches to a separate file with its own attachments folder; the real file is untouched', async () => {
		const t = await boot();
		const r = await t.call('POST', '/settings/demo/enter');
		expect(r.status).toBe(200);
		expect(r.body.demoActive).toBe(true);
		await t.settled();
		expect(existsSync(join(dir, 'demo.opal.db'))).toBe(true);
		expect(process.env.OPAL_DATA_DIR).toBe(join(dir, 'demo.opal.db-attachments'));
		expect(parts(t.db)).not.toContain('Real Part');
		expect((await t.call('GET', '/settings/lifecycle')).body.demoActive).toBe(true);
	});

	test('the operator is an active admin of the demo and keeps a session through the cookie', async () => {
		const t = await boot();
		const r = await t.call('POST', '/settings/demo/enter');
		expect(r.res.headers.get('set-cookie')).toContain('opal_session=');
		await t.settled();
		const ada = t.db.select().from(user).all().find((u) => u.email === 'ada@x.test')!;
		expect(ada.isAdmin).toBe(true);
	});

	test('exiting restores the real database and attachments folder and deletes the demo files', async () => {
		const t = await boot();
		await t.call('POST', '/settings/demo/enter');
		await t.settled();
		writeFileSync(join(process.env.OPAL_DATA_DIR!, 'marker'), 'x');
		const r = await t.call('POST', '/settings/demo/exit');
		expect(r.body.demoActive).toBe(false);
		await t.settled();
		expect(parts(t.db)).toContain('Real Part');
		expect(process.env.OPAL_DATA_DIR).toBe(dir);
		expect(existsSync(join(dir, 'demo.opal.db'))).toBe(false);
		expect(existsSync(join(dir, 'demo.opal.db-attachments'))).toBe(false);
	});

	test('a demo that was not deleted resumes with its content', async () => {
		const t = await boot();
		await t.call('POST', '/settings/demo/enter');
		await t.settled();
		const ts = now();
		t.db.insert(part).values({ internalPn: 'D-1', name: 'Demo Scratch', unitOfMeasure: 'ea', trackingType: 'bulk', procurement: 'buy', tier: 3, createdAt: ts, updatedAt: ts }).run();
		// Exit without deleting is not exposed over HTTP; the file stays until deleted.
		const { exitDemo } = await import('../../src/services/reports/lifecycle.ts');
		await exitDemo({ db: t.db, actor: { kind: 'system' }, op: 't' }, false);
		await t.settled();
		expect(existsSync(join(dir, 'demo.opal.db'))).toBe(true);
		await t.call('POST', '/settings/demo/enter');
		await t.settled();
		expect(parts(t.db)).toContain('Demo Scratch');
	});

	test('the demo database stores numbers at full width and the API shows the display width', async () => {
		const t = await boot();
		await t.call('POST', '/settings/demo/enter');
		await t.settled();
		const stored = t.db.$client.query('SELECT opal_number AS n FROM stock_record').all() as { n: string }[];
		expect(stored.length).toBeGreaterThan(0);
		for (const r of stored) expect(r.n).toMatch(/^OPAL-\d{10}$/);
		const pns = t.db.$client.query('SELECT internal_pn AS n FROM part').all() as { n: string }[];
		expect(pns.some((p) => /\d{10}$/.test(p.n))).toBe(true);
		const list = await t.call('GET', '/inventory');
		expect(list.status).toBe(200);
		const shown = JSON.stringify(list.body);
		expect(shown).toMatch(/OPAL-\d{4}\b/);
		expect(shown).not.toMatch(/OPAL-\d{10}/);
		expect(shown).not.toMatch(/\d{10}/);
	});

	test('a demo file that exists but is empty is built on entry', async () => {
		const t = await boot();
		writeFileSync(join(dir, 'demo.opal.db'), '');
		const r = await t.call('POST', '/settings/demo/enter');
		expect(r.status).toBe(200);
	});

	test('deleting the demo file is refused while it is active and works when it is not', async () => {
		const t = await boot();
		await t.call('POST', '/settings/demo/enter');
		await t.settled();
		expect((await t.call('DELETE', '/settings/demo')).status).toBe(409);
		const { exitDemo } = await import('../../src/services/reports/lifecycle.ts');
		await exitDemo({ db: t.db, actor: { kind: 'system' }, op: 't' }, false);
		await t.settled();
		const r = await t.call('DELETE', '/settings/demo');
		expect(r.body.demoFileExists).toBe(false);
	});

	test('only admins may switch to the demo', async () => {
		const t = await boot(false);
		expect((await t.call('POST', '/settings/demo/enter')).status).toBe(403);
		expect((await t.call('GET', '/settings/lifecycle')).status).toBe(200);
	});
});

describe('demo sign-in', () => {
	test('the public seed credentials do not sign in while the demo is active', async () => {
		const t = await boot();
		await t.call('POST', '/settings/demo/enter');
		await t.settled();
		const r = await t.call('POST', '/auth/login', { username: 'build', password: 'kestrel-demo' });
		expect(r.status).toBe(401);
		expect(r.res.headers.get('set-cookie')).toBeNull();
		const others = t.db.select().from(user).all().filter((u) => u.email !== 'ada@x.test');
		expect(others.length).toBeGreaterThan(0);
		for (const u of others) {
			expect(u.passwordHash).toBeNull();
			expect(u.isAdmin).toBe(false);
		}
	});

	test('the operator is the only admin of the demo', async () => {
		const t = await boot();
		await t.call('POST', '/settings/demo/enter');
		await t.settled();
		const admins = t.db.select().from(user).all().filter((u) => u.isAdmin);
		expect(admins.map((u) => u.email)).toEqual(['ada@x.test']);
		expect(admins[0]!.passwordHash).toBe('h');
	});

	test('the demo audit log never holds the real OIDC client secret', async () => {
		const t = await boot();
		writeSetting({ db: t.db, actor: { kind: 'system' }, op: 't' } as any, 'oidc_client_secret', 'real-oidc-secret-value');
		await t.call('POST', '/settings/demo/enter');
		await t.settled();
		expect(JSON.stringify(t.db.select().from(auditLog).all())).not.toContain('real-oidc-secret-value');
	});

	test('plugins cannot be installed or enabled while the demo is active', async () => {
		const t = await boot();
		await t.call('POST', '/settings/demo/enter');
		await t.settled();
		const r = await t.call('POST', '/plugins/install', { source: 'owner/repo', sha: 'local' });
		expect(r.status).toBe(409);
		expect(r.body.message).toBe('Exit the demo before installing a plugin.');
	});
});

describe('factory reset', () => {
	test('it is refused while the demo is active and the real database survives', async () => {
		const t = await boot();
		mkdirSync(join(dir, 'blobs'));
		writeFileSync(join(dir, 'blobs', 'abc'), 'x');
		await t.call('POST', '/settings/demo/enter');
		await t.settled();
		const r = await t.call('POST', '/settings/factory-reset', { confirm: 'RESET' });
		expect(r.status).toBe(409);
		expect(r.body.message).toBe('Exit the demo before a factory reset.');
		await t.settled();
		expect(existsSync(join(dir, 'opal.db'))).toBe(true);
		expect(existsSync(join(dir, 'blobs', 'abc'))).toBe(true);
		expect(existsSync(join(dir, 'demo.opal.db'))).toBe(true);
	});

	test('it needs the word RESET', async () => {
		const t = await boot();
		expect((await t.call('POST', '/settings/factory-reset', { confirm: 'nope' })).status).toBe(422);
		expect(parts(t.db)).toContain('Real Part');
	});

	test('it erases data, attachments and the demo, and leaves a usable empty database', async () => {
		const t = await boot();
		mkdirSync(join(dir, 'blobs'));
		writeFileSync(join(dir, 'blobs', 'abc'), 'x');
		await t.call('POST', '/settings/demo/enter');
		await t.settled();
		const { exitDemo } = await import('../../src/services/reports/lifecycle.ts');
		await exitDemo({ db: t.db, actor: { kind: 'system' }, op: 't' }, false);
		await t.settled();
		const r = await t.call('POST', '/settings/factory-reset', { confirm: ' RESET ' });
		expect(r.status).toBe(200);
		await t.settled();
		expect(parts(t.db)).toEqual([]);
		expect(t.db.select().from(user).all()).toEqual([]);
		expect(existsSync(join(dir, 'blobs'))).toBe(false);
		expect(existsSync(join(dir, 'demo.opal.db'))).toBe(false);
		expect(process.env.OPAL_DATA_DIR).toBe(dir);
		const ts = now();
		t.db.insert(part).values({ internalPn: 'P-1', name: 'Phoenix', unitOfMeasure: 'ea', trackingType: 'bulk', procurement: 'buy', tier: 3, createdAt: ts, updatedAt: ts }).run();
		expect(parts(t.db)).toEqual(['Phoenix']);
	});

	test('a factory reset invalidates signed links from before it', async () => {
		const t = await boot();
		const { signPayload, verifyPayload } = await import('../../src/auth/signing.ts');
		// Other test files pin OPAL_AUTH_SECRET; the file-based secret is the one a reset rotates.
		const pinned = process.env.OPAL_AUTH_SECRET;
		delete process.env.OPAL_AUTH_SECRET;
		try {
			const token = signPayload({ kind: 'account-claim', uid: 1 }, 60_000);
			expect(verifyPayload(token)).not.toBeNull();
			expect((await t.call('POST', '/settings/factory-reset', { confirm: 'RESET' })).status).toBe(200);
			await t.settled();
			expect(verifyPayload(token)).toBeNull();
			expect(verifyPayload(signPayload({ kind: 'x' }))).not.toBeNull();
		} finally {
			if (pinned) process.env.OPAL_AUTH_SECRET = pinned;
		}
	});
});
