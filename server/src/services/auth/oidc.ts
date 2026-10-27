/**
 * OpenID Connect sign-in: discovery, the authorization-code flow with PKCE (S256), and the
 * mapping from verified claims to an OPAL user.
 *
 * - Provider metadata is fetched once per issuer and cached an hour. OPAL runs as one process.
 * - openid-client builds the authorization URL, talks to the token and userinfo endpoints and
 *   authenticates the client. The id_token is checked here with jose, against every signing
 *   algorithm the provider advertises (openid-client alone accepts exactly one).
 * - Identity is (issuer, subject). Email is a display attribute. An account is claimed by a
 *   verified email once, then matched on the subject.
 * - This module resolves a user. It never mints a session.
 */
import { createRemoteJWKSet, jwtVerify } from 'jose';
import * as oc from 'openid-client';
import { and, eq, isNull, ne, sql } from 'drizzle-orm';
import type { Ctx } from '../../context.ts';
import { user } from '../../db/schema/index.ts';
import { insert, update } from '../../write.ts';
import { type SignInSettings } from './settings.ts';
import { uniqueUsername, type UserRow } from './sessions.ts';

export const STATE_COOKIE = 'opal_oidc_state';
export const CALLBACK_PATH = '/oidc/callback';
export const STATE_MAX_AGE_MS = 600_000;
const DISCOVERY_TTL_MS = 3_600_000;
const HTTP_TIMEOUT_MS = 10_000;

/** A sign-in attempt failed. The message is safe to show the user. */
export class OidcError extends Error {}

export const isLoopback = (url: string) => /^http:\/\/(localhost|127\.0\.0\.1)([:/]|$)/.test(url);

// ---------------------------------------------------------------- discovery

interface Discovered {
	metadata: Record<string, any>;
	config: oc.Configuration;
	jwks: ReturnType<typeof createRemoteJWKSet> | null;
	at: number;
}
const cache = new Map<string, Discovered>();

/** Drop cached provider metadata. Called after a settings change. */
export function resetDiscoveryCache(): void {
	cache.clear();
}

type OidcSettings = Pick<
	SignInSettings,
	'oidcIssuer' | 'oidcClientId' | 'oidcClientSecret' | 'oidcScopes' | 'oidcGroupsClaim' | 'oidcAdminGroup' | 'oidcAutoCreateUsers' | 'oidcRedirectBaseUrl'
>;

function clientAuth(secret: string): oc.ClientAuth {
	if (!secret) return oc.None();
	// client_secret_basic is the spec default; use post only when the provider lacks basic.
	return (as, client, body, headers) => {
		const methods = as.token_endpoint_auth_methods_supported ?? ['client_secret_basic'];
		const impl = methods.includes('client_secret_basic') ? oc.ClientSecretBasic : oc.ClientSecretPost;
		impl(secret)(as, client, body, headers);
	};
}

export async function discover(s: OidcSettings, force = false): Promise<Discovered> {
	const issuer = s.oidcIssuer;
	if (!issuer) throw new OidcError('No OIDC issuer is configured.');
	if (!issuer.startsWith('https://') && !isLoopback(issuer)) {
		throw new OidcError('The OIDC issuer must be an https:// URL.');
	}
	const key = `${issuer}\n${s.oidcClientId}\n${s.oidcClientSecret}`;
	const hit = cache.get(key);
	if (!force && hit && Date.now() - hit.at < DISCOVERY_TTL_MS) return hit;

	const url = `${issuer}/.well-known/openid-configuration`;
	let metadata: unknown;
	try {
		const res = await fetch(url, { signal: AbortSignal.timeout(HTTP_TIMEOUT_MS), redirect: 'follow' });
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		metadata = await res.json().catch(() => {
			throw new OidcError(`The identity provider at ${url} did not return JSON.`);
		});
	} catch (e) {
		if (e instanceof OidcError) throw e;
		throw new OidcError(`Could not reach the identity provider at ${url}: ${(e as Error).message}`);
	}
	if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
		throw new OidcError(`The discovery document at ${url} is not an object.`);
	}
	const doc = metadata as Record<string, any>;
	// The document's issuer is authoritative; a mismatch means the wrong provider answered.
	const advertised = String(doc.issuer ?? '').replace(/\/+$/, '');
	if (advertised && advertised !== issuer) {
		throw new OidcError(`Issuer mismatch: configured ${issuer}, provider advertises ${advertised}.`);
	}
	for (const required of ['authorization_endpoint', 'token_endpoint']) {
		if (!doc[required]) throw new OidcError(`The discovery document is missing ${required}.`);
	}
	const config = new oc.Configuration(
		{ ...doc, issuer: doc.issuer ?? issuer } as oc.ServerMetadata,
		s.oidcClientId,
		{},
		clientAuth(s.oidcClientSecret)
	);
	if (isLoopback(issuer)) oc.allowInsecureRequests(config);
	const found: Discovered = {
		metadata: doc,
		config,
		jwks: doc.jwks_uri ? createRemoteJWKSet(new URL(doc.jwks_uri), { timeoutDuration: HTTP_TIMEOUT_MS }) : null,
		at: Date.now()
	};
	cache.set(key, found);
	return found;
}

// ---------------------------------------------------------------- handshake

/** The callback URL registered with the provider. A pinned base URL beats the request's. */
export function redirectUri(requestBaseUrl: string, s: Pick<SignInSettings, 'oidcRedirectBaseUrl'>): string {
	return (s.oidcRedirectBaseUrl || requestBaseUrl.replace(/\/+$/, '')) + CALLBACK_PATH;
}

export async function makePkcePair(): Promise<{ verifier: string; challenge: string }> {
	const verifier = oc.randomPKCECodeVerifier();
	return { verifier, challenge: await oc.calculatePKCECodeChallenge(verifier) };
}

export async function buildAuthorizationUrl(
	s: OidcSettings,
	callbackUrl: string,
	state: string,
	nonce: string,
	codeChallenge: string
): Promise<string> {
	const { config } = await discover(s);
	return oc
		.buildAuthorizationUrl(config, {
			response_type: 'code',
			redirect_uri: callbackUrl,
			scope: s.oidcScopes,
			state,
			nonce,
			code_challenge: codeChallenge,
			code_challenge_method: 'S256'
		})
		.href;
}

export interface Tokens {
	idToken: string;
	accessToken: string;
}

export async function exchangeCode(
	s: OidcSettings,
	code: string,
	callbackUrl: string,
	codeVerifier: string
): Promise<Tokens> {
	const { config } = await discover(s);
	let res: Awaited<ReturnType<typeof oc.genericGrantRequest>>;
	try {
		res = await oc.genericGrantRequest(config, 'authorization_code', {
			code,
			redirect_uri: callbackUrl,
			code_verifier: codeVerifier
		});
	} catch (e) {
		const body = e as { error?: string; error_description?: string; message?: string };
		if (body.error) {
			const detail = body.error_description || body.error;
			throw new OidcError(`The identity provider rejected the sign-in. ${detail}`.trim());
		}
		throw new OidcError(`Token exchange failed: ${body.message ?? String(e)}`);
	}
	const idToken = (res as { id_token?: unknown }).id_token;
	if (typeof idToken !== 'string') throw new OidcError('The token response carried no id_token.');
	return { idToken, accessToken: res.access_token ?? '' };
}

/** Verify signature, issuer, audience, expiry and nonce. Returns the claims. */
export async function verifyIdToken(
	s: OidcSettings,
	idToken: string,
	nonce: string
): Promise<Record<string, unknown>> {
	const { metadata, jwks } = await discover(s);
	if (!jwks) throw new OidcError('The discovery document is missing jwks_uri.');
	// Never accept unsigned tokens, whatever the provider advertises.
	const algorithms = ((metadata.id_token_signing_alg_values_supported as string[] | undefined) ?? ['RS256']).filter(
		(a) => a.toLowerCase() !== 'none'
	);
	if (!algorithms.length) throw new OidcError('The provider advertises no usable signing algorithm.');
	let claims: Record<string, unknown>;
	try {
		({ payload: claims } = await jwtVerify(idToken, jwks, {
			issuer: metadata.issuer ?? s.oidcIssuer,
			audience: s.oidcClientId,
			algorithms,
			requiredClaims: ['exp', 'iat', 'iss', 'sub', 'aud']
		}));
	} catch (e) {
		const err = e as { code?: string; message: string };
		if (err.code?.startsWith('ERR_JWKS') || err.code === 'ERR_JOSE_GENERIC' || err.code === 'ERR_JWS_SIGNATURE_VERIFICATION_FAILED') {
			throw new OidcError(`Could not verify the identity token signature: ${err.message}`);
		}
		throw new OidcError(`The identity token is not valid: ${err.message}`);
	}
	if (claims.nonce !== nonce) {
		throw new OidcError('The identity token nonce did not match. Please try signing in again.');
	}
	return claims;
}

/** Userinfo is best effort: providers differ on which claims ride in the id_token. */
export async function fetchUserinfo(s: OidcSettings, accessToken: string): Promise<Record<string, unknown>> {
	const { config, metadata } = await discover(s);
	if (!metadata.userinfo_endpoint || !accessToken) return {};
	try {
		return { ...(await oc.fetchUserInfo(config, accessToken, oc.skipSubjectCheck)) };
	} catch {
		return {};
	}
}

// ---------------------------------------------------------------- test discovery

export interface DiscoveryReport {
	ok: boolean;
	message: string;
	authorizationEndpoint: string | null;
	tokenEndpoint: string | null;
	userinfoEndpoint: string | null;
	jwksUri: string | null;
}

export async function testDiscovery(s: OidcSettings): Promise<DiscoveryReport> {
	const empty = { authorizationEndpoint: null, tokenEndpoint: null, userinfoEndpoint: null, jwksUri: null };
	if (!s.oidcIssuer || !s.oidcClientId) {
		return { ok: false, message: 'Set an issuer URL and client id first.', ...empty };
	}
	let metadata: Record<string, any>;
	try {
		metadata = (await discover(s, true)).metadata;
	} catch (e) {
		return { ok: false, message: (e as Error).message, ...empty };
	}
	const supported = (metadata.scopes_supported as string[] | undefined) ?? [];
	const missing = s.oidcScopes.split(/\s+/).filter((x) => x && supported.length && !supported.includes(x));
	let message = `Reached ${metadata.issuer ?? s.oidcIssuer}.`;
	if (missing.length) message += ` Provider does not advertise scope(s): ${missing.join(', ')}.`;
	return {
		ok: missing.length === 0,
		message,
		authorizationEndpoint: metadata.authorization_endpoint ?? null,
		tokenEndpoint: metadata.token_endpoint ?? null,
		userinfoEndpoint: metadata.userinfo_endpoint ?? null,
		jwksUri: metadata.jwks_uri ?? null
	};
}

// ---------------------------------------------------------------- claim mapping

/** The group list out of the claims, tolerating provider variance. */
export function extractGroups(claims: Record<string, unknown>, groupsClaim: string): string[] {
	const raw = claims[groupsClaim];
	if (raw === undefined || raw === null) return [];
	if (typeof raw === 'string') return raw.replace(/,/g, ' ').split(/\s+/).filter(Boolean);
	if (Array.isArray(raw)) return raw.filter((x) => x !== null && x !== undefined).map(String);
	return [];
}

function displayName(claims: Record<string, unknown>, email: string | null, subject: string): string {
	for (const key of ['name', 'preferred_username', 'nickname']) {
		const v = claims[key];
		if (typeof v === 'string' && v.trim()) return v.trim().slice(0, 255);
	}
	const given = String(claims.given_name ?? '').trim();
	const family = String(claims.family_name ?? '').trim();
	if (given || family) return `${given} ${family}`.trim().slice(0, 255);
	if (email) {
		return email
			.split('@')[0]!
			.replace(/[._-]/g, ' ')
			.replace(/\b\w/g, (c) => c.toUpperCase())
			.slice(0, 255);
	}
	return subject.slice(0, 255);
}

/**
 * Map verified claims to an OPAL user, provisioning when allowed. Order: the (issuer, subject)
 * link; an existing account with the same verified email and no link yet; auto-provision.
 * Throws OidcError when the identity may not sign in. Runs inside the caller's transaction.
 */
export function resolveIdentity(ctx: Ctx, s: OidcSettings, claims: Record<string, unknown>): UserRow {
	const subject = String(claims.sub ?? '').trim();
	if (!subject) throw new OidcError('The identity provider returned no subject claim.');

	const emailRaw = claims.email;
	let email = typeof emailRaw === 'string' && emailRaw ? emailRaw.trim().toLowerCase() : null;
	const unverified = !!email && (claims.email_verified === false || claims.email_verified === 'false');
	// An unverified email must never claim an existing account.
	if (unverified) email = null;

	const groups = extractGroups(claims, s.oidcGroupsClaim);
	const grantsAdmin = !!s.oidcAdminGroup && groups.includes(s.oidcAdminGroup);

	let u: UserRow | undefined = ctx.db
		.select()
		.from(user)
		.where(and(eq(user.oidcIssuer, s.oidcIssuer), eq(user.oidcSubject, subject)))
		.get();

	if (!u && email) {
		const candidate = ctx.db
			.select()
			.from(user)
			.where(and(eq(sql`lower(${user.email})`, email), isNull(user.oidcSubject)))
			.get();
		if (candidate) u = update(ctx, user, candidate.id, { oidcIssuer: s.oidcIssuer, oidcSubject: subject });
	}

	let bootstrapAdmin = false;
	if (!u) {
		if (!s.oidcAutoCreateUsers) {
			throw new OidcError(
				`This identity has no OPAL account. Ask an administrator to create one${email ? ` for ${email}` : ''}.`
			);
		}
		if (unverified) {
			throw new OidcError(
				'The identity provider reports this email address as unverified. Verify it, then sign in again.'
			);
		}
		// The first account on a fresh install is admin whatever the groups say, so nobody is locked out.
		bootstrapAdmin = ctx.db.select({ id: user.id }).from(user).get() === undefined;
		const seed = String(claims.preferred_username ?? '') || (email ? email.split('@')[0]! : '') || displayName(claims, email, subject);
		u = insert(ctx, user, {
			name: displayName(claims, email, subject),
			username: uniqueUsername(ctx, seed),
			email,
			passwordHash: null,
			oidcIssuer: s.oidcIssuer,
			oidcSubject: subject,
			isActive: true,
			isAdmin: bootstrapAdmin || grantsAdmin
		});
	}

	if (!u.isActive) throw new OidcError('This account is deactivated.');

	// Attributes the provider owns refresh on every sign-in.
	if (email && u.email !== email) {
		// Another account holding this address means the provider and OPAL disagree: keep OPAL's value.
		const clash = ctx.db
			.select({ id: user.id })
			.from(user)
			.where(and(eq(sql`lower(${user.email})`, email), ne(user.id, u.id)))
			.get();
		if (!clash) u = update(ctx, user, u.id, { email });
	}
	if (s.oidcAdminGroup && !bootstrapAdmin) u = syncAdmin(ctx, s, claims, groups, u, grantsAdmin);
	return u;
}

/**
 * Map the admin group onto is_admin, but never on missing evidence (a token without the groups
 * claim says nothing) and never so that the instance is left without an administrator.
 */
function syncAdmin(
	ctx: Ctx,
	s: OidcSettings,
	claims: Record<string, unknown>,
	_groups: string[],
	u: UserRow,
	grantsAdmin: boolean
): UserRow {
	if (grantsAdmin === u.isAdmin) return u;
	if (!(s.oidcGroupsClaim in claims)) return u;
	if (!grantsAdmin) {
		const other = ctx.db
			.select({ id: user.id })
			.from(user)
			.where(and(eq(user.isAdmin, true), eq(user.isActive, true), ne(user.id, u.id)))
			.get();
		if (!other) return u; // the last active administrator keeps admin
	}
	return update(ctx, user, u.id, { isAdmin: grantsAdmin });
}
