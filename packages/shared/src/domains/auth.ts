import { z } from 'zod';
import { op, zId, zOk } from '../op.ts';
import { zTimestamp } from '../time.ts';

/** How the UI shows times. Storage is always UTC. */
export const zTimeDisplay = z.enum(['local', 'utc']);
export type TimeDisplay = z.infer<typeof zTimeDisplay>;

export const zAuthUser = z.object({
	id: z.number().int(),
	username: z.string(),
	name: z.string(),
	email: z.string().nullable(),
	isAdmin: z.boolean(),
	needsProfileSetup: z.boolean(),
	needsOnboarding: z.boolean(),
	timeDisplay: zTimeDisplay,
	/** The profile photo, as everywhere a person appears. */
	avatarUrl: z.string().nullable()
});
export type AuthUser = z.infer<typeof zAuthUser>;

export const zAuthConfig = z.object({
	needsSetup: z.boolean(),
	passwordLoginEnabled: z.boolean(),
	passkeysEnabled: z.boolean(),
	/** True only when OIDC is switched on AND has an issuer and a client id. */
	oidcEnabled: z.boolean(),
	/** The label on the sign-in button; null while OIDC is off. */
	oidcProviderName: z.string().nullable()
});

/** Session `method` values. Imported legacy rows use the same words. */
export const SESSION_METHODS = ['password', 'passkey', 'oidc'] as const;

const zSignedIn = z.object({ user: zAuthUser });

export const zApiTokenInfo = z.object({
	id: z.number().int(),
	name: z.string(),
	createdAt: zTimestamp,
	lastUsedAt: zTimestamp.nullable(),
	expiresAt: zTimestamp.nullable()
});

export const zPassword = z.string().min(1).max(256);

const tokens = {
	list: op({
		name: 'auth.tokens.list',
		method: 'GET',
		path: '/auth/tokens',
		summary: 'List the signed-in user\'s active API tokens.',
		input: z.object({}),
		output: z.object({ items: z.array(zApiTokenInfo) }),
		access: 'signed-in',
		mcp: false
	}),
	create: op({
		name: 'auth.tokens.create',
		method: 'POST',
		path: '/auth/tokens',
		summary: 'Create an API token. The token text is returned once.',
		input: z.object({
			name: z.string().trim().min(1).max(100),
			expiresInDays: z.number().int().min(1).max(3650).optional()
		}),
		output: z.object({
			id: z.number().int(),
			name: z.string(),
			token: z.string(),
			expiresAt: zTimestamp.nullable()
		}),
		access: 'signed-in',
		humanOnly: true,
		mcp: false
	}),
	revoke: op({
		name: 'auth.tokens.revoke',
		method: 'DELETE',
		path: '/auth/tokens/:id',
		summary: 'Revoke one of the signed-in user\'s API tokens.',
		input: z.object({ id: zId }),
		output: zOk,
		access: 'signed-in',
		mcp: false
	})
};

export const zSessionInfo = z.object({
	id: z.number().int(),
	method: z.string(),
	createdAt: zTimestamp,
	lastSeenAt: zTimestamp.nullable(),
	userAgent: z.string().nullable(),
	ipAddress: z.string().nullable(),
	current: z.boolean()
});

export const zPasskeyInfo = z.object({
	id: z.number().int(),
	name: z.string(),
	createdAt: zTimestamp,
	lastUsedAt: zTimestamp.nullable(),
	transports: z.string().nullable()
});

/** WebAuthn JSON passes through untouched: the browser and the library own its shape. */
const zJson = z.record(z.string(), z.unknown());
const zWebauthnOptions = z.object({ publicKey: zJson });

/**
 * Sign-in methods and the OIDC provider, as an admin edits them. The client secret is never
 * returned: `hasClientSecret` says whether one is stored.
 */
export const zAuthSettings = z.object({
	passwordLoginEnabled: z.boolean(),
	passkeysEnabled: z.boolean(),
	oidcEnabled: z.boolean(),
	oidcIssuer: z.string(),
	oidcClientId: z.string(),
	hasClientSecret: z.boolean(),
	oidcScopes: z.string(),
	oidcProviderName: z.string(),
	oidcGroupsClaim: z.string(),
	oidcAdminGroup: z.string(),
	oidcAutoCreateUsers: z.boolean(),
	oidcRedirectBaseUrl: z.string(),
	/** Registered callback when a public base URL is pinned; otherwise the browser derives it. */
	callbackUrl: z.string().nullable()
});
export type AuthSettings = z.infer<typeof zAuthSettings>;

export const zAuthSettingsInput = z.object({
	passwordLoginEnabled: z.boolean(),
	passkeysEnabled: z.boolean(),
	oidcEnabled: z.boolean().default(false),
	oidcIssuer: z.string().max(500).default(''),
	oidcClientId: z.string().max(500).default(''),
	/** Blank keeps the stored secret. */
	oidcClientSecret: z.string().max(2000).default(''),
	clearClientSecret: z.boolean().default(false),
	oidcScopes: z.string().max(500).default('openid profile email groups'),
	oidcProviderName: z.string().max(100).default('SSO'),
	oidcGroupsClaim: z.string().max(100).default('groups'),
	oidcAdminGroup: z.string().max(255).default(''),
	oidcAutoCreateUsers: z.boolean().default(true),
	oidcRedirectBaseUrl: z.string().max(500).default('')
});

export const zDiscoveryResult = z.object({
	ok: z.boolean(),
	message: z.string(),
	authorizationEndpoint: z.string().nullable(),
	tokenEndpoint: z.string().nullable(),
	userinfoEndpoint: z.string().nullable(),
	jwksUri: z.string().nullable()
});

export type DiscoveryResult = z.infer<typeof zDiscoveryResult>;

const sessions = {
	list: op({
		name: 'auth.sessions.list',
		method: 'GET',
		path: '/auth/sessions',
		summary: 'List the signed-in user\'s live sessions.',
		input: z.object({}),
		output: z.object({ items: z.array(zSessionInfo) }),
		access: 'signed-in',
		mcp: false
	}),
	revoke: op({
		name: 'auth.sessions.revoke',
		method: 'DELETE',
		path: '/auth/sessions/:id',
		summary: 'End one of the signed-in user\'s sessions.',
		input: z.object({ id: zId }),
		output: zOk,
		access: 'signed-in',
		mcp: false
	}),
	revokeOthers: op({
		name: 'auth.sessions.revokeOthers',
		method: 'POST',
		path: '/auth/sessions/revoke-others',
		summary: 'End every session of the signed-in user except the current one.',
		input: z.object({}),
		output: z.object({ ok: z.literal(true), revoked: z.number().int() }),
		access: 'signed-in',
		mcp: false
	})
};

const passkeys = {
	list: op({
		name: 'auth.passkeys.list',
		method: 'GET',
		path: '/auth/passkeys',
		summary: 'List the signed-in user\'s passkeys.',
		input: z.object({}),
		output: z.object({ items: z.array(zPasskeyInfo) }),
		access: 'signed-in',
		mcp: false
	}),
	rename: op({
		name: 'auth.passkeys.rename',
		method: 'PATCH',
		path: '/auth/passkeys/:id',
		summary: 'Rename one of the signed-in user\'s passkeys.',
		input: z.object({ id: zId, name: z.string().trim().min(1).max(100) }),
		output: zPasskeyInfo,
		access: 'signed-in',
		mcp: false
	}),
	delete: op({
		name: 'auth.passkeys.delete',
		method: 'DELETE',
		path: '/auth/passkeys/:id',
		summary: 'Remove one of the signed-in user\'s passkeys.',
		input: z.object({ id: zId }),
		output: zOk,
		access: 'signed-in',
		mcp: false
	}),
	registerBegin: op({
		name: 'auth.passkeys.registerBegin',
		method: 'POST',
		path: '/auth/passkeys/register/begin',
		summary: 'Start registering a passkey. Returns the options for navigator.credentials.create.',
		input: z.object({ rpId: z.string().max(255).optional() }),
		output: zWebauthnOptions,
		access: 'signed-in',
		humanOnly: true,
		mcp: false
	}),
	registerComplete: op({
		name: 'auth.passkeys.registerComplete',
		method: 'POST',
		path: '/auth/passkeys/register/complete',
		summary: 'Finish registering a passkey with the browser\'s credential.',
		input: z.object({ name: z.string().trim().max(100).default('Passkey'), credential: zJson }),
		output: z.object({ ok: z.literal(true), id: z.number().int(), name: z.string() }),
		access: 'signed-in',
		humanOnly: true,
		mcp: false
	}),
	loginBegin: op({
		name: 'auth.passkeys.loginBegin',
		method: 'POST',
		path: '/auth/passkeys/login/begin',
		summary: 'Start a usernameless passkey sign-in.',
		input: z.object({ rpId: z.string().max(255).optional() }),
		output: zWebauthnOptions,
		access: 'public',
		mcp: false
	}),
	loginComplete: op({
		name: 'auth.passkeys.loginComplete',
		method: 'POST',
		path: '/auth/passkeys/login/complete',
		summary: 'Finish a passkey sign-in with the browser\'s assertion.',
		input: z.object({ credential: zJson }),
		output: zSignedIn,
		access: 'public',
		mcp: false
	})
};

/** The query of an OAuth authorization request, as an MCP client sends it to /oauth/authorize. */
export const zOAuthRequest = z.object({
	responseType: z.string().max(40),
	clientId: z.string().min(1).max(4000),
	redirectUri: z.string().min(1).max(500),
	codeChallenge: z.string().max(200),
	codeChallengeMethod: z.string().max(20),
	state: z.string().max(1000).optional()
});

const oauth = {
	describe: op({
		name: 'auth.oauth.describe',
		method: 'POST',
		path: '/auth/oauth/describe',
		summary: 'Check an OAuth authorization request from an MCP client and name the client.',
		input: zOAuthRequest,
		output: z.object({
			clientName: z.string(),
			redirectHost: z.string(),
			/** Where Deny sends the browser. */
			denyUrl: z.string(),
			/** Set when the request is bad in a way the client must hear about: go there at once. */
			errorUrl: z.string().nullable()
		}),
		access: 'signed-in',
		humanOnly: true,
		mcp: false
	}),
	approve: op({
		name: 'auth.oauth.approve',
		method: 'POST',
		path: '/auth/oauth/approve',
		summary: 'Approve an MCP client: it gets a token that acts as the signed-in user.',
		input: zOAuthRequest,
		output: z.object({ redirectTo: z.string() }),
		access: 'signed-in',
		humanOnly: true,
		mcp: false
	})
};

const claim = {
	status: op({
		name: 'auth.claim.status',
		method: 'GET',
		path: '/auth/claim',
		summary: 'Check an account-claim link. Invalid, expired and spent links look the same.',
		input: z.object({ token: z.string().min(1).max(2000) }),
		output: z.object({ username: z.string() }),
		access: 'public',
		mcp: false
	}),
	complete: op({
		name: 'auth.claim.complete',
		method: 'POST',
		path: '/auth/claim',
		summary: 'Set the first password on a passwordless account and sign in.',
		input: z.object({ token: z.string().min(1).max(2000), password: zPassword }),
		output: zSignedIn,
		access: 'public',
		mcp: false
	})
};

const claimLinks = {
	create: op({
		name: 'auth.claimLinks.create',
		method: 'POST',
		path: '/auth/claim-links',
		summary: 'Issue a single-use link that lets a passwordless account set its password.',
		input: z.object({ userId: zId }),
		output: z.object({ token: z.string(), expiresAt: zTimestamp }),
		access: 'admin',
		humanOnly: true,
		mcp: false
	})
};

const settings = {
	get: op({
		name: 'auth.settings.get',
		method: 'GET',
		path: '/settings/auth',
		summary: 'Read the sign-in settings.',
		input: z.object({}),
		output: zAuthSettings,
		access: 'admin',
		mcp: false
	}),
	update: op({
		name: 'auth.settings.update',
		method: 'PUT',
		path: '/settings/auth',
		summary: 'Save the sign-in settings. Refuses a setup that leaves nobody able to sign in.',
		input: zAuthSettingsInput,
		output: zAuthSettings,
		access: 'admin',
		humanOnly: true,
		mcp: false
	}),
	testDiscovery: op({
		name: 'auth.settings.testDiscovery',
		method: 'POST',
		path: '/settings/auth/test',
		summary: 'Fetch the OIDC provider\'s discovery document and report what it advertises.',
		input: z.object({}),
		output: zDiscoveryResult,
		access: 'admin',
		mcp: false
	})
};

export const auth = {
	config: op({
		name: 'auth.config',
		method: 'GET',
		path: '/auth/config',
		summary: 'Which sign-in methods are on, and whether first-run setup is needed.',
		input: z.object({}),
		output: zAuthConfig,
		access: 'public',
		mcp: false
	}),
	setup: op({
		name: 'auth.setup',
		method: 'POST',
		path: '/auth/setup',
		summary: 'Create the first admin account and sign in. Refused once any user exists.',
		input: z.object({
			username: z.string().trim().min(1).max(64),
			name: z.string().trim().min(1).max(255),
			password: zPassword,
			email: z.string().trim().max(255).nullable().optional()
		}),
		output: zSignedIn,
		access: 'public',
		mcp: false
	}),
	login: op({
		name: 'auth.login',
		method: 'POST',
		path: '/auth/login',
		summary: 'Sign in with username and password.',
		input: z.object({ username: z.string().min(1).max(64), password: zPassword }),
		output: zSignedIn,
		access: 'public',
		mcp: false
	}),
	logout: op({
		name: 'auth.logout',
		method: 'POST',
		path: '/auth/logout',
		summary: 'End the current session.',
		input: z.object({}),
		output: zOk,
		access: 'signed-in',
		mcp: false
	}),
	password: {
		change: op({
			name: 'auth.password.change',
			method: 'POST',
			path: '/auth/password',
			summary: 'Change the signed-in user\'s password. Ends every other session.',
			input: z.object({
				/** Required when the account has a password. */
				currentPassword: z.string().max(256).optional(),
				newPassword: zPassword
			}),
			output: z.object({ ok: z.literal(true), otherSessionsRevoked: z.number().int() }),
			access: 'signed-in',
			humanOnly: true,
			mcp: false
		})
	},
	me: op({
		name: 'auth.me',
		method: 'GET',
		path: '/auth/me',
		summary: 'The signed-in user.',
		input: z.object({}),
		output: zAuthUser,
		access: 'signed-in',
		mcp: true
	}),
	tokens,
	oauth,
	sessions,
	passkeys,
	claim,
	claimLinks,
	settings
};
