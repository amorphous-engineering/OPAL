import { describe, expect, test } from 'bun:test';
import { createHash, randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { apiToken } from '../../src/db/schema/index.ts';
import { adminSession, harness, type Harness } from './helpers.ts';

const ORIGIN = { origin: 'http://opal.test' };
const REDIRECT = 'http://127.0.0.1:33418/callback';

const post = (h: Harness, path: string, body: string, type: string) =>
	h.app.request(`http://opal.test${path}`, { method: 'POST', headers: { 'content-type': type }, body });
const register = async (h: Harness, metadata: Record<string, unknown> = {}) =>
	post(h, '/oauth/register', JSON.stringify({ client_name: 'Claude Code', redirect_uris: [REDIRECT], ...metadata }), 'application/json');
const token = (h: Harness, form: Record<string, string>) =>
	post(h, '/oauth/token', new URLSearchParams(form).toString(), 'application/x-www-form-urlencoded');

function pkce() {
	const verifier = randomBytes(32).toString('base64url');
	return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

/** Register a client, approve it as the admin, and return everything the token call needs. */
async function authorize(h: Harness, cookie: string) {
	const clientId = (await (await register(h)).json()).client_id as string;
	const { verifier, challenge } = pkce();
	const request = {
		responseType: 'code',
		clientId,
		redirectUri: REDIRECT,
		codeChallenge: challenge,
		codeChallengeMethod: 'S256',
		state: 'st-1'
	};
	const res = await h.call('POST', '/auth/oauth/approve', request, { cookie, ...ORIGIN });
	expect(res.status).toBe(200);
	const back = new URL((await res.json()).redirectTo);
	return { clientId, verifier, code: back.searchParams.get('code')!, back, request };
}

async function connect(h: Harness, cookie: string) {
	const a = await authorize(h, cookie);
	const res = await token(h, {
		grant_type: 'authorization_code',
		code: a.code,
		redirect_uri: REDIRECT,
		client_id: a.clientId,
		code_verifier: a.verifier
	});
	expect(res.status).toBe(200);
	return { ...a, tokens: await res.json() };
}

const mcp = (h: Harness, bearer: string) =>
	h.app.request('http://opal.test/mcp', {
		method: 'POST',
		headers: {
			authorization: `Bearer ${bearer}`,
			'content-type': 'application/json',
			accept: 'application/json, text/event-stream'
		},
		body: JSON.stringify({
			jsonrpc: '2.0',
			id: 1,
			method: 'initialize',
			params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } }
		})
	});

describe('oauth for mcp clients', () => {
	test('an unauthenticated mcp call points the client to the resource metadata, which names this server', async () => {
		const h = await harness();
		const res = await h.app.request('http://opal.test/mcp', { method: 'POST' });
		expect(res.status).toBe(401);
		expect(res.headers.get('www-authenticate')).toContain(
			'resource_metadata="http://opal.test/.well-known/oauth-protected-resource/mcp"'
		);
		const pr = await (await h.raw('/.well-known/oauth-protected-resource/mcp')).json();
		expect(pr).toMatchObject({ resource: 'http://opal.test/mcp', authorization_servers: ['http://opal.test'] });
		const as = await (await h.raw('/.well-known/oauth-authorization-server')).json();
		expect(as).toMatchObject({
			issuer: 'http://opal.test',
			authorization_endpoint: 'http://opal.test/oauth/authorize',
			token_endpoint: 'http://opal.test/oauth/token',
			registration_endpoint: 'http://opal.test/oauth/register',
			code_challenge_methods_supported: ['S256']
		});
	});

	test('OPAL_PUBLIC_URL names the server in the metadata, whatever the request says', async () => {
		const h = await harness();
		process.env.OPAL_PUBLIC_URL = 'https://opal.example.com/';
		try {
			const res = await h.app.request('http://opal.test/mcp', { method: 'POST', headers: { 'x-forwarded-proto': 'http' } });
			expect(res.headers.get('www-authenticate')).toContain(
				'resource_metadata="https://opal.example.com/.well-known/oauth-protected-resource/mcp"'
			);
			const pr = await (await h.raw('/.well-known/oauth-protected-resource/mcp')).json();
			expect(pr).toMatchObject({ resource: 'https://opal.example.com/mcp', authorization_servers: ['https://opal.example.com'] });
		} finally {
			delete process.env.OPAL_PUBLIC_URL;
		}
	});

	test('registration accepts https and loopback redirects and refuses others', async () => {
		const h = await harness();
		const ok = await register(h, { redirect_uris: ['https://claude.ai/api/mcp/auth_callback', 'http://localhost:9/cb'] });
		expect(ok.status).toBe(201);
		expect((await ok.json()).token_endpoint_auth_method).toBe('none');
		for (const uris of [['http://evil.example/cb'], ['https://x.example/cb#frag'], ['javascript:alert(1)'], []]) {
			const bad = await register(h, { redirect_uris: uris });
			expect(bad.status).toBe(400);
			expect((await bad.json()).error).toBe('invalid_redirect_uri');
		}
		expect((await register(h, { token_endpoint_auth_method: 'client_secret_basic' })).status).toBe(400);
	});

	test('an approved client trades the code for a token that works on /mcp and shows in the token list', async () => {
		const h = await harness();
		const cookie = await adminSession(h);
		const { back, tokens } = await connect(h, cookie);
		expect(back.origin + back.pathname).toBe(REDIRECT);
		expect(back.searchParams.get('state')).toBe('st-1');
		expect(tokens).toMatchObject({ token_type: 'Bearer', expires_in: 86400 });
		expect(tokens.access_token.startsWith('opal_')).toBe(true);
		expect((await mcp(h, tokens.access_token)).status).toBe(200);
		const list = await (await h.call('GET', '/auth/tokens', undefined, { cookie })).json();
		expect(list.items.map((t: { name: string }) => t.name)).toEqual(['Claude Code (MCP)']);
	});

	test('a code works once, and only with its verifier, redirect uri and client', async () => {
		const h = await harness();
		const cookie = await adminSession(h);
		const a = await authorize(h, cookie);
		// Same metadata in the same millisecond signs to the same id, so make the other client differ.
		const other = (await (await register(h, { client_name: 'Other' })).json()).client_id;
		const base = { grant_type: 'authorization_code', code: a.code, redirect_uri: REDIRECT, client_id: a.clientId, code_verifier: a.verifier };
		for (const bad of [
			{ code_verifier: pkce().verifier },
			{ redirect_uri: 'http://127.0.0.1:1/other' },
			{ client_id: other }
		]) {
			const res = await token(h, { ...base, ...bad });
			expect(res.status).toBe(400);
			expect((await res.json()).error).toBe('invalid_grant');
		}
		expect((await token(h, base)).status).toBe(200);
		const again = await token(h, base);
		expect(again.status).toBe(400);
		expect((await again.json()).error_description).toContain('already used');
	});

	test('a refresh rotates the token: the old access and refresh tokens stop working', async () => {
		const h = await harness();
		const cookie = await adminSession(h);
		const { clientId, tokens } = await connect(h, cookie);
		const res = await token(h, { grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: clientId });
		expect(res.status).toBe(200);
		const next = await res.json();
		expect(next.access_token).not.toBe(tokens.access_token);
		expect((await mcp(h, next.access_token)).status).toBe(200);
		expect((await mcp(h, tokens.access_token)).status).toBe(401);
		const replay = await token(h, { grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: clientId });
		expect(replay.status).toBe(400);
		expect(h.db.select().from(apiToken).all()).toHaveLength(1);
	});

	test('revoking the token in OPAL ends the grant, refresh included', async () => {
		const h = await harness();
		const cookie = await adminSession(h);
		const { clientId, tokens } = await connect(h, cookie);
		const row = h.db.select().from(apiToken).get()!;
		expect((await h.call('DELETE', `/auth/tokens/${row.id}`, undefined, { cookie, ...ORIGIN })).status).toBe(200);
		expect((await mcp(h, tokens.access_token)).status).toBe(401);
		const res = await token(h, { grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: clientId });
		expect(res.status).toBe(400);
		expect(h.db.select().from(apiToken).where(eq(apiToken.id, row.id)).get()!.revokedAt).not.toBeNull();
	});

	test('the approval page names the client and refuses an unknown client or redirect without redirecting', async () => {
		const h = await harness();
		const cookie = await adminSession(h);
		const { request } = await authorize(h, cookie);
		const info = await (await h.call('POST', '/auth/oauth/describe', request, { cookie, ...ORIGIN })).json();
		expect(info).toMatchObject({ clientName: 'Claude Code', redirectHost: '127.0.0.1:33418', errorUrl: null });
		expect(new URL(info.denyUrl).searchParams.get('error')).toBe('access_denied');
		for (const bad of [{ clientId: 'forged.0000' }, { redirectUri: 'https://evil.example/cb' }]) {
			const res = await h.call('POST', '/auth/oauth/describe', { ...request, ...bad }, { cookie, ...ORIGIN });
			expect(res.status).toBe(400);
			const approve = await h.call('POST', '/auth/oauth/approve', { ...request, ...bad }, { cookie, ...ORIGIN });
			expect(approve.status).toBe(400);
		}
	});

	test('a request without S256 PKCE goes back to the client as an error, with no code', async () => {
		const h = await harness();
		const cookie = await adminSession(h);
		const { request } = await authorize(h, cookie);
		const plain = { ...request, codeChallengeMethod: 'plain' };
		const info = await (await h.call('POST', '/auth/oauth/describe', plain, { cookie, ...ORIGIN })).json();
		expect(new URL(info.errorUrl).searchParams.get('error')).toBe('invalid_request');
		const approved = await (await h.call('POST', '/auth/oauth/approve', plain, { cookie, ...ORIGIN })).json();
		const back = new URL(approved.redirectTo);
		expect(back.searchParams.get('code')).toBeNull();
		expect(back.searchParams.get('error')).toBe('invalid_request');
	});

	test('an API token cannot approve a client', async () => {
		const h = await harness();
		const cookie = await adminSession(h);
		const { request, tokens } = await connect(h, cookie);
		const res = await h.call('POST', '/auth/oauth/approve', request, { authorization: `Bearer ${tokens.access_token}` });
		expect(res.status).toBe(403);
	});
});
