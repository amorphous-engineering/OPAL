/**
 * OAuth 2.1 for MCP clients (the MCP authorization spec): dynamic client registration, the
 * authorization code grant with PKCE S256, and refresh tokens. OPAL is both the authorization
 * server and the resource server.
 *
 * Nothing new is stored for clients or codes:
 * - A client id is a signed payload that holds the client's name and redirect URIs.
 * - A code is a signed payload that lives 60 seconds. A process-local set makes it single use;
 *   OPAL runs as one process.
 * - A grant is one `api_token` row. A refresh rotates the row's token hash, so the list of API
 *   tokens shows one row per connected client and revoking it ends the grant.
 * - A refresh token is a signed payload bound to the row and to its current hash. A rotation or a
 *   revoke makes every earlier refresh token fail.
 */
import { createHash, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { API_TOKEN_PREFIX, addMs, hashToken, newToken } from '../../auth/tokens.ts';
import { signPayload, verifyPayload } from '../../auth/signing.ts';
import type { Ctx } from '../../context.ts';
import { apiToken, user } from '../../db/schema/index.ts';
import { insert, update } from '../../write.ts';

export const ACCESS_TOKEN_LIFETIME_MS = 24 * 3600 * 1000;
export const REFRESH_TOKEN_LIFETIME_MS = 30 * 24 * 3600 * 1000;
const CODE_LIFETIME_MS = 60 * 1000;
const CLIENT_LIFETIME_MS = 10 * 365 * 24 * 3600 * 1000;
const MAX_REDIRECT_URIS = 10;

/** An RFC 6749 error: `code` is the wire error, `status` the HTTP status. */
export class OAuthError extends Error {
	constructor(
		readonly code: string,
		message: string,
		readonly status = 400
	) {
		super(message);
	}
}

export interface OAuthClient {
	id: string;
	name: string;
	redirectUris: string[];
}

const LOOPBACK = /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/;

/** https anywhere, or http on loopback (a CLI's local listener). No fragments, no credentials. */
function redirectAllowed(raw: string): boolean {
	if (raw.length > 500) return false;
	let u: URL;
	try {
		u = new URL(raw);
	} catch {
		return false;
	}
	if (u.hash || u.username || u.password) return false;
	return u.protocol === 'https:' || LOOPBACK.test(raw);
}

export function registerClient(body: unknown): OAuthClient {
	const b = (body ?? {}) as Record<string, unknown>;
	const uris = b.redirect_uris;
	if (!Array.isArray(uris) || !uris.length || uris.length > MAX_REDIRECT_URIS) {
		throw new OAuthError('invalid_redirect_uri', `Give 1 to ${MAX_REDIRECT_URIS} redirect URIs.`);
	}
	for (const u of uris) {
		if (typeof u !== 'string' || !redirectAllowed(u)) {
			throw new OAuthError('invalid_redirect_uri', 'A redirect URI must use https, or http on localhost.');
		}
	}
	const method = b.token_endpoint_auth_method;
	if (method !== undefined && method !== 'none') {
		throw new OAuthError('invalid_client_metadata', 'Only public clients (token_endpoint_auth_method none) are supported.');
	}
	const name = typeof b.client_name === 'string' && b.client_name.trim() ? b.client_name.trim().slice(0, 80) : 'MCP client';
	const id = signPayload({ kind: 'oauth-client', n: name, r: uris }, CLIENT_LIFETIME_MS);
	return { id, name, redirectUris: uris as string[] };
}

export function readClient(clientId: string | undefined | null): OAuthClient | null {
	const p = verifyPayload(clientId);
	if (!p || p.kind !== 'oauth-client' || typeof p.n !== 'string' || !Array.isArray(p.r)) return null;
	return { id: clientId!, name: p.n, redirectUris: p.r as string[] };
}

export interface AuthorizeRequest {
	responseType: string;
	clientId: string;
	redirectUri: string;
	codeChallenge: string;
	codeChallengeMethod: string;
	state?: string;
}

/**
 * Check an authorization request. A bad client or redirect URI must never redirect (the
 * redirect could go anywhere), so those throw. Everything else is reported to the client.
 */
export function checkAuthorizeRequest(r: AuthorizeRequest): OAuthClient {
	const client = readClient(r.clientId);
	if (!client) throw new OAuthError('invalid_client', 'Unknown client. Connect the client again.');
	if (!client.redirectUris.includes(r.redirectUri)) {
		throw new OAuthError('invalid_request', 'The redirect URI is not registered for this client.');
	}
	return client;
}

/** Where a refusal goes: the client's redirect URI with an error. */
export function errorRedirect(r: AuthorizeRequest, error: string, description: string): string {
	const u = new URL(r.redirectUri);
	u.searchParams.set('error', error);
	u.searchParams.set('error_description', description);
	if (r.state) u.searchParams.set('state', r.state);
	return u.toString();
}

/** The request problems that go back to the client, or null. */
export function requestProblem(r: AuthorizeRequest): string | null {
	if (r.responseType !== 'code') return 'unsupported_response_type';
	if (r.codeChallengeMethod !== 'S256' || !/^[A-Za-z0-9_-]{43}$/.test(r.codeChallenge)) return 'invalid_request';
	return null;
}

const digest = (s: string) => createHash('sha256').update(s).digest('base64url');

/** The user approved: a single-use code bound to the client, the redirect URI and the PKCE challenge. */
export function issueCode(userId: number, r: AuthorizeRequest): string {
	const code = signPayload(
		{ kind: 'oauth-code', uid: userId, cid: digest(r.clientId), ru: r.redirectUri, cc: r.codeChallenge, jti: randomUUID() },
		CODE_LIFETIME_MS
	);
	const u = new URL(r.redirectUri);
	u.searchParams.set('code', code);
	if (r.state) u.searchParams.set('state', r.state);
	return u.toString();
}

const usedCodes = new Map<string, number>();
function spendCode(jti: string): boolean {
	const t = Date.now();
	for (const [k, exp] of usedCodes) if (exp < t) usedCodes.delete(k);
	if (usedCodes.has(jti)) return false;
	usedCodes.set(jti, t + CODE_LIFETIME_MS);
	return true;
}

export interface TokenResponse {
	access_token: string;
	token_type: 'Bearer';
	expires_in: number;
	refresh_token: string;
}

function activeUser(ctx: Ctx, id: number) {
	const u = ctx.db.select().from(user).where(eq(user.id, id)).get();
	if (!u || !u.isActive) throw new OAuthError('invalid_grant', 'The account is not active.');
	return u;
}

function refreshTokenFor(tokenId: number, tokenHash: string, clientId: string): string {
	return signPayload({ kind: 'oauth-refresh', tid: tokenId, h: tokenHash.slice(0, 32), cid: digest(clientId) }, REFRESH_TOKEN_LIFETIME_MS);
}

function respond(raw: string, row: { id: number; tokenHash: string }, clientId: string): TokenResponse {
	return {
		access_token: raw,
		token_type: 'Bearer',
		expires_in: ACCESS_TOKEN_LIFETIME_MS / 1000,
		refresh_token: refreshTokenFor(row.id, row.tokenHash, clientId)
	};
}

/** Runs inside a write transaction. */
export function exchangeCode(ctx: Ctx, f: Record<string, string | undefined>): TokenResponse {
	const client = readClient(f.client_id);
	if (!client) throw new OAuthError('invalid_client', 'Unknown client.', 401);
	const p = verifyPayload(f.code);
	if (!p || p.kind !== 'oauth-code' || p.cid !== digest(client.id)) {
		throw new OAuthError('invalid_grant', 'The code is not valid or has expired.');
	}
	if (p.ru !== f.redirect_uri) throw new OAuthError('invalid_grant', 'The redirect URI does not match the code.');
	if (!f.code_verifier || digest(f.code_verifier) !== p.cc) {
		throw new OAuthError('invalid_grant', 'The code verifier does not match the code challenge.');
	}
	if (!spendCode(String(p.jti))) throw new OAuthError('invalid_grant', 'The code was already used.');
	const u = activeUser(ctx, Number(p.uid));
	const raw = newToken(API_TOKEN_PREFIX);
	const row = insert(ctx, apiToken, {
		userId: u.id,
		name: `${client.name} (MCP)`,
		tokenHash: hashToken(raw),
		expiresAt: addMs(ACCESS_TOKEN_LIFETIME_MS)
	});
	return respond(raw, row, client.id);
}

/** Runs inside a write transaction. */
export function refresh(ctx: Ctx, f: Record<string, string | undefined>): TokenResponse {
	const client = readClient(f.client_id);
	if (!client) throw new OAuthError('invalid_client', 'Unknown client.', 401);
	const p = verifyPayload(f.refresh_token);
	if (!p || p.kind !== 'oauth-refresh' || p.cid !== digest(client.id)) {
		throw new OAuthError('invalid_grant', 'The refresh token is not valid or has expired.');
	}
	const row = ctx.db.select().from(apiToken).where(eq(apiToken.id, Number(p.tid))).get();
	// A revoked grant, or a refresh token from before the last rotation.
	if (!row || row.revokedAt || !row.tokenHash.startsWith(String(p.h))) {
		throw new OAuthError('invalid_grant', 'The refresh token is not valid or has expired.');
	}
	activeUser(ctx, row.userId);
	const raw = newToken(API_TOKEN_PREFIX);
	const next = update(ctx, apiToken, row.id, { tokenHash: hashToken(raw), expiresAt: addMs(ACCESS_TOKEN_LIFETIME_MS) });
	return respond(raw, next, client.id);
}
