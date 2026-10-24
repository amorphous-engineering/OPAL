import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { auditLog } from '../../src/db/schema/index.ts';
import { authSetting } from '../../src/db/schema/auth.ts';
import { readSettings } from '../../src/services/auth/settings.ts';
import { adminSession, fakeProvider, type FakeProvider, harness, makeUser, signIn } from './helpers.ts';
import { hashPassword } from '../../src/auth/tokens.ts';

const body = (over: Record<string, unknown> = {}) => ({
	passwordLoginEnabled: true,
	passkeysEnabled: true,
	...over
});

let p: FakeProvider;
beforeAll(async () => {
	p = await fakeProvider();
});
afterAll(() => p.stop());

describe('sign-in settings', () => {
	test('only an admin reads or changes them', async () => {
		const h = await harness();
		await adminSession(h);
		makeUser(h, { username: 'bea', passwordHash: await hashPassword('bea-password-1') });
		const bea = await signIn(h, 'bea', 'bea-password-1');
		expect((await h.call('GET', '/settings/auth', undefined, { cookie: bea })).status).toBe(403);
		expect((await h.call('PUT', '/settings/auth', body(), { cookie: bea })).status).toBe(403);
		expect((await h.call('POST', '/settings/auth/test', {}, { cookie: bea })).status).toBe(403);
		expect((await h.call('GET', '/settings/auth')).status).toBe(401);
	});

	test('an API token cannot change sign-in settings', async () => {
		const h = await harness();
		const cookie = await adminSession(h);
		const { token } = await (await h.call('POST', '/auth/tokens', { name: 'ci' }, { cookie })).json();
		const bearer = { authorization: `Bearer ${token}` };
		expect((await h.call('GET', '/settings/auth', undefined, bearer)).status).toBe(200);
		expect((await h.call('PUT', '/settings/auth', body(), bearer)).status).toBe(403);
	});

	test('settings round trip without echoing the client secret', async () => {
		const h = await harness();
		const cookie = await adminSession(h);
		const res = await h.call(
			'PUT',
			'/settings/auth',
			body({
				passkeysEnabled: false,
				oidcEnabled: true,
				oidcIssuer: 'https://id.example.com/',
				oidcClientId: 'opal',
				oidcClientSecret: 's3cret',
				oidcProviderName: 'Pocket ID',
				oidcRedirectBaseUrl: 'https://opal.example.com/'
			}),
			{ cookie }
		);
		expect(res.status).toBe(200);
		const text = await res.text();
		expect(text).not.toContain('s3cret');
		const saved = JSON.parse(text);
		expect(saved.oidcIssuer).toBe('https://id.example.com');
		expect(saved.hasClientSecret).toBe(true);
		expect(saved.passkeysEnabled).toBe(false);
		expect(saved.callbackUrl).toBe('https://opal.example.com/oidc/callback');
		expect(JSON.stringify(await (await h.call('GET', '/settings/auth', undefined, { cookie })).json())).not.toContain('s3cret');
	});

	test('a blank secret keeps the stored one and the clear flag removes it', async () => {
		const h = await harness();
		const cookie = await adminSession(h);
		const put = (extra: Record<string, unknown>) =>
			h.call('PUT', '/settings/auth', body({ oidcEnabled: true, oidcIssuer: 'https://id.example.com', oidcClientId: 'opal', ...extra }), { cookie });
		await put({ oidcClientSecret: 's3cret' });
		expect((await (await put({})).json()).hasClientSecret).toBe(true);
		expect((await (await put({ clearClientSecret: true })).json()).hasClientSecret).toBe(false);
		expect(readSettings(h.db).oidcClientSecret).toBe('');
	});

	test('the client secret never reaches the audit log', async () => {
		const h = await harness();
		const cookie = await adminSession(h);
		await h.call(
			'PUT',
			'/settings/auth',
			body({ oidcEnabled: true, oidcIssuer: 'https://id.example.com', oidcClientId: 'opal', oidcClientSecret: 'topsecret-value' }),
			{ cookie }
		);
		await h.call(
			'PUT',
			'/settings/auth',
			body({ oidcEnabled: true, oidcIssuer: 'https://id.example.com', oidcClientId: 'opal', oidcClientSecret: 'another-secret-value' }),
			{ cookie }
		);
		const rows = h.db.select().from(auditLog).all().filter((r) => r.entity === 'auth_setting');
		expect(rows.length).toBeGreaterThan(5);
		const text = JSON.stringify(rows);
		expect(text).not.toContain('topsecret-value');
		expect(text).not.toContain('another-secret-value');
		expect(text).toContain('[redacted]');
		expect(rows.every((r) => r.op === 'auth.settings.update')).toBe(true);
	});

	const unsafe: [string, Record<string, unknown>, string][] = [
		['enabling OIDC needs an issuer and a client id', { oidcEnabled: true }, 'issuer URL and client id'],
		['an http issuer is refused', { oidcEnabled: true, oidcIssuer: 'http://evil.example', oidcClientId: 'x' }, 'https://'],
		[
			'scopes must include openid',
			{ oidcEnabled: true, oidcIssuer: 'https://id.example.com', oidcClientId: 'x', oidcScopes: 'profile' },
			'openid'
		],
		['password sign-in cannot be switched off without OIDC', { passwordLoginEnabled: false }, 'Disabling password sign-in'],
		[
			'password sign-in cannot be switched off while OIDC is configured but off',
			{ passwordLoginEnabled: false, oidcEnabled: false, oidcIssuer: 'https://id.example.com' },
			'Disabling password sign-in'
		]
	];
	for (const [name, over, fragment] of unsafe) {
		test(`refused: ${name}`, async () => {
			const h = await harness();
			const cookie = await adminSession(h);
			const res = await h.call('PUT', '/settings/auth', body(over), { cookie });
			expect(res.status).toBe(422);
			expect(Object.values((await res.json()).fields).join(' ')).toContain(fragment);
			expect(h.db.select().from(authSetting).all()).toHaveLength(0);
		});
	}

	test('password sign-in can be switched off once OIDC is on', async () => {
		const h = await harness();
		const cookie = await adminSession(h);
		const res = await h.call(
			'PUT',
			'/settings/auth',
			body({ passwordLoginEnabled: false, oidcEnabled: true, oidcIssuer: 'https://id.example.com', oidcClientId: 'opal' }),
			{ cookie }
		);
		expect(res.status).toBe(200);
		const cfg = await (await h.call('GET', '/auth/config')).json();
		expect(cfg).toEqual({
			needsSetup: false,
			passwordLoginEnabled: false,
			passkeysEnabled: true,
			oidcEnabled: true,
			oidcProviderName: 'SSO'
		});
		expect((await h.call('POST', '/auth/login', { username: 'abby', password: 'correct-horse-battery' })).status).toBe(403);
	});

	test('each method toggles on its own', async () => {
		const h = await harness();
		const cookie = await adminSession(h);
		await h.call('PUT', '/settings/auth', body({ passkeysEnabled: false }), { cookie });
		let cfg = await (await h.call('GET', '/auth/config')).json();
		expect([cfg.passwordLoginEnabled, cfg.passkeysEnabled, cfg.oidcEnabled]).toEqual([true, false, false]);
		await h.call('PUT', '/settings/auth', body({ passkeysEnabled: true }), { cookie });
		cfg = await (await h.call('GET', '/auth/config')).json();
		expect([cfg.passwordLoginEnabled, cfg.passkeysEnabled, cfg.oidcEnabled]).toEqual([true, true, false]);
	});

	test('the environment seeds a setting that was never saved; a saved value wins', async () => {
		const h = await harness();
		process.env.OPAL_OIDC_ISSUER = 'https://env.example.com';
		process.env.OPAL_OIDC_CLIENT_ID = 'env-client';
		process.env.OPAL_OIDC_ENABLED = 'true';
		process.env.OPAL_OIDC_ADMIN_GROUP = 'env-admins';
		try {
			let s = readSettings(h.db);
			expect([s.oidcEnabled, s.oidcIssuer, s.oidcClientId, s.oidcAdminGroup]).toEqual([true, 'https://env.example.com', 'env-client', 'env-admins']);
			expect((await (await h.call('GET', '/auth/config')).json()).oidcEnabled).toBe(true);
			const cookie = await adminSession(h);
			await h.call(
				'PUT',
				'/settings/auth',
				body({ oidcEnabled: true, oidcIssuer: 'https://saved.example.com', oidcClientId: 'saved-client' }),
				{ cookie }
			);
			s = readSettings(h.db);
			expect([s.oidcIssuer, s.oidcClientId]).toEqual(['https://saved.example.com', 'saved-client']);
		} finally {
			for (const k of ['ISSUER', 'CLIENT_ID', 'ENABLED', 'ADMIN_GROUP']) delete process.env[`OPAL_OIDC_${k}`];
		}
	});

	test('the defaults match legacy', async () => {
		const h = await harness();
		const s = readSettings(h.db);
		expect(s).toMatchObject({
			passwordLoginEnabled: true,
			passkeysEnabled: true,
			oidcEnabled: false,
			oidcScopes: 'openid profile email groups',
			oidcProviderName: 'SSO',
			oidcGroupsClaim: 'groups',
			oidcAutoCreateUsers: true
		});
	});
});

describe('test discovery', () => {
	test('it reports missing configuration', async () => {
		const h = await harness();
		const cookie = await adminSession(h);
		const res = await (await h.call('POST', '/settings/auth/test', {}, { cookie })).json();
		expect(res.ok).toBe(false);
		expect(res.message).toContain('issuer URL and client id');
	});

	test('it lists the endpoints the provider advertises', async () => {
		const h = await harness();
		const cookie = await adminSession(h);
		await h.call(
			'PUT',
			'/settings/auth',
			body({ oidcEnabled: true, oidcIssuer: p.issuer, oidcClientId: 'opal' }),
			{ cookie }
		);
		const res = await (await h.call('POST', '/settings/auth/test', {}, { cookie })).json();
		expect(res.ok).toBe(true);
		expect(res.message).toContain('Reached');
		expect(res.authorizationEndpoint).toBe(`${p.issuer}/authorize`);
		expect(res.tokenEndpoint).toBe(`${p.issuer}/token`);
		expect(res.userinfoEndpoint).toBe(`${p.issuer}/userinfo`);
		expect(res.jwksUri).toBe(`${p.issuer}/jwks`);
	});

	test('it names a scope the provider does not advertise', async () => {
		const h = await harness();
		const cookie = await adminSession(h);
		await h.call(
			'PUT',
			'/settings/auth',
			body({ oidcEnabled: true, oidcIssuer: p.issuer, oidcClientId: 'opal', oidcScopes: 'openid offline_access' }),
			{ cookie }
		);
		const res = await (await h.call('POST', '/settings/auth/test', {}, { cookie })).json();
		expect(res.ok).toBe(false);
		expect(res.message).toContain('offline_access');
	});

	test('it reports an unreachable provider without throwing', async () => {
		const h = await harness();
		const cookie = await adminSession(h);
		await h.call(
			'PUT',
			'/settings/auth',
			body({ oidcEnabled: true, oidcIssuer: 'http://localhost:1', oidcClientId: 'opal' }),
			{ cookie }
		);
		const res = await (await h.call('POST', '/settings/auth/test', {}, { cookie })).json();
		expect(res.ok).toBe(false);
		expect(res.message).toContain('Could not reach');
	});

	test('saving settings drops the cached provider metadata', async () => {
		const h = await harness();
		const cookie = await adminSession(h);
		const save = () =>
			h.call('PUT', '/settings/auth', body({ oidcEnabled: true, oidcIssuer: p.issuer, oidcClientId: 'opal' }), { cookie });
		await save();
		await h.call('POST', '/settings/auth/test', {}, { cookie });
		const before = p.hits.discovery;
		await h.call('POST', '/settings/auth/test', {}, { cookie }); // test always refetches
		expect(p.hits.discovery).toBe(before + 1);
	});
});
