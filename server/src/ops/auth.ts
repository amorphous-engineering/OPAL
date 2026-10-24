import { conflict, contracts, notFound, OpalError } from '@opal/shared';
import { and, count, desc, eq, isNull } from 'drizzle-orm';
import {
	addMs,
	API_TOKEN_PREFIX,
	burnVerify,
	hashPassword,
	hashToken,
	loginThrottle,
	newToken,
	normalizeUsername,
	SESSION_COOKIE,
	SESSION_LIFETIME_MS,
	validatePasswordStrength,
	verifyPassword
} from '../auth/tokens.ts';
import type { Ctx } from '../context.ts';
import { apiToken, session, user } from '../db/schema/index.ts';
import { type Impl, implement } from '../registry.ts';
import { insert, update } from '../write.ts';

type UserRow = typeof user.$inferSelect;

const present = (u: UserRow) => ({
	id: u.id,
	username: u.username,
	name: u.name,
	email: u.email,
	isAdmin: u.isAdmin
});

const envOn = (name: string, fallback: boolean) => {
	const v = process.env[name];
	return v === undefined ? fallback : /^(1|true|yes|on)$/i.test(v);
};
const passwordLoginEnabled = () => envOn('OPAL_PASSWORD_LOGIN_ENABLED', true);

/** Mint a session and set the cookie. The method column keeps passkey and OIDC open. */
function startSession(ctx: Ctx, u: UserRow, method: string): void {
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
	ctx.cookies?.set(SESSION_COOKIE, raw, {
		httpOnly: true,
		sameSite: 'Lax',
		secure: ctx.cookies.secure,
		maxAge: SESSION_LIFETIME_MS / 1000
	});
}

const needsSetup = (ctx: Ctx) => ctx.db.select({ n: count() }).from(user).get()!.n === 0;

export const authImpls = [
	implement(contracts.auth.config, (ctx) => ({
		needsSetup: needsSetup(ctx),
		passwordLoginEnabled: passwordLoginEnabled(),
		passkeysEnabled: false,
		oidcEnabled: false
	})),

	implement(contracts.auth.setup, async (ctx, input) => {
		if (!needsSetup(ctx)) throw conflict('setup_complete', 'Setup is already complete');
		const username = normalizeUsername(input.username);
		if (!username) throw new OpalError(422, 'invalid_input', 'Invalid input', { username: 'Username is required' });
		const weak = validatePasswordStrength(input.password);
		if (weak) throw new OpalError(422, 'invalid_input', 'Invalid input', { password: weak });
		const u = insert(ctx, user, {
			username,
			name: input.name,
			email: input.email?.trim() || null,
			passwordHash: await hashPassword(input.password),
			isAdmin: true,
			isActive: true
		});
		startSession(ctx, u, 'password');
		return { user: present(u) };
	}),

	implement(contracts.auth.login, async (ctx, input) => {
		if (!passwordLoginEnabled()) throw new OpalError(403, 'forbidden', 'Password sign-in is disabled');
		const username = input.username.trim().toLowerCase();
		const key = `${ctx.request?.ip ?? 'unknown'}:${username}`;
		if (loginThrottle.blocked(key)) {
			throw new OpalError(429, 'too_many_attempts', 'Too many failed attempts. Try again later.');
		}
		const u = ctx.db.select().from(user).where(eq(user.username, username)).get();
		const ok = u?.isActive ? await verifyPassword(u.passwordHash, input.password) : false;
		if (!u || !ok) {
			if (!u || !u.isActive || !u.passwordHash) await burnVerify(input.password);
			loginThrottle.fail(key);
			// One message for unknown user, wrong password, inactive and passwordless accounts.
			throw new OpalError(401, 'invalid_credentials', 'Invalid username or password');
		}
		loginThrottle.reset(key);
		startSession(ctx, u, 'password');
		return { user: present(u) };
	}),

	implement(contracts.auth.logout, (ctx) => {
		if (ctx.actor.kind === 'user') {
			update(ctx, session, ctx.actor.sessionId, { revokedAt: new Date().toISOString() });
		}
		ctx.cookies?.delete(SESSION_COOKIE, { secure: ctx.cookies.secure });
		return { ok: true as const };
	}),

	implement(contracts.auth.me, (ctx) => {
		const id = ctx.actor.kind === 'user' || ctx.actor.kind === 'token' ? ctx.actor.userId : null;
		const u = id === null ? undefined : ctx.db.select().from(user).where(eq(user.id, id)).get();
		if (!u) throw notFound('User');
		return present(u);
	}),

	implement(contracts.auth.tokens.list, (ctx) => {
		const id = userId(ctx);
		const rows = ctx.db
			.select()
			.from(apiToken)
			.where(and(eq(apiToken.userId, id), isNull(apiToken.revokedAt)))
			.orderBy(desc(apiToken.createdAt), desc(apiToken.id))
			.all();
		return {
			items: rows.map((r) => ({
				id: r.id,
				name: r.name,
				createdAt: r.createdAt,
				lastUsedAt: r.lastUsedAt,
				expiresAt: r.expiresAt
			}))
		};
	}),

	implement(contracts.auth.tokens.create, (ctx, input) => {
		const raw = newToken(API_TOKEN_PREFIX);
		const row = insert(ctx, apiToken, {
			userId: userId(ctx),
			name: input.name,
			tokenHash: hashToken(raw),
			expiresAt: input.expiresInDays ? addMs(input.expiresInDays * 86_400_000) : null
		});
		return { id: row.id, name: row.name, token: raw, expiresAt: row.expiresAt };
	}),

	implement(contracts.auth.tokens.revoke, (ctx, input) => {
		const row = ctx.db.select().from(apiToken).where(eq(apiToken.id, input.id)).get();
		if (!row || row.userId !== userId(ctx)) throw notFound('Token');
		if (!row.revokedAt) update(ctx, apiToken, row.id, { revokedAt: new Date().toISOString() });
		return { ok: true as const };
	})
] as Impl[];

function userId(ctx: Ctx): number {
	if (ctx.actor.kind !== 'user' && ctx.actor.kind !== 'token') {
		throw new OpalError(403, 'forbidden', 'Not permitted');
	}
	return ctx.actor.userId;
}
