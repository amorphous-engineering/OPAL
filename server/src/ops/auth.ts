import { conflict, contracts, forbidden, notFound, now, OpalError } from '@opal/shared';
import { and, count, desc, eq, gt, isNull } from 'drizzle-orm';
import {
	addMs,
	API_TOKEN_PREFIX,
	burnVerify,
	hashPassword,
	hashToken,
	loginThrottle,
	usernameThrottle,
	withHashSlot,
	newToken,
	isPluginUsername,
	normalizeUsername,
	SESSION_COOKIE,
	validatePasswordStrength,
	verifyPassword
} from '../auth/tokens.ts';
import { signPayload, verifyPayload } from '../auth/signing.ts';
import type { Ctx } from '../context.ts';
import type { Db } from '../db/client.ts';
import { personRefs } from '../services/org/people.ts';
import { profileState, timeDisplayOf } from '../services/org/profiles.ts';
import { apiToken, session, user } from '../db/schema/index.ts';
import { passkeyCredential, webauthnChallenge } from '../db/schema/auth.ts';
import { type Impl, implement, serialized } from '../registry.ts';
import { oidcActive, readSettings, type SignInSettings, writeSetting } from '../services/auth/settings.ts';
import {
	activeUser,
	beginAuthentication,
	beginRegistration,
	completeAuthentication,
	completeRegistration,
	consumeChallenge,
	PASSKEY_STATE_COOKIE,
	PasskeyError,
	rpIdFor,
	storeChallenge,
	touchCredential
} from '../services/auth/passkeys.ts';
import {
	checkAuthorizeRequest,
	errorRedirect,
	issueCode,
	OAuthError,
	requestProblem,
	type AuthorizeRequest
} from '../services/auth/oauth.ts';
import { resetDiscoveryCache, testDiscovery } from '../services/auth/oidc.ts';
import { revokeSessions, startSession, type UserRow } from '../services/auth/sessions.ts';
import { insert, remove, update } from '../write.ts';

const present = (db: Db, u: UserRow) => ({
	id: u.id,
	username: u.username,
	name: u.name,
	email: u.email,
	isAdmin: u.isAdmin,
	...profileState(db, u.id),
	timeDisplay: timeDisplayOf(db, u.id),
	avatarUrl: personRefs(db, [u.id]).get(u.id)?.avatarUrl ?? null
});

const needsSetup = (ctx: Ctx) => ctx.db.select({ n: count() }).from(user).get()!.n === 0;

const invalid = (field: string, message: string) =>
	new OpalError(422, 'invalid_input', 'Invalid input', { [field]: message });

function userId(ctx: Ctx): number {
	if (ctx.actor.kind !== 'user' && ctx.actor.kind !== 'token') throw forbidden();
	return ctx.actor.userId;
}

/** A bad client or redirect URI is shown on the page, never sent to the redirect URI. */
function oauthClient(input: AuthorizeRequest) {
	try {
		return checkAuthorizeRequest(input);
	} catch (e) {
		if (e instanceof OAuthError) throw new OpalError(400, e.code, e.message);
		throw e;
	}
}

const currentSessionId = (ctx: Ctx) => (ctx.actor.kind === 'user' ? ctx.actor.sessionId : undefined);

// ---------------------------------------------------------------- passkey cookie helpers

function setStateCookie(ctx: Ctx, payload: Record<string, unknown>): void {
	ctx.cookies?.set(PASSKEY_STATE_COOKIE, signPayload(payload, 300_000), {
		httpOnly: true,
		sameSite: 'Lax',
		secure: ctx.cookies.secure,
		maxAge: 300
	});
}

/** A failed attempt must not be retryable on the same challenge, but a throw rolls the write back. */
function burnAfterRollback(ctx: Ctx, nonce: unknown): void {
	if (typeof nonce !== 'string') return;
	void serialized(async () => {
		ctx.db.delete(webauthnChallenge).where(eq(webauthnChallenge.nonce, nonce)).run();
	});
}

function requirePasskeys(s: SignInSettings): void {
	if (!s.passkeysEnabled) throw forbidden('Passkeys are disabled on this OPAL instance');
}

const passkeyInfo = (r: typeof passkeyCredential.$inferSelect) => ({
	id: r.id,
	name: r.name,
	createdAt: r.createdAt,
	lastUsedAt: r.lastUsedAt,
	transports: r.transports
});

// ---------------------------------------------------------------- settings view

const settingsView = (s: SignInSettings) => ({
	passwordLoginEnabled: s.passwordLoginEnabled,
	passkeysEnabled: s.passkeysEnabled,
	oidcEnabled: s.oidcEnabled,
	oidcIssuer: s.oidcIssuer,
	oidcClientId: s.oidcClientId,
	hasClientSecret: !!s.oidcClientSecret,
	oidcScopes: s.oidcScopes,
	oidcProviderName: s.oidcProviderName,
	oidcGroupsClaim: s.oidcGroupsClaim,
	oidcAdminGroup: s.oidcAdminGroup,
	oidcAutoCreateUsers: s.oidcAutoCreateUsers,
	oidcRedirectBaseUrl: s.oidcRedirectBaseUrl,
	callbackUrl: s.oidcRedirectBaseUrl ? `${s.oidcRedirectBaseUrl}/oidc/callback` : null
});

const flag = (v: boolean) => (v ? 'true' : 'false');

export const authImpls = [
	implement(contracts.auth.config, (ctx) => {
		const s = readSettings(ctx.db);
		const oidc = oidcActive(s);
		return {
			needsSetup: needsSetup(ctx),
			passwordLoginEnabled: s.passwordLoginEnabled,
			passkeysEnabled: s.passkeysEnabled,
			oidcEnabled: oidc,
			oidcProviderName: oidc ? s.oidcProviderName : null
		};
	}),

	implement(contracts.auth.setup, async (ctx, input) => {
		if (!needsSetup(ctx)) throw conflict('setup_complete', 'Setup is already complete');
		const username = normalizeUsername(input.username);
		if (!username) throw invalid('username', 'Username is required');
		if (isPluginUsername(username)) throw invalid('username', 'The plugin. prefix is reserved for plugins');
		const weak = validatePasswordStrength(input.password);
		if (weak) throw invalid('password', weak);
		// Always credentialed: an admin who lives only in an identity provider has no way back in
		// when the provider is down.
		const passwordHash = await withHashSlot(() => hashPassword(input.password));
		return ctx.write!(() => {
			// Another setup request may have finished while this one hashed.
			if (!needsSetup(ctx)) throw conflict('setup_complete', 'Setup is already complete');
			const u = insert(ctx, user, {
				username,
				name: input.name,
				email: input.email?.trim() || null,
				passwordHash,
				isAdmin: true,
				isActive: true
			});
			startSession(ctx, u, 'password');
			return { user: present(ctx.db, u) };
		});
	}, { verifyFirst: true }),

	implement(contracts.auth.login, async (ctx, input) => {
		if (!readSettings(ctx.db).passwordLoginEnabled) {
			throw new OpalError(403, 'forbidden', 'Password sign-in is disabled');
		}
		const username = input.username.trim().toLowerCase();
		const key = `${ctx.request?.ip ?? 'unknown'}:${username}`;
		const nameKey = `name:${username}`;
		if (loginThrottle.blocked(key) || usernameThrottle.blocked(nameKey)) {
			throw new OpalError(429, 'too_many_attempts', 'Too many failed attempts. Try again later.');
		}
		// Count the attempt before the hash runs, so requests sent at once cannot all pass the check.
		loginThrottle.fail(key);
		usernameThrottle.fail(nameKey);
		const u = ctx.db.select().from(user).where(eq(user.username, username)).get();
		const ok = await withHashSlot(async () => {
			const good = u?.isActive ? await verifyPassword(u.passwordHash, input.password) : false;
			if (!u || !u.isActive || !u.passwordHash) await burnVerify(input.password);
			return good;
		});
		if (!u || !ok) {
			// One message for unknown user, wrong password, inactive and passwordless accounts.
			throw new OpalError(401, 'invalid_credentials', 'Invalid username or password');
		}
		loginThrottle.reset(key);
		usernameThrottle.release(nameKey);
		return ctx.write!(() => {
			startSession(ctx, u, 'password');
			return { user: present(ctx.db, u) };
		});
	}, { verifyFirst: true }),

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
		return present(ctx.db, u);
	}),

	// ------------------------------------------------------------ password

	implement(contracts.auth.password.change, async (ctx, input) => {
		const u = ctx.db.select().from(user).where(eq(user.id, userId(ctx))).get();
		if (!u) throw notFound('User');
		// Accounts without a password (single sign-on) may set a first one without proving a current one.
		if (u.passwordHash && !(await verifyPassword(u.passwordHash, input.currentPassword ?? ''))) {
			throw forbidden('Current password is incorrect');
		}
		const weak = validatePasswordStrength(input.newPassword);
		if (weak) throw invalid('newPassword', weak);
		update(ctx, user, u.id, { passwordHash: await hashPassword(input.newPassword) });
		return { ok: true as const, otherSessionsRevoked: revokeSessions(ctx, u.id, currentSessionId(ctx)) };
	}),

	// ------------------------------------------------------------ sessions

	implement(contracts.auth.sessions.list, (ctx) => {
		const current = currentSessionId(ctx);
		const rows = ctx.db
			.select()
			.from(session)
			.where(
				and(eq(session.userId, userId(ctx)), isNull(session.revokedAt), gt(session.expiresAt, now()))
			)
			.orderBy(desc(session.lastSeenAt), desc(session.id))
			.all();
		return {
			items: rows.map((r) => ({
				id: r.id,
				method: r.method,
				createdAt: r.createdAt,
				lastSeenAt: r.lastSeenAt,
				userAgent: r.userAgent,
				ipAddress: r.ipAddress,
				current: r.id === current
			}))
		};
	}),

	implement(contracts.auth.sessions.revoke, (ctx, input) => {
		const row = ctx.db.select().from(session).where(eq(session.id, input.id)).get();
		if (!row || row.userId !== userId(ctx)) throw notFound('Session');
		if (!row.revokedAt) update(ctx, session, row.id, { revokedAt: new Date().toISOString() });
		return { ok: true as const };
	}),

	implement(contracts.auth.sessions.revokeOthers, (ctx) => ({
		ok: true as const,
		revoked: revokeSessions(ctx, userId(ctx), currentSessionId(ctx))
	})),

	// ------------------------------------------------------------ passkeys

	implement(contracts.auth.passkeys.list, (ctx) => ({
		items: ctx.db
			.select()
			.from(passkeyCredential)
			.where(eq(passkeyCredential.userId, userId(ctx)))
			.orderBy(passkeyCredential.id)
			.all()
			.map(passkeyInfo)
	})),

	implement(contracts.auth.passkeys.rename, (ctx, input) => {
		const row = ctx.db.select().from(passkeyCredential).where(eq(passkeyCredential.id, input.id)).get();
		if (!row || row.userId !== userId(ctx)) throw notFound('Passkey');
		return passkeyInfo(update(ctx, passkeyCredential, row.id, { name: input.name }));
	}),

	implement(contracts.auth.passkeys.delete, (ctx, input) => {
		const row = ctx.db.select().from(passkeyCredential).where(eq(passkeyCredential.id, input.id)).get();
		if (!row || row.userId !== userId(ctx)) throw notFound('Passkey');
		remove(ctx, passkeyCredential, row.id);
		return { ok: true as const };
	}),

	implement(contracts.auth.passkeys.registerBegin, async (ctx, input) => {
		const s = readSettings(ctx.db);
		requirePasskeys(s);
		const u = ctx.db.select().from(user).where(eq(user.id, userId(ctx))).get();
		if (!u) throw notFound('User');
		const rpId = rpIdFor(s.passkeyRpId, input.rpId);
		const { options, state } = await beginRegistration(ctx.db, u, rpId);
		const nonce = storeChallenge(ctx.db, 'register', rpId, state, u.id);
		setStateCookie(ctx, { kind: 'register', nonce, uid: u.id });
		return { publicKey: options as unknown as Record<string, unknown> };
	}),

	implement(contracts.auth.passkeys.registerComplete, async (ctx, input) => {
		requirePasskeys(readSettings(ctx.db));
		const uid = userId(ctx);
		const payload = verifyPayload(ctx.cookies?.get(PASSKEY_STATE_COOKIE));
		const challenge =
			payload && payload.kind === 'register' && payload.uid === uid
				? consumeChallenge(ctx.db, payload.nonce as string, 'register')
				: null;
		if (!challenge || challenge.userId !== uid) {
			burnAfterRollback(ctx, payload?.nonce);
			throw new OpalError(400, 'bad_challenge', 'Missing or expired registration challenge');
		}
		try {
			const made = await completeRegistration(challenge, input.credential as never);
			const row = insert(ctx, passkeyCredential, {
				userId: uid,
				credentialId: made.credentialId,
				publicKey: made.publicKey,
				signCount: made.signCount,
				name: input.name.slice(0, 100) || 'Passkey',
				aaguid: made.aaguid,
				transports: made.transports,
				lastUsedAt: null
			});
			ctx.cookies?.delete(PASSKEY_STATE_COOKIE, { secure: ctx.cookies.secure });
			return { ok: true as const, id: row.id, name: row.name };
		} catch (e) {
			if (e instanceof PasskeyError || e instanceof Error) {
				throw new OpalError(400, 'passkey_failed', `Passkey registration failed: ${e.message}`);
			}
			throw e;
		}
	}),

	implement(contracts.auth.passkeys.loginBegin, async (ctx, input) => {
		const s = readSettings(ctx.db);
		requirePasskeys(s);
		const rpId = rpIdFor(s.passkeyRpId, input.rpId);
		const { options, state } = await beginAuthentication(rpId);
		const nonce = storeChallenge(ctx.db, 'login', rpId, state);
		setStateCookie(ctx, { kind: 'login', nonce });
		return { publicKey: options as unknown as Record<string, unknown> };
	}),

	implement(contracts.auth.passkeys.loginComplete, async (ctx, input) => {
		requirePasskeys(readSettings(ctx.db));
		const payload = verifyPayload(ctx.cookies?.get(PASSKEY_STATE_COOKIE));
		const challenge =
			payload && payload.kind === 'login' ? consumeChallenge(ctx.db, payload.nonce as string, 'login') : null;
		if (!challenge) {
			burnAfterRollback(ctx, payload?.nonce);
			throw new OpalError(400, 'bad_challenge', 'Missing or expired passkey challenge');
		}
		const result = await completeAuthentication(ctx.db, challenge, input.credential as never);
		const u = result ? activeUser(ctx.db, result.row.userId) : undefined;
		if (!result || !u) {
			burnAfterRollback(ctx, payload?.nonce);
			throw new OpalError(401, 'passkey_failed', 'Passkey authentication failed');
		}
		touchCredential(ctx.db, result.row.id, result.counter, result.row.signCount);
		startSession(ctx, u, 'passkey');
		ctx.cookies?.delete(PASSKEY_STATE_COOKIE, { secure: ctx.cookies.secure });
		return { user: present(ctx.db, u) };
	}),

	// ------------------------------------------------------------ claim links

	implement(contracts.auth.claim.status, (ctx, input) => {
		const u = claimable(ctx, input.token);
		if (!u) throw new OpalError(404, 'not_found', 'This link is invalid or has expired');
		return { username: u.username };
	}),

	implement(contracts.auth.claim.complete, async (ctx, input) => {
		const u = claimable(ctx, input.token);
		if (!u) throw new OpalError(404, 'not_found', 'This link is invalid or has expired');
		const weak = validatePasswordStrength(input.password);
		if (weak) throw invalid('password', weak);
		const passwordHash = await withHashSlot(() => hashPassword(input.password));
		return ctx.write!(() => {
			// The link works once: look again now that the queue is held.
			const again = claimable(ctx, input.token);
			if (!again) throw new OpalError(404, 'not_found', 'This link is invalid or has expired');
			const claimed = update(ctx, user, again.id, { passwordHash });
			startSession(ctx, claimed, 'password');
			return { user: present(ctx.db, claimed) };
		});
	}, { verifyFirst: true }),

	implement(contracts.auth.claimLinks.create, (ctx, input) => {
		const u = ctx.db.select().from(user).where(eq(user.id, input.userId)).get();
		if (!u) throw notFound('User');
		if (!u.isActive || u.passwordHash) {
			throw new OpalError(400, 'not_claimable', 'This account already has a password; no claim link is needed');
		}
		return {
			token: signPayload({ kind: 'account-claim', uid: u.id, born: u.createdAt, rev: u.updatedAt }, CLAIM_LINK_TTL_MS),
			expiresAt: addMs(CLAIM_LINK_TTL_MS)
		};
	}),

	// ------------------------------------------------------------ settings

	implement(contracts.auth.settings.get, (ctx) => settingsView(readSettings(ctx.db))),

	implement(contracts.auth.settings.update, (ctx, input) => {
		const issuer = input.oidcIssuer.trim().replace(/\/+$/, '');
		const clientId = input.oidcClientId.trim();
		const scopes = input.oidcScopes.trim() || 'openid profile email';
		if (input.oidcEnabled) {
			if (!issuer || !clientId) {
				throw invalid('oidcIssuer', 'An issuer URL and client id are required to enable OIDC.');
			}
			// Every token exchange posts the client credential to this host: https, or loopback in development.
			if (!issuer.startsWith('https://') && !/^http:\/\/(localhost|127\.0\.0\.1)([:/]|$)/.test(issuer)) {
				throw invalid('oidcIssuer', 'The issuer URL must be https:// (or a localhost URL for development).');
			}
			if (!scopes.split(/\s+/).includes('openid')) {
				throw invalid('oidcScopes', "The scopes must include 'openid'.");
			}
		}
		// Locking out every interactive sign-in leaves only API tokens, which cannot reach the web UI.
		if (!input.passwordLoginEnabled && !(input.oidcEnabled && issuer)) {
			throw invalid(
				'passwordLoginEnabled',
				'Disabling password sign-in requires a working OIDC provider; otherwise nobody can reach the web UI.'
			);
		}
		writeSetting(ctx, 'password_login_enabled', flag(input.passwordLoginEnabled));
		writeSetting(ctx, 'passkeys_enabled', flag(input.passkeysEnabled));
		writeSetting(ctx, 'oidc_enabled', flag(input.oidcEnabled));
		writeSetting(ctx, 'oidc_issuer', issuer);
		writeSetting(ctx, 'oidc_client_id', clientId);
		if (input.clearClientSecret) writeSetting(ctx, 'oidc_client_secret', '');
		else if (input.oidcClientSecret) writeSetting(ctx, 'oidc_client_secret', input.oidcClientSecret);
		writeSetting(ctx, 'oidc_scopes', scopes);
		writeSetting(ctx, 'oidc_provider_name', input.oidcProviderName.trim() || 'SSO');
		writeSetting(ctx, 'oidc_groups_claim', input.oidcGroupsClaim.trim() || 'groups');
		writeSetting(ctx, 'oidc_admin_group', input.oidcAdminGroup.trim());
		writeSetting(ctx, 'oidc_auto_create_users', flag(input.oidcAutoCreateUsers));
		writeSetting(ctx, 'oidc_redirect_base_url', input.oidcRedirectBaseUrl.trim().replace(/\/+$/, ''));
		// Metadata is cached per issuer; a settings change must not be served stale.
		resetDiscoveryCache();
		return settingsView(readSettings(ctx.db));
	}),

	implement(contracts.auth.settings.testDiscovery, (ctx) => testDiscovery(readSettings(ctx.db))),

	// ------------------------------------------------------------ OAuth approval (MCP clients)

	implement(contracts.auth.oauth.describe, (ctx, input) => {
		const client = oauthClient(input);
		const problem = requestProblem(input);
		return {
			clientName: client.name,
			redirectHost: new URL(input.redirectUri).host,
			denyUrl: errorRedirect(input, 'access_denied', 'The user denied the request.'),
			errorUrl: problem ? errorRedirect(input, problem, 'The authorization request is not valid.') : null
		};
	}),

	implement(contracts.auth.oauth.approve, (ctx, input) => {
		oauthClient(input);
		const problem = requestProblem(input);
		if (problem) return { redirectTo: errorRedirect(input, problem, 'The authorization request is not valid.') };
		return { redirectTo: issueCode(userId(ctx), input) };
	}),

	// ------------------------------------------------------------ API tokens

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

const CLAIM_LINK_TTL_MS = 7 * 86_400_000;

/** The account a claim link names, while it is still unclaimed. */
function claimable(ctx: Ctx, token: string): UserRow | undefined {
	const payload = verifyPayload(token);
	if (!payload || payload.kind !== 'account-claim' || typeof payload.uid !== 'number') return undefined;
	const u = ctx.db.select().from(user).where(eq(user.id, payload.uid)).get();
	if (!u || !u.isActive || u.passwordHash) return undefined;
	// A user id is reused after a factory reset, and a password reset puts an account back in the
	// passwordless state. createdAt names the account instance; updatedAt moves on every reset,
	// so a link only works for the account state it was issued against.
	return payload.born === u.createdAt && payload.rev === u.updatedAt ? u : undefined;
}
