import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { mountAvatarRoute } from '../../src/services/org/avatars.ts';
import { setup } from './helpers.ts';

// A 1x1 PNG, and a GIF header.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const GIF = Buffer.from('R0lGODlhAQABAAAAACw=', 'base64');

function dataDir() {
	const dir = mkdtempSync(join(tmpdir(), 'opal-org-'));
	process.env.OPAL_DATA_DIR = dir;
	return dir;
}

describe('avatars', () => {
	test('an upload is stored by content hash, shown as a versioned url and served to signed-in users', async () => {
		const dir = dataDir();
		const { db, call, makeUser } = await setup();
		const bob = makeUser('bob');
		const eve = makeUser('eve');
		const r = await call(bob, 'POST', `/users/${bob.id}/avatar`, { data: PNG.toString('base64') });
		expect(r.status).toBe(200);
		expect(r.json.avatarUrl).toMatch(new RegExp(`^/api/users/${bob.id}/avatar\\?v=\\d+$`));
		expect(readdirSync(join(dir, 'avatars'))).toHaveLength(1);
		expect((await call(eve, 'GET', `/users/${bob.id}`)).status).toBe(403);
		expect((await call(makeUser('root', { admin: true }), 'GET', '/users/directory')).json.find((u: any) => u.id === bob.id).avatarUrl).toBe(r.json.avatarUrl);

		let current = bob.actor;
		const app = new Hono();
		mountAvatarRoute(app, db, () => current);
		const res = await app.request(`/api/users/${bob.id}/avatar`);
		expect(res.status).toBe(200);
		expect(res.headers.get('content-type')).toBe('image/png');
		expect(res.headers.get('x-content-type-options')).toBe('nosniff');
		expect(Buffer.from(await res.arrayBuffer()).equals(PNG)).toBe(true);
		current = { kind: 'anonymous' };
		expect((await app.request(`/api/users/${bob.id}/avatar`)).status).toBe(401);
	});

	test('a user changes own avatar, an admin changes any, nobody else does', async () => {
		dataDir();
		const { call, makeUser } = await setup();
		const admin = makeUser('root', { admin: true });
		const bob = makeUser('bob');
		const eve = makeUser('eve');
		const body = { data: PNG.toString('base64') };
		expect((await call(eve, 'POST', `/users/${bob.id}/avatar`, body)).status).toBe(403);
		expect((await call(admin, 'POST', `/users/${bob.id}/avatar`, body)).status).toBe(200);
		expect((await call(eve, 'DELETE', `/users/${bob.id}/avatar`)).status).toBe(403);
	});

	test('a file that is not a PNG, JPEG, WebP or GIF image is refused', async () => {
		dataDir();
		const { call, makeUser } = await setup();
		const bob = makeUser('bob');
		const r = await call(bob, 'POST', `/users/${bob.id}/avatar`, { data: Buffer.from('<svg/>').toString('base64') });
		expect(r.status).toBe(400);
		expect((await call(bob, 'POST', `/users/${bob.id}/avatar`, { data: GIF.toString('base64') })).status).toBe(200);
	});

	test('a file over 2 MB is refused', async () => {
		dataDir();
		const { call, makeUser } = await setup();
		const bob = makeUser('bob');
		const big = Buffer.concat([PNG.subarray(0, 8), Buffer.alloc(2 * 1024 * 1024 + 1)]);
		expect((await call(bob, 'POST', `/users/${bob.id}/avatar`, { data: big.toString('base64') })).status).toBe(413);
	});

	test('removing the avatar deletes the file and shows initials; a shared file stays while another user holds it', async () => {
		const dir = dataDir();
		const { call, makeUser } = await setup();
		const a = makeUser('a');
		const b = makeUser('b');
		const body = { data: PNG.toString('base64') };
		await call(a, 'POST', `/users/${a.id}/avatar`, body);
		await call(b, 'POST', `/users/${b.id}/avatar`, body);
		expect(readdirSync(join(dir, 'avatars'))).toHaveLength(1);
		expect((await call(a, 'DELETE', `/users/${a.id}/avatar`)).json.avatarUrl).toBeNull();
		expect(readdirSync(join(dir, 'avatars'))).toHaveLength(1);
		await call(b, 'DELETE', `/users/${b.id}/avatar`);
		expect(readdirSync(join(dir, 'avatars'))).toHaveLength(0);
	});

	test('replacing the avatar removes the old file', async () => {
		const dir = dataDir();
		const { call, makeUser } = await setup();
		const a = makeUser('a');
		await call(a, 'POST', `/users/${a.id}/avatar`, { data: PNG.toString('base64') });
		await call(a, 'POST', `/users/${a.id}/avatar`, { data: GIF.toString('base64') });
		expect(readdirSync(join(dir, 'avatars'))).toHaveLength(1);
	});
});

describe('settings', () => {
	test('system facts are open to signed-in users', async () => {
		const { call, makeUser } = await setup();
		const r = await call(makeUser('bob'), 'GET', '/settings/system');
		expect(r.status).toBe(200);
		expect(r.json.runtime).toStartWith('Bun');
		expect((await call(null, 'GET', '/settings/system')).status).toBe(401);
	});

	test('agent activation is off by default, on records the acting admin, and only an admin sets it', async () => {
		const { call, makeUser } = await setup();
		const admin = makeUser('root', { admin: true });
		const bob = makeUser('bob');
		expect((await call(bob, 'GET', '/settings/agent-activation')).json).toEqual({ enabled: false, authorizedBy: null });
		expect((await call(bob, 'PUT', '/settings/agent-activation', { enabled: true })).status).toBe(403);
		expect((await call(admin, 'PUT', '/settings/agent-activation', { enabled: true })).json).toEqual({ enabled: true, authorizedBy: 'root' });
		expect((await call(admin, 'PUT', '/settings/agent-activation', { enabled: false })).json.enabled).toBe(false);
	});

	test('an API token cannot switch agent activation', async () => {
		const { call, makeUser } = await setup();
		const admin = makeUser('root', { admin: true });
		const token = { kind: 'token' as const, userId: admin.id, isAdmin: true, tokenId: 1 };
		expect((await call(token, 'PUT', '/settings/agent-activation', { enabled: true })).status).toBe(403);
	});
});
