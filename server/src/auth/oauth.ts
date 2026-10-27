/**
 * OAuth endpoints for MCP clients. A client finds them from the 401 that /mcp sends, registers
 * itself, sends the user to /oauth/authorize (a web client page that asks for approval), and
 * trades the code for tokens at /oauth/token. Rules live in services/auth/oauth.ts.
 */
import type { Context, Hono } from 'hono';
import type { Ctx } from '../context.ts';
import type { Db } from '../db/client.ts';
import { exchangeCode, OAuthError, refresh, registerClient } from '../services/auth/oauth.ts';
import { inTransaction } from '../services/auth/tx.ts';
import { requestBase } from './base-url.ts';

export const MCP_RESOURCE_METADATA = '/.well-known/oauth-protected-resource/mcp';

const oauthError = (c: Context, e: OAuthError) =>
	c.json({ error: e.code, error_description: e.message }, e.status as 400, { 'Cache-Control': 'no-store' });

export function mountOauth(app: Hono, db: Db): void {
	const resource = (c: Context) => {
		const { base } = requestBase(c);
		return c.json({ resource: `${base}/mcp`, authorization_servers: [base], bearer_methods_supported: ['header'] });
	};
	app.get(MCP_RESOURCE_METADATA, resource);
	app.get('/.well-known/oauth-protected-resource', resource);

	app.get('/.well-known/oauth-authorization-server', (c) => {
		const { base } = requestBase(c);
		return c.json({
			issuer: base,
			authorization_endpoint: `${base}/oauth/authorize`,
			token_endpoint: `${base}/oauth/token`,
			registration_endpoint: `${base}/oauth/register`,
			response_types_supported: ['code'],
			grant_types_supported: ['authorization_code', 'refresh_token'],
			code_challenge_methods_supported: ['S256'],
			token_endpoint_auth_methods_supported: ['none']
		});
	});

	app.post('/oauth/register', async (c) => {
		try {
			const body = await c.req.json().catch(() => null);
			const client = registerClient(body);
			return c.json(
				{
					client_id: client.id,
					client_name: client.name,
					redirect_uris: client.redirectUris,
					token_endpoint_auth_method: 'none',
					grant_types: ['authorization_code', 'refresh_token'],
					response_types: ['code']
				},
				201
			);
		} catch (e) {
			if (e instanceof OAuthError) return oauthError(c, e);
			throw e;
		}
	});

	app.post('/oauth/token', async (c) => {
		const form = Object.fromEntries(
			[...new URLSearchParams(await c.req.text().catch(() => ''))].map(([k, v]) => [k, v])
		) as Record<string, string | undefined>;
		const ctx: Ctx = { db, actor: { kind: 'system' }, op: 'auth.oauth.token' };
		try {
			const grant = form.grant_type;
			if (grant !== 'authorization_code' && grant !== 'refresh_token') {
				throw new OAuthError('unsupported_grant_type', 'Use authorization_code or refresh_token.');
			}
			const out = await inTransaction(db, () => (grant === 'authorization_code' ? exchangeCode(ctx, form) : refresh(ctx, form)));
			return c.json(out, 200, { 'Cache-Control': 'no-store' });
		} catch (e) {
			if (e instanceof OAuthError) return oauthError(c, e);
			throw e;
		}
	});
}
