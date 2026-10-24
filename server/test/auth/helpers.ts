/** Shared setup for the auth tests: a database with the auth tables, an app, a fake OIDC provider. */
import { Database } from 'bun:sqlite';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { generateSQLiteDrizzleJson, generateSQLiteMigration } from 'drizzle-kit/api';
import { exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose';
import type { Hono } from 'hono';
import { createApp } from '../../src/app.ts';
import type { Ctx } from '../../src/context.ts';
import type { Db } from '../../src/db/client.ts';
import * as authSchema from '../../src/db/schema/auth.ts';
import * as schema from '../../src/db/schema/index.ts';
import { user } from '../../src/db/schema/index.ts';
import { resetDiscoveryCache } from '../../src/services/auth/oidc.ts';
import { insert } from '../../src/write.ts';

process.env.OPAL_AUTH_SECRET = 'test-secret-for-signing';
// Never read the machine's real OIDC or sign-in environment.
for (const k of Object.keys(process.env)) {
	if (/^OPAL_(OIDC_|PASSWORD_LOGIN|PASSKEY)/.test(k)) delete process.env[k];
}

const everything = { ...schema, ...authSchema };
let ddl: string[] | undefined;

/** Like openTestDb, plus the auth schema file, which the lead has not added to the index yet. */
export async function openAuthDb(): Promise<Db> {
	if (!ddl) {
		const empty = await generateSQLiteDrizzleJson({});
		const current = await generateSQLiteDrizzleJson(everything);
		ddl = await generateSQLiteMigration(empty, current);
	}
	const sqlite = new Database(':memory:', { strict: true });
	sqlite.run('PRAGMA foreign_keys = ON');
	for (const stmt of ddl) sqlite.run(stmt);
	return drizzle(sqlite, { schema: everything }) as unknown as Db;
}

export const ADMIN = { username: 'Abby', name: 'Abby', password: 'correct-horse-battery' };

export interface Harness {
	db: Db;
	app: Hono;
	call: (method: string, path: string, body?: unknown, headers?: Record<string, string>) => Promise<Response>;
	/** A request below the site root (the /oidc routes). */
	raw: (path: string, headers?: Record<string, string>) => Promise<Response>;
	ctx: Ctx;
}

export async function harness(): Promise<Harness> {
	const db = await openAuthDb();
	const app = createApp({ db });
	const call: Harness['call'] = async (method, path, body, headers = {}) =>
		app.request(`http://opal.test/api${path}`, {
			method,
			headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
			body: body !== undefined ? JSON.stringify(body) : undefined
		});
	const raw: Harness['raw'] = async (path, headers = {}) =>
		app.request(`http://opal.test${path}`, { headers, redirect: 'manual' });
	const ctx: Ctx = { db, actor: { kind: 'system' }, op: 'test' };
	return { db, app, call, raw, ctx };
}

export function cookieOf(res: Response, name?: string): string {
	const all = res.headers.getSetCookie();
	const hit = name ? all.find((c) => c.startsWith(`${name}=`)) : all[0];
	return (hit ?? '').split(';')[0]!;
}

/** Set up the first admin and return their session cookie. */
export async function adminSession(h: Harness): Promise<string> {
	const res = await h.call('POST', '/auth/setup', ADMIN);
	return cookieOf(res, 'opal_session');
}

/** Insert a user directly. */
export function makeUser(h: Harness, over: Partial<typeof user.$inferInsert> & { username: string }) {
	return insert(h.ctx, user, { name: over.username, isActive: true, isAdmin: false, ...over });
}

/** Sign in as an existing password user and return the cookie. */
export async function signIn(h: Harness, username: string, password: string): Promise<string> {
	const res = await h.call('POST', '/auth/login', { username, password });
	if (res.status !== 200) throw new Error(`sign-in failed: ${res.status}`);
	return cookieOf(res, 'opal_session');
}

// ---------------------------------------------------------------- fake OIDC provider

export const CLIENT_ID = 'opal-test';

export interface FakeProvider {
	issuer: string;
	/** What the token endpoint answers next. */
	tokens: Record<string, unknown> | { status: number; body: Record<string, unknown> } | null;
	userinfo: Record<string, unknown> | null;
	lastTokenRequest: { body: URLSearchParams; authorization: string | null } | null;
	hits: { discovery: number };
	/** Overrides for the discovery document. */
	discovery: Record<string, unknown>;
	idToken(claims?: Record<string, unknown>, opts?: { nonce?: string; key?: CryptoKey; expiresIn?: string; aud?: string; alg?: string }): Promise<string>;
	stop(): void;
}

export async function fakeProvider(): Promise<FakeProvider> {
	const { publicKey, privateKey } = await generateKeyPair('RS256', { extractable: true });
	const jwk: JWK = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
	let provider!: FakeProvider;
	// eslint-disable-next-line prefer-const
	let server: ReturnType<typeof Bun.serve>;
	server = Bun.serve({
		port: 0,
		hostname: 'localhost',
		async fetch(req): Promise<Response> {
			const url = new URL(req.url);
			const issuer: string = `http://localhost:${server.port}`;
			if (url.pathname === '/.well-known/openid-configuration') {
				provider.hits.discovery++;
				return Response.json({
					issuer,
					authorization_endpoint: `${issuer}/authorize`,
					token_endpoint: `${issuer}/token`,
					userinfo_endpoint: `${issuer}/userinfo`,
					jwks_uri: `${issuer}/jwks`,
					scopes_supported: ['openid', 'profile', 'email', 'groups'],
					id_token_signing_alg_values_supported: ['RS256'],
					token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
					...provider.discovery
				});
			}
			if (url.pathname === '/jwks') return Response.json({ keys: [jwk] });
			if (url.pathname === '/userinfo') {
				return provider.userinfo ? Response.json(provider.userinfo) : new Response('no', { status: 404 });
			}
			if (url.pathname === '/token' && req.method === 'POST') {
				provider.lastTokenRequest = {
					body: new URLSearchParams(await req.text()),
					authorization: req.headers.get('authorization')
				};
				const t = provider.tokens as { status?: number; body?: Record<string, unknown> } | null;
				if (t && typeof t.status === 'number') return Response.json(t.body, { status: t.status });
				return Response.json({ token_type: 'Bearer', access_token: 'at', ...(t ?? {}) });
			}
			return new Response('not found', { status: 404 });
		}
	});
	provider = {
		issuer: `http://localhost:${server.port}`,
		tokens: null,
		userinfo: null,
		lastTokenRequest: null,
		hits: { discovery: 0 },
		discovery: {},
		async idToken(claims = {}, opts = {}) {
			return new SignJWT({ nonce: opts.nonce ?? 'n', ...claims })
				.setProtectedHeader({ alg: opts.alg ?? 'RS256', kid: 'k1' })
				.setIssuer(provider.issuer)
				.setAudience(opts.aud ?? CLIENT_ID)
				.setSubject(String(claims.sub ?? 'sub-1'))
				.setIssuedAt()
				.setExpirationTime(opts.expiresIn ?? '5m')
				.sign(opts.key ?? privateKey);
		},
		stop: () => server.stop(true)
	};
	resetDiscoveryCache();
	return provider;
}

/** Save OIDC settings straight into the database (as the settings page would). */
export function configureOidc(h: Harness, p: FakeProvider, over: Record<string, string> = {}): void {
	const rows: Record<string, string> = {
		oidc_enabled: 'true',
		oidc_issuer: p.issuer,
		oidc_client_id: CLIENT_ID,
		oidc_scopes: 'openid profile email groups',
		oidc_admin_group: 'opal-admins',
		...over
	};
	const ts = new Date().toISOString();
	for (const [key, value] of Object.entries(rows)) {
		h.db
			.insert(authSchema.authSetting)
			.values({ key, value, createdAt: ts, updatedAt: ts })
			.onConflictDoUpdate({ target: authSchema.authSetting.key, set: { value } })
			.run();
	}
	resetDiscoveryCache();
}

/** Run /oidc/login and return the provider's authorization query plus the state cookie. */
export async function beginOidc(h: Harness, next?: string) {
	const res = await h.raw(`/oidc/login${next ? `?next=${encodeURIComponent(next)}` : ''}`);
	const location = res.headers.get('location') ?? '';
	return { res, location, query: new URL(location, 'http://x').searchParams, cookie: cookieOf(res, 'opal_oidc_state') };
}
