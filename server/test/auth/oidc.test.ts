import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { generateKeyPair } from 'jose';
import { eq } from 'drizzle-orm';
import { safeNext } from '../../src/auth/oidc.ts';
import { signPayload } from '../../src/auth/signing.ts';
import { user } from '../../src/db/schema/index.ts';
import {
	buildAuthorizationUrl,
	discover,
	exchangeCode,
	extractGroups,
	makePkcePair,
	OidcError,
	redirectUri,
	resetDiscoveryCache,
	resolveIdentity,
	verifyIdToken
} from '../../src/services/auth/oidc.ts';
import { readSettings, type SignInSettings } from '../../src/services/auth/settings.ts';
import {
	adminSession,
	beginOidc,
	CLIENT_ID,
	configureOidc,
	cookieOf,
	fakeProvider,
	type FakeProvider,
	harness,
	type Harness,
	makeUser,
	signIn
} from './helpers.ts';

let p: FakeProvider;
beforeAll(async () => {
	p = await fakeProvider();
});
afterAll(() => p.stop());

const settings = (over: Partial<SignInSettings> = {}): SignInSettings => ({
	passwordLoginEnabled: true,
	passkeysEnabled: true,
	passkeyRpId: '',
	oidcEnabled: true,
	oidcIssuer: p.issuer,
	oidcClientId: CLIENT_ID,
	oidcClientSecret: '',
	oidcScopes: 'openid profile email groups',
	oidcProviderName: 'SSO',
	oidcGroupsClaim: 'groups',
	oidcAdminGroup: 'opal-admins',
	oidcAutoCreateUsers: true,
	oidcRedirectBaseUrl: '',
	...over
});

const expectOidcError = async (promise: Promise<unknown>, fragment: string) => {
	const err = await promise.then(
		() => null,
		(e) => e
	);
	expect(err).toBeInstanceOf(OidcError);
	expect((err as Error).message).toContain(fragment);
};

describe('oidc discovery', () => {
	test('discovery reads the provider metadata once and caches it', async () => {
		resetDiscoveryCache();
		const before = p.hits.discovery;
		await discover(settings());
		await discover(settings());
		expect(p.hits.discovery - before).toBe(1);
	});

	test('a plain http issuer is refused unless it is loopback', async () => {
		await expectOidcError(discover(settings({ oidcIssuer: 'http://evil.example' })), 'https://');
		await expect(discover(settings())).resolves.toBeDefined();
	});

	test('an issuer the provider does not advertise is refused', async () => {
		resetDiscoveryCache();
		p.discovery = { issuer: 'https://someone-else.example' };
		await expectOidcError(discover(settings()), 'Issuer mismatch');
		p.discovery = {};
		resetDiscoveryCache();
	});

	test('a discovery document without a token endpoint is refused', async () => {
		resetDiscoveryCache();
		p.discovery = { token_endpoint: '' };
		await expectOidcError(discover(settings()), 'token_endpoint');
		p.discovery = {};
		resetDiscoveryCache();
	});
});

describe('oidc handshake pieces', () => {
	test('the authorization URL carries PKCE S256, state, nonce and the scopes', async () => {
		const { challenge } = await makePkcePair();
		const url = new URL(await buildAuthorizationUrl(settings(), 'http://opal.test/oidc/callback', 'st', 'nn', challenge));
		expect(url.origin + url.pathname).toBe(`${p.issuer}/authorize`);
		expect(url.searchParams.get('response_type')).toBe('code');
		expect(url.searchParams.get('client_id')).toBe(CLIENT_ID);
		expect(url.searchParams.get('code_challenge')).toBe(challenge);
		expect(url.searchParams.get('code_challenge_method')).toBe('S256');
		expect(url.searchParams.get('state')).toBe('st');
		expect(url.searchParams.get('nonce')).toBe('nn');
		expect(url.searchParams.get('scope')).toBe('openid profile email groups');
		expect(url.searchParams.get('redirect_uri')).toBe('http://opal.test/oidc/callback');
	});

	test('the PKCE challenge is the S256 digest of the verifier', async () => {
		const { verifier, challenge } = await makePkcePair();
		const digest = new Bun.CryptoHasher('sha256').update(verifier).digest('base64url');
		expect(challenge).toBe(digest);
	});

	test('a pinned base URL beats the request host in the redirect URI', () => {
		expect(redirectUri('http://internal:8080', { oidcRedirectBaseUrl: 'https://opal.example.com' })).toBe(
			'https://opal.example.com/oidc/callback'
		);
		expect(redirectUri('http://opal.test/', { oidcRedirectBaseUrl: '' })).toBe('http://opal.test/oidc/callback');
	});

	test('the code exchange sends the verifier and uses basic auth when a secret is set', async () => {
		resetDiscoveryCache();
		const idToken = await p.idToken();
		p.tokens = { id_token: idToken };
		const tokens = await exchangeCode(settings({ oidcClientSecret: 's3cret' }), 'the-code', 'http://opal.test/oidc/callback', 'verifier-1');
		expect(tokens.idToken).toBe(idToken);
		const sent = p.lastTokenRequest!;
		expect(sent.body.get('code')).toBe('the-code');
		expect(sent.body.get('code_verifier')).toBe('verifier-1');
		expect(sent.body.get('grant_type')).toBe('authorization_code');
		expect(sent.authorization?.startsWith('Basic ')).toBe(true);
	});

	test('a client with no secret sends none (public client)', async () => {
		resetDiscoveryCache();
		p.tokens = { id_token: await p.idToken() };
		await exchangeCode(settings(), 'c', 'http://opal.test/oidc/callback', 'v');
		expect(p.lastTokenRequest!.authorization).toBeNull();
		expect(p.lastTokenRequest!.body.get('client_id')).toBe(CLIENT_ID);
	});

	test('a provider that rejects the code gives a readable message', async () => {
		p.tokens = { status: 400, body: { error: 'invalid_grant', error_description: 'code expired' } };
		await expectOidcError(exchangeCode(settings(), 'c', 'http://opal.test/oidc/callback', 'v'), 'code expired');
	});

	test('a token response without an id_token is refused', async () => {
		p.tokens = { access_token: 'x' };
		await expectOidcError(exchangeCode(settings(), 'c', 'http://opal.test/oidc/callback', 'v'), 'id_token');
	});
});

describe('id token verification', () => {
	test('a valid token returns its claims', async () => {
		const t = await p.idToken({ sub: 'u1', email: 'a@example.test' }, { nonce: 'n1' });
		const claims = await verifyIdToken(settings(), t, 'n1');
		expect(claims.sub).toBe('u1');
		expect(claims.email).toBe('a@example.test');
	});

	test('a wrong nonce is refused', async () => {
		await expectOidcError(verifyIdToken(settings(), await p.idToken({}, { nonce: 'a' }), 'b'), 'nonce');
	});

	test('a wrong audience is refused', async () => {
		await expectOidcError(verifyIdToken(settings(), await p.idToken({}, { aud: 'other-app' }), 'n'), 'not valid');
	});

	test('an expired token is refused', async () => {
		await expectOidcError(verifyIdToken(settings(), await p.idToken({}, { expiresIn: '-1m' }), 'n'), 'not valid');
	});

	test('a token signed by a foreign key is refused', async () => {
		const { privateKey } = await generateKeyPair('RS256');
		await expectOidcError(verifyIdToken(settings(), await p.idToken({}, { key: privateKey }), 'n'), 'signature');
	});
});

describe('handshake state and redirects', () => {
	test('extractGroups tolerates provider variance', () => {
		const g = (v: unknown) => extractGroups({ groups: v }, 'groups');
		expect(g(['a', 'b'])).toEqual(['a', 'b']);
		expect(g('a b')).toEqual(['a', 'b']);
		expect(g('a,b')).toEqual(['a', 'b']);
		expect(g(null)).toEqual([]);
		expect(g(5)).toEqual([]);
		expect(extractGroups({}, 'groups')).toEqual([]);
	});

	test('post-login redirects stay inside this app', () => {
		expect(safeNext('//evil.test/')).toBe('/');
		expect(safeNext('https://evil.test')).toBe('/');
		expect(safeNext('/\\evil.test')).toBe('/');
		expect(safeNext('/parts')).toBe('/parts');
		expect(safeNext('')).toBe('/');
		expect(safeNext(undefined)).toBe('/');
	});
});

describe('identity resolution', () => {
	const fresh = async () => {
		const h = await harness();
		return h;
	};
	const resolve = (h: Harness, claims: Record<string, unknown>, s = settings()) => resolveIdentity(h.ctx, s, claims);

	test('a new identity is provisioned from its claims, without a password', async () => {
		const h = await fresh();
		const u = resolve(h, { sub: 's1', email: 'ada@example.test', name: 'Ada Lovelace', groups: [] });
		expect(u.name).toBe('Ada Lovelace');
		expect(u.email).toBe('ada@example.test');
		expect(u.oidcSubject).toBe('s1');
		expect(u.oidcIssuer).toBe(p.issuer);
		expect(u.passwordHash).toBeNull();
	});

	test('the first account is admin whatever the groups say', async () => {
		const h = await fresh();
		expect(resolve(h, { sub: 's1', email: 'a@example.test' }).isAdmin).toBe(true);
	});

	test('the admin group grants admin and losing it revokes admin', async () => {
		const h = await fresh();
		makeUser(h, { username: 'seed', isAdmin: true });
		const granted = resolve(h, { sub: 's2', email: 'b@example.test', groups: ['opal-admins', 'eng'] });
		expect(granted.isAdmin).toBe(true);
		const revoked = resolve(h, { sub: 's2', email: 'b@example.test', groups: ['eng'] });
		expect(revoked.id).toBe(granted.id);
		expect(revoked.isAdmin).toBe(false);
	});

	test('a token without the groups claim never changes admin', async () => {
		const h = await fresh();
		makeUser(h, { username: 'seed', isAdmin: true });
		const u = resolve(h, { sub: 'm1', email: 'm@example.test', groups: ['opal-admins'] });
		expect(u.isAdmin).toBe(true);
		const again = resolve(h, { sub: 'm1', email: 'm@example.test', groups: ['eng'] }, settings({ oidcGroupsClaim: 'opal_users' }));
		expect(again.isAdmin).toBe(true);
	});

	test('the last active administrator is never demoted by group sync', async () => {
		const h = await fresh();
		makeUser(h, { username: 'plain' });
		const u = resolve(h, { sub: 'l1', email: 'l@example.test', groups: ['opal-admins'] });
		expect(u.isAdmin).toBe(true);
		expect(resolve(h, { sub: 'l1', email: 'l@example.test', groups: ['eng'] }).isAdmin).toBe(true);
	});

	test('a blank admin group leaves admin alone', async () => {
		const h = await fresh();
		makeUser(h, { username: 'plain' });
		const s = settings({ oidcAdminGroup: '' });
		const u = resolve(h, { sub: 's3', email: 'c@example.test' }, s);
		h.db.update(user).set({ isAdmin: true }).where(eq(user.id, u.id)).run();
		expect(resolve(h, { sub: 's3', email: 'c@example.test' }, s).isAdmin).toBe(true);
	});

	test('the account is matched on the subject after an email change', async () => {
		const h = await fresh();
		makeUser(h, { username: 'plain' });
		const first = resolve(h, { sub: 's4', email: 'old@example.test' });
		const second = resolve(h, { sub: 's4', email: 'new@example.test' });
		expect(second.id).toBe(first.id);
		expect(second.email).toBe('new@example.test');
	});

	test('an existing password account is linked by verified email and keeps its password', async () => {
		const h = await fresh();
		const existing = makeUser(h, { username: 'grace', email: 'grace@example.test', passwordHash: 'x' });
		const linked = resolve(h, { sub: 's5', email: 'Grace@Example.test', name: 'Grace Hopper' });
		expect(linked.id).toBe(existing.id);
		expect(linked.oidcSubject).toBe('s5');
		expect(linked.passwordHash).toBe('x');
	});

	test('an unverified email never claims an existing account', async () => {
		const h = await fresh();
		makeUser(h, { username: 'victim', email: 'victim@example.test' });
		expect(() =>
			resolve(h, { sub: 'attacker', email: 'victim@example.test', email_verified: false })
		).toThrow(/unverified/);
	});

	test('with auto-create off an unknown identity is refused', async () => {
		const h = await fresh();
		makeUser(h, { username: 'seed' });
		expect(() => resolve(h, { sub: 's6', email: 'nobody@example.test' }, settings({ oidcAutoCreateUsers: false }))).toThrow(
			/no OPAL account/
		);
	});

	test('a deactivated account cannot sign in', async () => {
		const h = await fresh();
		makeUser(h, { username: 'seed' });
		const u = resolve(h, { sub: 's7', email: 'd@example.test' });
		h.db.update(user).set({ isActive: false }).where(eq(user.id, u.id)).run();
		expect(() => resolve(h, { sub: 's7', email: 'd@example.test' })).toThrow(/deactivated/);
	});

	test('a missing subject is refused', async () => {
		const h = await fresh();
		expect(() => resolve(h, { email: 'e@example.test' })).toThrow(/subject/);
	});

	test('an email another account holds leaves the existing value alone', async () => {
		const h = await fresh();
		makeUser(h, { username: 'taken', email: 'shared@example.test' });
		makeUser(h, { username: 'mine', email: 'mine@example.test', oidcIssuer: p.issuer, oidcSubject: 's8' });
		const u = resolve(h, { sub: 's8', email: 'shared@example.test' });
		expect(u.username).toBe('mine');
		expect(u.email).toBe('mine@example.test');
	});

	test('the display name falls back through the claims', async () => {
		const h = await fresh();
		makeUser(h, { username: 'seed' });
		expect(resolve(h, { sub: 's9', email: 'alan.turing@example.test', given_name: 'Alan', family_name: 'Turing' }).name).toBe(
			'Alan Turing'
		);
		expect(resolve(h, { sub: 's10', email: 'grace.hopper@example.test' }).name).toBe('Grace Hopper');
	});

	test('usernames made from claims are unique', async () => {
		const h = await fresh();
		makeUser(h, { username: 'ada' });
		const u = resolve(h, { sub: 's11', preferred_username: 'ada' });
		expect(u.username).toBe('ada2');
	});
});

describe('oidc routes', () => {
	test('login redirects to the provider and sets the signed state cookie', async () => {
		const h = await harness();
		configureOidc(h, p);
		const { res, location, query, cookie } = await beginOidc(h);
		expect(res.status).toBe(302);
		expect(location.startsWith(`${p.issuer}/authorize?`)).toBe(true);
		expect(query.get('code_challenge_method')).toBe('S256');
		expect(query.get('redirect_uri')).toBe('http://opal.test/oidc/callback');
		expect(cookie.startsWith('opal_oidc_state=')).toBe(true);
		const flags = res.headers.getSetCookie()[0]!;
		expect(flags).toContain('HttpOnly');
		expect(flags).toContain('SameSite=Lax');
	});

	test('the routes do nothing while OIDC is off', async () => {
		const h = await harness();
		for (const path of ['/oidc/login', '/oidc/callback?code=c&state=s']) {
			const res = await h.raw(path);
			expect(res.status).toBe(302);
			expect(res.headers.get('location')).toBe('/login');
		}
	});

	test('login with a missing client id stays off even when switched on', async () => {
		const h = await harness();
		configureOidc(h, p, { oidc_client_id: '' });
		expect((await h.raw('/oidc/login')).headers.get('location')).toBe('/login');
		expect((await (await h.call('GET', '/auth/config')).json()).oidcEnabled).toBe(false);
	});

	const callbackAs = async (h: Harness, claims: Record<string, unknown>) => {
		const { query, cookie } = await beginOidc(h);
		p.userinfo = null;
		p.tokens = { id_token: await p.idToken(claims, { nonce: query.get('nonce')! }) };
		return h.raw(`/oidc/callback?code=c&state=${query.get('state')}`, { cookie });
	};
	const whoAmI = async (h: Harness, res: Response) =>
		(await h.call('GET', '/auth/me', undefined, { cookie: cookieOf(res, 'opal_session') })).json();

	test('a user cannot pre-claim a colleague sign-in identity by setting their own email', async () => {
		const h = await harness();
		const admin = await adminSession(h);
		await h.call('POST', '/users', { name: 'Eve', username: 'eve', password: 'eve-long-password-77', isAdmin: false }, { cookie: admin, origin: 'http://opal.test' });
		const eve = await signIn(h, 'eve', 'eve-long-password-77');
		const eveRow = h.db.select().from(user).where(eq(user.username, 'eve')).get()!;
		const patch = await h.call('PATCH', `/users/${eveRow.id}`, { email: 'Carol@Example.test' }, { cookie: eve, origin: 'http://opal.test' });
		expect(patch.status).toBe(403);
		configureOidc(h, p);
		const res = await callbackAs(h, { sub: 'carol-sub', email: 'carol@example.test', email_verified: true, groups: ['opal-admins'] });
		const me = await whoAmI(h, res);
		expect(me.username).not.toBe('eve');
		const after = h.db.select().from(user).where(eq(user.id, eveRow.id)).get()!;
		expect(after.oidcSubject).toBeNull();
		expect(after.isAdmin).toBe(false);
	});

	test('an email an admin set links the account on first sign-in', async () => {
		const h = await harness();
		const admin = await adminSession(h);
		const created = await h.call('POST', '/users', { name: 'Carol', username: 'carol', email: 'carol@example.test' }, { cookie: admin, origin: 'http://opal.test' });
		expect(created.status).toBe(201);
		configureOidc(h, p);
		const res = await callbackAs(h, { sub: 'carol-sub', email: 'Carol@Example.test', email_verified: true });
		expect((await whoAmI(h, res)).username).toBe('carol');
	});

	test('the full round trip signs the user in and honours next', async () => {
		const h = await harness();
		configureOidc(h, p);
		const { query, cookie } = await beginOidc(h, '/parts');
		p.userinfo = null;
		p.tokens = {
			id_token: await p.idToken(
				{ sub: 'rt-1', email: 'rt@example.test', name: 'Round Trip' },
				{ nonce: query.get('nonce')! }
			)
		};
		const res = await h.raw(`/oidc/callback?code=c&state=${query.get('state')}`, { cookie });
		expect(res.status).toBe(302);
		expect(res.headers.get('location')).toBe('/parts');
		const session = cookieOf(res, 'opal_session');
		expect(session.startsWith('opal_session=')).toBe(true);
		const sent = p.lastTokenRequest!.body;
		expect(sent.get('code_verifier')).toBeTruthy();
		expect(sent.get('redirect_uri')).toBe('http://opal.test/oidc/callback');
		const me = await (await h.call('GET', '/auth/me', undefined, { cookie: session })).json();
		expect(me.username).toBe('rt');
		expect(me.isAdmin).toBe(true); // the first account
		const row = h.db.select().from(user).get()!;
		expect(row.oidcSubject).toBe('rt-1');
		expect(res.headers.getSetCookie().some((c) => c.startsWith('opal_oidc_state=;') || /opal_oidc_state=;/.test(c))).toBe(true);
	});

	test('groups from userinfo grant admin', async () => {
		const h = await harness();
		makeUser(h, { username: 'seed', isAdmin: true });
		configureOidc(h, p);
		const { query, cookie } = await beginOidc(h);
		p.tokens = { id_token: await p.idToken({ sub: 'ui-1', email: 'ui@example.test' }, { nonce: query.get('nonce')! }) };
		p.userinfo = { sub: 'ui-1', groups: ['opal-admins'] };
		const res = await h.raw(`/oidc/callback?code=c&state=${query.get('state')}`, { cookie });
		expect(res.status).toBe(302);
		expect(h.db.select().from(user).where(eq(user.oidcSubject, 'ui-1')).get()!.isAdmin).toBe(true);
		p.userinfo = null;
	});

	test('userinfo about another subject is ignored', async () => {
		const h = await harness();
		makeUser(h, { username: 'seed', isAdmin: true });
		configureOidc(h, p);
		const { query, cookie } = await beginOidc(h);
		p.tokens = { id_token: await p.idToken({ sub: 'ui-2' }, { nonce: query.get('nonce')! }) };
		p.userinfo = { sub: 'someone-else', groups: ['opal-admins'] };
		await h.raw(`/oidc/callback?code=c&state=${query.get('state')}`, { cookie });
		expect(h.db.select().from(user).where(eq(user.oidcSubject, 'ui-2')).get()!.isAdmin).toBe(false);
		p.userinfo = null;
	});

	test('a mismatched state lands on the login page with a message and no session', async () => {
		const h = await harness();
		configureOidc(h, p);
		const { cookie } = await beginOidc(h);
		const res = await h.raw('/oidc/callback?code=c&state=forged', { cookie });
		expect(res.status).toBe(302);
		expect(res.headers.get('location')).toContain('/login?error=');
		expect(res.headers.get('location')).toContain('did%20not%20match');
		expect(cookieOf(res, 'opal_session')).toBe('');
	});

	test('a missing state cookie says the request expired', async () => {
		const h = await harness();
		configureOidc(h, p);
		const res = await h.raw('/oidc/callback?code=c&state=s');
		expect(res.headers.get('location')).toStartWith('/login?error=');
		expect(res.headers.get('location')).toContain('expired');
	});

	test('a tampered or foreign state cookie is refused', async () => {
		const h = await harness();
		configureOidc(h, p);
		const { query, cookie } = await beginOidc(h);
		const tampered = cookie.slice(0, -2) + (cookie.endsWith('aa') ? 'bb' : 'aa');
		const res = await h.raw(`/oidc/callback?code=c&state=${query.get('state')}`, { cookie: tampered });
		expect(res.headers.get('location')).toContain('expired');
		// A correctly signed payload of another kind is no handshake.
		const other = `opal_oidc_state=${signPayload({ kind: 'account-claim', uid: 1 })}`;
		const res2 = await h.raw('/oidc/callback?code=c&state=x', { cookie: other });
		expect(res2.headers.get('location')).toContain('expired');
	});

	test('a provider error is shown to the user', async () => {
		const h = await harness();
		configureOidc(h, p);
		const res = await h.raw('/oidc/callback?error=access_denied&error_description=User+said+no');
		expect(res.headers.get('location')).toContain('User%20said%20no');
	});

	test('an id token with the wrong nonce does not sign anyone in', async () => {
		const h = await harness();
		configureOidc(h, p);
		const { query, cookie } = await beginOidc(h);
		p.tokens = { id_token: await p.idToken({ sub: 'x1' }, { nonce: 'not-the-nonce' }) };
		const res = await h.raw(`/oidc/callback?code=c&state=${query.get('state')}`, { cookie });
		expect(res.headers.get('location')).toContain('nonce');
		expect(h.db.select().from(user).all()).toHaveLength(0);
	});

	test('a refusal inside the sign-in rolls back and shows the message', async () => {
		const h = await harness();
		makeUser(h, { username: 'seed' });
		configureOidc(h, p, { oidc_auto_create_users: 'false' });
		const { query, cookie } = await beginOidc(h);
		p.tokens = { id_token: await p.idToken({ sub: 'x2', email: 'nobody@example.test' }, { nonce: query.get('nonce')! }) };
		const res = await h.raw(`/oidc/callback?code=c&state=${query.get('state')}`, { cookie });
		expect(decodeURIComponent(res.headers.get('location')!)).toContain('no OPAL account');
	});

	test('a login via OIDC records the oidc method on the session', async () => {
		const h = await harness();
		configureOidc(h, p);
		const { query, cookie } = await beginOidc(h);
		p.tokens = { id_token: await p.idToken({ sub: 'm-1', email: 'm@example.test' }, { nonce: query.get('nonce')! }) };
		const res = await h.raw(`/oidc/callback?code=c&state=${query.get('state')}`, { cookie });
		const list = await (await h.call('GET', '/auth/sessions', undefined, { cookie: cookieOf(res, 'opal_session') })).json();
		expect(list.items.map((s: { method: string }) => s.method)).toEqual(['oidc']);
	});

	test('password sign-in is refused while it is switched off', async () => {
		const h = await harness();
		makeUser(h, { username: 'abby' });
		configureOidc(h, p, { password_login_enabled: 'false' });
		const res = await h.call('POST', '/auth/login', { username: 'abby', password: 'whatever-long-1' });
		expect(res.status).toBe(403);
		expect(readSettings(h.db).passwordLoginEnabled).toBe(false);
	});

	test('the config offers SSO with the provider name', async () => {
		const h = await harness();
		configureOidc(h, p, { oidc_provider_name: 'Pocket ID' });
		const cfg = await (await h.call('GET', '/auth/config')).json();
		expect(cfg.oidcEnabled).toBe(true);
		expect(cfg.oidcProviderName).toBe('Pocket ID');
		expect(cfg.passwordLoginEnabled).toBe(true);
	});
});
