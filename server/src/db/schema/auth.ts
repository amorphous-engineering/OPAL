/**
 * Sign-in tables that go beyond core.ts (user, session, api_token): passkeys, their
 * short-lived challenges, and the sign-in settings.
 *
 * Legacy mapping (import is 1:1 by column name):
 *   passkey_credential  -> passkey_credential  (same columns)
 *   webauthn_challenge  -> webauthn_challenge  (state_json kept; rows live 5 minutes, skip them)
 *   app_setting         -> auth_setting        (only the keys listed in AUTH_SETTING_KEYS)
 */
import { blob, index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { createdAt, id, oneOf, updatedAt } from './helpers.ts';
import { user } from './core.ts';

export const passkeyCredential = sqliteTable(
	'passkey_credential',
	{
		id: id(),
		userId: integer('user_id')
			.notNull()
			.references(() => user.id, { onDelete: 'cascade' }),
		credentialId: blob('credential_id', { mode: 'buffer' }).notNull().unique(),
		/**
		 * Legacy layout, kept so imported rows work: the python-fido2 AttestedCredentialData
		 * bytes: aaguid (16) | credential id length (2, big endian) | credential id | COSE key.
		 */
		publicKey: blob('public_key', { mode: 'buffer' }).notNull(),
		signCount: integer('sign_count').notNull().default(0),
		name: text('name').notNull().default('Passkey'),
		aaguid: text('aaguid'),
		/** Comma-separated WebAuthn transports. */
		transports: text('transports'),
		lastUsedAt: text('last_used_at'),
		createdAt: createdAt(),
		updatedAt: updatedAt()
	},
	(t) => [index('passkey_user_idx').on(t.userId)]
);

export const WEBAUTHN_KINDS = ['login', 'register'] as const;

/** A pending WebAuthn handshake. Single use: it is deleted when read. No audit rows. */
export const webauthnChallenge = sqliteTable(
	'webauthn_challenge',
	{
		id: id(),
		nonce: text('nonce').notNull().unique(),
		kind: text('kind').notNull(),
		rpId: text('rp_id').notNull(),
		userId: integer('user_id').references(() => user.id, { onDelete: 'cascade' }),
		/** JSON: { challenge } for the TypeScript server. Legacy rows hold fido2 state. */
		stateJson: text('state_json').notNull(),
		expiresAt: text('expires_at').notNull(),
		createdAt: createdAt(),
		updatedAt: updatedAt()
	},
	(t) => [index('webauthn_challenge_user_idx').on(t.userId), oneOf('webauthn_kind_check', 'kind', WEBAUTHN_KINDS)]
);

/** Legacy `app_setting` keys that belong to sign-in. Values are text, booleans as 'true'/'false'. */
export const AUTH_SETTING_KEYS = [
	'password_login_enabled',
	'passkeys_enabled',
	'passkey_rp_id',
	'oidc_enabled',
	'oidc_issuer',
	'oidc_client_id',
	'oidc_client_secret',
	'oidc_scopes',
	'oidc_provider_name',
	'oidc_groups_claim',
	'oidc_admin_group',
	'oidc_auto_create_users',
	'oidc_redirect_base_url'
] as const;
export type AuthSettingKey = (typeof AUTH_SETTING_KEYS)[number];

export const authSetting = sqliteTable('auth_setting', {
	id: id(),
	key: text('key').notNull().unique(),
	value: text('value'),
	createdAt: createdAt(),
	updatedAt: updatedAt()
});
