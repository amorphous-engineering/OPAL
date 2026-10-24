/**
 * The OIDC browser handshake. These two routes are full-page redirects (the provider sends the
 * browser back to /oidc/callback), so they are plain Hono routes, not JSON operations.
 *
 * Failures land on /login?error=... where the web client shows the message. State, nonce and the
 * PKCE verifier ride in one short-lived HMAC-signed cookie, so the handshake needs no storage.
 */
import { timingSafeEqual } from 'node:crypto';
import type { Context, Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import * as oc from 'openid-client';
import type { Ctx } from '../context.ts';
import type { Db } from '../db/client.ts';
import {
	buildAuthorizationUrl,
	exchangeCode,
	fetchUserinfo,
	makePkcePair,
	OidcError,
	redirectUri,
	resolveIdentity,
	STATE_COOKIE,
	STATE_MAX_AGE_MS,
	verifyIdToken
} from '../services/auth/oidc.ts';
import { mintSession } from '../services/auth/sessions.ts';
import { oidcActive, readSettings } from '../services/auth/settings.ts';
import { inTransaction } from '../services/auth/tx.ts';
import { signPayload, verifyPayload } from './signing.ts';
import { SESSION_COOKIE, SESSION_LIFETIME_MS } from './tokens.ts';

/** Confine post-login redirects to this app. */
export function safeNext(value: string | undefined | null): string {
	if (!value || !value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return '/';
	return value;
}

const trustProxy = () => /^(1|true|yes|on)$/i.test(process.env.OPAL_TRUST_PROXY ?? '');

/** Scheme and host the browser used, seeing through a trusted reverse proxy. */
function requestBase(c: Context): { base: string; secure: boolean } {
	const url = new URL(c.req.url);
	let proto = url.protocol.replace(':', '');
	let host = c.req.header('host') ?? url.host;
	if (trustProxy()) {
		proto = c.req.header('x-forwarded-proto')?.split(',')[0]?.trim() || proto;
		host = c.req.header('x-forwarded-host')?.split(',')[0]?.trim() || host;
	}
	return { base: `${proto}://${host}`, secure: proto === 'https' };
}

function loginError(c: Context, message: string): Response {
	console.warn(`OIDC sign-in failed: ${message}`);
	deleteCookie(c, STATE_COOKIE, { path: '/' });
	return c.redirect(`/login?error=${encodeURIComponent(message)}`, 302);
}

const sameString = (a: string, b: string) => {
	const x = Buffer.from(a);
	const y = Buffer.from(b);
	return x.length === y.length && timingSafeEqual(x, y);
};

export function mountOidc(app: Hono, db: Db): void {
	app.get('/oidc/login', async (c) => {
		const settings = readSettings(db);
		if (!oidcActive(settings)) return c.redirect('/login', 302);
		const { base, secure } = requestBase(c);
		const state = oc.randomState();
		const nonce = oc.randomNonce();
		const { verifier, challenge } = await makePkcePair();
		let target: string;
		try {
			target = await buildAuthorizationUrl(settings, redirectUri(base, settings), state, nonce, challenge);
		} catch (e) {
			if (e instanceof OidcError) return loginError(c, e.message);
			throw e;
		}
		setCookie(
			c,
			STATE_COOKIE,
			signPayload(
				{ kind: 'oidc-state', state, nonce, verifier, next: safeNext(c.req.query('next')) },
				STATE_MAX_AGE_MS
			),
			{
				path: '/',
				maxAge: STATE_MAX_AGE_MS / 1000,
				httpOnly: true,
				// The provider redirects back cross-site; Lax survives a top-level GET.
				sameSite: 'Lax',
				secure
			}
		);
		return c.redirect(target, 302);
	});

	app.get('/oidc/callback', async (c) => {
		const settings = readSettings(db);
		if (!oidcActive(settings)) return c.redirect('/login', 302);
		const q = c.req.query();
		if (q.error) {
			return loginError(c, `The identity provider refused the sign-in: ${q.error_description || q.error}`);
		}
		if (!q.code || !q.state) return loginError(c, 'The identity provider returned an incomplete response.');
		const stored = verifyPayload(getCookie(c, STATE_COOKIE));
		if (!stored || stored.kind !== 'oidc-state' || !stored.state || !stored.nonce || !stored.verifier) {
			return loginError(c, 'The sign-in request expired. Please try again.');
		}
		// Constant-time compare: state is the CSRF defence for the whole flow.
		if (!sameString(String(stored.state), q.state)) {
			return loginError(c, 'The sign-in request did not match. Please try again.');
		}
		const { base, secure } = requestBase(c);
		try {
			// Network first, outside the write transaction.
			const tokens = await exchangeCode(settings, q.code, redirectUri(base, settings), String(stored.verifier));
			let claims = await verifyIdToken(settings, tokens.idToken, String(stored.nonce));
			// Groups often live only in userinfo; merge it over the id_token claims.
			const info = await fetchUserinfo(settings, tokens.accessToken);
			if (Object.keys(info).length && String(info.sub ?? claims.sub) === String(claims.sub)) {
				claims = { ...claims, ...info };
			}
			const ctx: Ctx = {
				db,
				actor: { kind: 'system' },
				op: 'auth.oidc.callback',
				request: {
					userAgent: c.req.header('user-agent') ?? null,
					ip: c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ?? null
				}
			};
			const raw = await inTransaction(db, () => mintSession(ctx, resolveIdentity(ctx, settings, claims), 'oidc'));
			setCookie(c, SESSION_COOKIE, raw, {
				path: '/',
				httpOnly: true,
				sameSite: 'Lax',
				secure,
				maxAge: SESSION_LIFETIME_MS / 1000
			});
			deleteCookie(c, STATE_COOKIE, { path: '/' });
			return c.redirect(safeNext(String(stored.next ?? '/')), 302);
		} catch (e) {
			if (e instanceof OidcError) return loginError(c, e.message);
			throw e;
		}
	});
}
