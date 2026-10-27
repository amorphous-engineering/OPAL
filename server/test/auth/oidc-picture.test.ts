import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { user, userProfile } from '../../src/db/schema/index.ts';
import { beginOidc, configureOidc, cookieOf, fakeProvider, type FakeProvider, harness, type Harness } from './helpers.ts';

// A 1x1 PNG, and a GIF header.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const GIF = Buffer.from('R0lGODlhAQABAAAAACw=', 'base64');

let p: FakeProvider;
let dir: string;
beforeAll(async () => {
	p = await fakeProvider();
	dir = mkdtempSync(join(tmpdir(), 'opal-oidc-picture-'));
	process.env.OPAL_DATA_DIR = dir;
});
afterAll(() => p.stop());

const signInWithPicture = async (h: Harness, picture: string | undefined) => {
	const { query, cookie } = await beginOidc(h);
	p.userinfo = null;
	p.tokens = { id_token: await p.idToken({ sub: 'pic-1', email: 'pic@example.test', picture }, { nonce: query.get('nonce')! }) };
	const res = await h.raw(`/oidc/callback?code=c&state=${query.get('state')}`, { cookie });
	expect(res.status).toBe(302);
	return cookieOf(res, 'opal_session');
};
const profileOf = (h: Harness) => {
	const u = h.db.select().from(user).where(eq(user.oidcSubject, 'pic-1')).get()!;
	return { id: u.id, profile: h.db.select().from(userProfile).where(eq(userProfile.userId, u.id)).get() };
};

describe('oidc picture', () => {
	test('sign-in copies the provider picture and the avatar route serves it', async () => {
		const h = await harness();
		configureOidc(h, p);
		p.picture = { type: 'image/png', body: PNG };
		const session = await signInWithPicture(h, `${p.issuer}/picture`);
		const { id, profile } = profileOf(h);
		expect(profile?.avatarSource).toBe('oidc');
		expect(profile?.avatarMime).toBe('image/png');
		const res = await h.raw(`/api/users/${id}/avatar`, { cookie: session });
		expect(res.status).toBe(200);
		expect(Buffer.from(await res.arrayBuffer()).equals(PNG)).toBe(true);
	});

	test('a later sign-in takes a changed provider picture', async () => {
		const h = await harness();
		configureOidc(h, p);
		p.picture = { type: 'image/png', body: PNG };
		await signInWithPicture(h, `${p.issuer}/picture`);
		const first = profileOf(h).profile!.avatarHash;
		p.picture = { type: 'image/gif', body: GIF };
		await signInWithPicture(h, `${p.issuer}/picture`);
		const after = profileOf(h).profile!;
		expect(after.avatarHash).not.toBe(first);
		expect(after.avatarMime).toBe('image/gif');
		expect(readdirSync(join(dir, 'avatars'))).not.toContain(first);
	});

	test('an uploaded photo is never replaced by the provider picture', async () => {
		const h = await harness();
		configureOidc(h, p);
		p.picture = { type: 'image/png', body: PNG };
		const session = await signInWithPicture(h, `${p.issuer}/picture`);
		const { id } = profileOf(h);
		const up = await h.call('POST', `/users/${id}/avatar`, { data: GIF.toString('base64') }, { cookie: session, origin: 'http://opal.test' });
		expect(up.status).toBe(200);
		await signInWithPicture(h, `${p.issuer}/picture`);
		expect(profileOf(h).profile).toMatchObject({ avatarSource: 'upload', avatarMime: 'image/gif' });
	});

	test('a removed photo is not refilled by the provider picture', async () => {
		const h = await harness();
		configureOidc(h, p);
		p.picture = { type: 'image/png', body: PNG };
		const session = await signInWithPicture(h, `${p.issuer}/picture`);
		const { id } = profileOf(h);
		expect((await h.call('DELETE', `/users/${id}/avatar`, undefined, { cookie: session, origin: 'http://opal.test' })).status).toBe(200);
		await signInWithPicture(h, `${p.issuer}/picture`);
		expect(profileOf(h).profile).toMatchObject({ avatarSource: 'removed', avatarHash: null });
	});

	test('a picture that is not an image, or not on https, leaves sign-in working and the avatar empty', async () => {
		const h = await harness();
		configureOidc(h, p);
		p.picture = { type: 'text/html', body: Buffer.from('<html>') };
		await signInWithPicture(h, `${p.issuer}/picture`);
		expect(profileOf(h).profile?.avatarHash ?? null).toBeNull();
		p.picture = { type: 'image/png', body: Buffer.from('not a png') };
		await signInWithPicture(h, `${p.issuer}/picture`);
		expect(profileOf(h).profile?.avatarHash ?? null).toBeNull();
		await signInWithPicture(h, 'http://example.test/me.png');
		expect(profileOf(h).profile?.avatarHash ?? null).toBeNull();
	});
});
