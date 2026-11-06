import type { Context } from 'hono';

/** One setting for every forwarded header: OIDC base URL and client address alike. */
export const trustProxy = () => /^(1|true|yes|on)$/i.test(process.env.OPAL_TRUST_PROXY ?? '');

/** How many proxies in front of OPAL append to x-forwarded-for. One by default. */
function proxyHops(): number {
	const n = Number.parseInt(process.env.OPAL_TRUST_PROXY_HOPS ?? '', 10);
	return Number.isInteger(n) && n >= 1 ? n : 1;
}

/**
 * The client address. The socket address, unless a trusted proxy is configured: any client
 * can send x-forwarded-for, so otherwise it would let a client pick its own throttle key.
 * With a trusted proxy the address is counted from the right: each proxy appends the address
 * it saw, so the leftmost entries are whatever the client claimed. OPAL_TRUST_PROXY_HOPS is
 * the number of proxies (default 1). Without a socket (app.request() in tests) the result
 * is null.
 */
export function clientIp(c: Context): string | null {
	const socket = (c.env as { ip?: string | null } | undefined)?.ip ?? null;
	if (!trustProxy()) return socket;
	const chain = (c.req.header('x-forwarded-for') ?? '')
		.split(',')
		.map((a) => a.trim())
		.filter(Boolean);
	if (!chain.length) return socket;
	return chain[Math.max(0, chain.length - proxyHops())] ?? socket;
}
