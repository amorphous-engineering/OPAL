import type { Context } from 'hono';

/** One setting for every forwarded header: OIDC base URL and client address alike. */
export const trustProxy = () => /^(1|true|yes|on)$/i.test(process.env.OPAL_TRUST_PROXY ?? '');

/**
 * The client address. The socket address, unless a trusted proxy is configured: any client
 * can send x-forwarded-for, so otherwise it would let a client pick its own throttle key.
 * Without a socket (app.request() in tests) the result is null.
 */
export function clientIp(c: Context): string | null {
	const socket = (c.env as { ip?: string | null } | undefined)?.ip ?? null;
	if (!trustProxy()) return socket;
	return c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || socket;
}
