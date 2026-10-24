/** Resolves the actor of a request from the session cookie or a bearer API token. */
import { and, eq } from 'drizzle-orm';
import type { Context } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import type { Actor } from '../context.ts';
import type { Db } from '../db/client.ts';
import { apiToken, session, user } from '../db/schema/index.ts';
import { type ResolveActor, serialized } from '../registry.ts';
import {
	addMs,
	API_TOKEN_PREFIX,
	expired,
	hashToken,
	SESSION_COOKIE,
	SESSION_LIFETIME_MS,
	TOUCH_INTERVAL_MS
} from './tokens.ts';

const stale = (at: string | null) => !at || Date.now() - Date.parse(at) > TOUCH_INTERVAL_MS;

export function actorResolver(db: Db): ResolveActor {
	return (c: Context): Actor => {
		const header = c.req.header('authorization') ?? '';
		const bearer = /^Bearer\s+(\S+)/i.exec(header)?.[1];
		if (bearer) return fromToken(db, bearer);
		return fromCookie(db, c, getCookie(c, SESSION_COOKIE));
	};
}

function fromToken(db: Db, raw: string): Actor {
	if (!raw.startsWith(API_TOKEN_PREFIX)) return { kind: 'anonymous' };
	const row = db
		.select({ t: apiToken, u: user })
		.from(apiToken)
		.innerJoin(user, eq(user.id, apiToken.userId))
		.where(eq(apiToken.tokenHash, hashToken(raw)))
		.get();
	if (!row || row.t.revokedAt || expired(row.t.expiresAt) || !row.u.isActive) {
		return { kind: 'anonymous' };
	}
	// Bookkeeping, not business data: written directly (no audit row) and at most
	// once a minute, so reading never fills the audit log.
	if (stale(row.t.lastUsedAt)) {
		// Queued behind any running write so it never joins that write's transaction.
		void serialized(async () =>
			db.update(apiToken)
				.set({ lastUsedAt: new Date().toISOString() })
				.where(eq(apiToken.id, row.t.id))
				.run()
		);
	}
	return { kind: 'token', userId: row.u.id, isAdmin: row.u.isAdmin, tokenId: row.t.id };
}

function fromCookie(db: Db, c: Context, raw: string | undefined): Actor {
	if (!raw) return { kind: 'anonymous' };
	const row = db
		.select({ s: session, u: user })
		.from(session)
		.innerJoin(user, eq(user.id, session.userId))
		.where(and(eq(session.tokenHash, hashToken(raw))))
		.get();
	if (!row || row.s.revokedAt || expired(row.s.expiresAt) || !row.u.isActive) {
		return { kind: 'anonymous' };
	}
	// Same bookkeeping rule as tokens. The slide also renews the cookie.
	if (stale(row.s.lastSeenAt)) {
		// Queued behind any running write so it never joins that write's transaction.
		void serialized(async () =>
			db.update(session)
				.set({ lastSeenAt: new Date().toISOString(), expiresAt: addMs(SESSION_LIFETIME_MS) })
				.where(eq(session.id, row.s.id))
				.run()
		);
		setCookie(c, SESSION_COOKIE, raw, {
			path: '/',
			httpOnly: true,
			sameSite: 'Lax',
			secure: new URL(c.req.url).protocol === 'https:',
			maxAge: SESSION_LIFETIME_MS / 1000
		});
	}
	return { kind: 'user', userId: row.u.id, isAdmin: row.u.isAdmin, sessionId: row.s.id };
}
