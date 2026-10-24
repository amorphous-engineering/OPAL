import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { now } from '@opal/shared';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../../src/app.ts';
import type { Actor } from '../../src/context.ts';
import { openSchemaDb } from '../../src/db/dev-schema.ts';
import { part, user } from '../../src/db/schema/index.ts';
import { serialized } from '../../src/registry.ts';
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

describe('factory reset', () => {
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
});
