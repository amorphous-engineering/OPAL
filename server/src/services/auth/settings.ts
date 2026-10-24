/**
 * Sign-in settings. Stored as text rows in `auth_setting` (legacy `app_setting` keys). A stored
 * row wins; without one the `OPAL_*` environment variable applies; without that, the default.
 * That is the legacy order: the environment seeds an instance, the settings page edits it.
 */
import { now } from '@opal/shared';
import { eq } from 'drizzle-orm';
import type { Ctx } from '../../context.ts';
import type { Db } from '../../db/client.ts';
import { auditLog } from '../../db/schema/index.ts';
import { AUTH_SETTING_KEYS, type AuthSettingKey, authSetting } from '../../db/schema/auth.ts';

export interface SignInSettings {
	passwordLoginEnabled: boolean;
	passkeysEnabled: boolean;
	passkeyRpId: string;
	oidcEnabled: boolean;
	oidcIssuer: string;
	oidcClientId: string;
	oidcClientSecret: string;
	oidcScopes: string;
	oidcProviderName: string;
	oidcGroupsClaim: string;
	oidcAdminGroup: string;
	oidcAutoCreateUsers: boolean;
	oidcRedirectBaseUrl: string;
}

const DEFAULTS: Record<AuthSettingKey, string> = {
	password_login_enabled: 'true',
	passkeys_enabled: 'true',
	passkey_rp_id: '',
	oidc_enabled: 'false',
	oidc_issuer: '',
	oidc_client_id: '',
	oidc_client_secret: '',
	oidc_scopes: 'openid profile email groups',
	oidc_provider_name: 'SSO',
	oidc_groups_claim: 'groups',
	oidc_admin_group: '',
	oidc_auto_create_users: 'true',
	oidc_redirect_base_url: ''
};

const SECRET_KEYS = new Set<string>(['oidc_client_secret']);
const truthy = (v: string) => /^(1|true|yes|on)$/i.test(v.trim());

function stored(db: Db): Map<string, string | null> {
	return new Map(db.select().from(authSetting).all().map((r) => [r.key, r.value]));
}

function resolve(rows: Map<string, string | null>, key: AuthSettingKey): string {
	const row = rows.get(key);
	if (row !== undefined && row !== null) return row;
	return process.env[`OPAL_${key.toUpperCase()}`] ?? DEFAULTS[key];
}

export function readSettings(db: Db): SignInSettings {
	const rows = stored(db);
	const text = (k: AuthSettingKey) => resolve(rows, k);
	const flag = (k: AuthSettingKey) => truthy(text(k));
	return {
		passwordLoginEnabled: flag('password_login_enabled'),
		passkeysEnabled: flag('passkeys_enabled'),
		passkeyRpId: text('passkey_rp_id').trim(),
		oidcEnabled: flag('oidc_enabled'),
		oidcIssuer: text('oidc_issuer').trim().replace(/\/+$/, ''),
		oidcClientId: text('oidc_client_id').trim(),
		oidcClientSecret: text('oidc_client_secret'),
		oidcScopes: text('oidc_scopes').trim() || 'openid profile email',
		oidcProviderName: text('oidc_provider_name').trim() || 'SSO',
		oidcGroupsClaim: text('oidc_groups_claim').trim() || 'groups',
		oidcAdminGroup: text('oidc_admin_group').trim(),
		oidcAutoCreateUsers: flag('oidc_auto_create_users'),
		oidcRedirectBaseUrl: text('oidc_redirect_base_url').trim().replace(/\/+$/, '')
	};
}

/** OIDC is offered only when switched on and the provider is named. */
export function oidcActive(s: SignInSettings): boolean {
	return s.oidcEnabled && !!s.oidcIssuer && !!s.oidcClientId;
}

/**
 * Write one setting and its audit row. The audit row never carries the client secret, which the
 * shared `write.ts` helpers cannot redact (they know only password and token hashes).
 */
export function writeSetting(ctx: Ctx, key: AuthSettingKey, value: string): void {
	const row = ctx.db.select().from(authSetting).where(eq(authSetting.key, key)).get();
	if ((row?.value ?? null) === value) return;
	const ts = now();
	const saved = row
		? ctx.db
				.update(authSetting)
				.set({ value, updatedAt: ts })
				.where(eq(authSetting.id, row.id))
				.returning()
				.get()
		: ctx.db
				.insert(authSetting)
				.values({ key, value, createdAt: ts, updatedAt: ts })
				.returning()
				.get();
	const hide = (r: typeof saved | undefined) =>
		r && SECRET_KEYS.has(key) && r.value ? { ...r, value: '[redacted]' } : (r ?? null);
	const actor = ctx.actor;
	ctx.db
		.insert(auditLog)
		.values({
			at: ts,
			entity: 'auth_setting',
			entityId: saved.id,
			action: row ? 'update' : 'create',
			op: ctx.op,
			actorUserId: actor.kind === 'user' || actor.kind === 'token' ? actor.userId : null,
			actorTokenId: actor.kind === 'token' ? actor.tokenId : null,
			before: hide(row),
			after: hide(saved)
		})
		.run();
}

export { AUTH_SETTING_KEYS };
