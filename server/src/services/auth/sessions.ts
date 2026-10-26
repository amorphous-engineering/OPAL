/** Session minting and revocation, shared by every sign-in method. */
import { and, eq, isNull, ne } from 'drizzle-orm';
import {
	addMs,
	hashToken,
	newToken,
	humanUsernameBase,
	SESSION_COOKIE,
	SESSION_LIFETIME_MS
} from '../../auth/tokens.ts';
import type { Ctx } from '../../context.ts';
import { session, user } from '../../db/schema/index.ts';
import { insert, update } from '../../write.ts';

export type UserRow = typeof user.$inferSelect;

/** Mint a session row and return the raw cookie token. `method` is password, passkey or oidc. */
export function mintSession(ctx: Ctx, u: UserRow, method: string): string {
	const raw = newToken();
	insert(ctx, session, {
		userId: u.id,
		tokenHash: hashToken(raw),
		method,
		expiresAt: addMs(SESSION_LIFETIME_MS),
		lastSeenAt: new Date().toISOString(),
		userAgent: ctx.request?.userAgent?.slice(0, 255) || null,
		ipAddress: ctx.request?.ip?.slice(0, 64) || null
	});
	return raw;
}

/** Mint a session and set the cookie through the request's cookie jar. */
export function startSession(ctx: Ctx, u: UserRow, method: string): void {
	const raw = mintSession(ctx, u, method);
	ctx.cookies?.set(SESSION_COOKIE, raw, {
		httpOnly: true,
		sameSite: 'Lax',
		secure: ctx.cookies.secure,
		maxAge: SESSION_LIFETIME_MS / 1000
	});
}

/** End every live session of a user, optionally keeping one. Returns how many ended. */
export function revokeSessions(ctx: Ctx, userId: number, exceptSessionId?: number): number {
	const rows = ctx.db
		.select()
		.from(session)
		.where(
			and(
				eq(session.userId, userId),
				isNull(session.revokedAt),
				exceptSessionId === undefined ? undefined : ne(session.id, exceptSessionId)
			)
		)
		.all();
	const at = new Date().toISOString();
	for (const r of rows) update(ctx, session, r.id, { revokedAt: at });
	return rows.length;
}

/** A free username derived from `raw`: digits are appended until it is unique. */
export function uniqueUsername(ctx: Ctx, raw: string): string {
	const base = humanUsernameBase(raw);
	let candidate = base;
	for (let n = 2; ctx.db.select({ id: user.id }).from(user).where(eq(user.username, candidate)).get(); n++) {
		candidate = `${base.slice(0, 64 - String(n).length)}${n}`;
	}
	return candidate;
}
