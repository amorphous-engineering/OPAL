import { z } from 'zod';
import { op, zId, zOk } from '../op.ts';
import { zTimestamp } from '../time.ts';

export const zAuthUser = z.object({
	id: z.number().int(),
	username: z.string(),
	name: z.string(),
	email: z.string().nullable(),
	isAdmin: z.boolean()
});
export type AuthUser = z.infer<typeof zAuthUser>;

export const zAuthConfig = z.object({
	needsSetup: z.boolean(),
	passwordLoginEnabled: z.boolean(),
	passkeysEnabled: z.boolean(),
	oidcEnabled: z.boolean()
});

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
	tokens
};
