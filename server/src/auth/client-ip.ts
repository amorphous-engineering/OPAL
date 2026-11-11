import type { Context } from 'hono';
import { isIPv6 } from 'node:net';

/** One setting for every forwarded header: OIDC base URL and client address alike. */
export const trustProxy = () => /^(1|true|yes|on)$/i.test(process.env.OPAL_TRUST_PROXY ?? '');

/** How many proxies in front of OPAL append to x-forwarded-for. One by default. */
function proxyHops(): number {
	const n = Number.parseInt(process.env.OPAL_TRUST_PROXY_HOPS ?? '', 10);
	return Number.isInteger(n) && n >= 1 ? n : 1;
}

/**
 * What a throttle counts as one client. One IPv6 customer usually holds a whole /64, so counting
 * single addresses would give them billions of tries. An IPv4-mapped address counts as its IPv4.
 */
export function throttleAddress(ip: string | null | undefined): string {
	if (!ip) return 'unknown';
	const bare = ip.split('%')[0]!.toLowerCase();
	if (!isIPv6(bare)) return bare;
	const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(bare);
	if (mapped) return mapped[1]!;
	const [head = '', tail] = bare.split('::');
	const left = head ? head.split(':') : [];
	const right = tail ? tail.split(':') : [];
	const groups = bare.includes('::') ? [...left, ...Array(8 - left.length - right.length).fill('0'), ...right] : left;
	return `${groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, '')).join(':')}::/64`;
}

/**
 * Where a forwarded address first arrived with trust off. Behind a proxy that setup looks like it works,
 * while everyone shares one address and so one sign-in limit, and nothing else would say so. Any client
 * can send the header too, so the socket address is named and the header's own value never is.
 */
export const ignoredForward: { seenFrom: string | null } = { seenFrom: null };

function noteIgnoredForward(socket: string | null): void {
	ignoredForward.seenFrom = socket ?? 'unknown';
	console.warn(
		`X-Forwarded-For arrived from ${ignoredForward.seenFrom}, and OPAL ignores it because OPAL_TRUST_PROXY is not set. ` +
			'If that address is a proxy, set OPAL_TRUST_PROXY=1 and restart: until then everyone behind it counts as one address and shares one sign-in limit. ' +
			'If it is not a proxy, a client sent the header itself. This warning appears once.'
	);
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
	if (!trustProxy()) {
		if (!ignoredForward.seenFrom && c.req.header('x-forwarded-for')) noteIgnoredForward(socket);
		return socket;
	}
	const chain = (c.req.header('x-forwarded-for') ?? '')
		.split(',')
		.map((a) => a.trim())
		.filter(Boolean);
	if (!chain.length) return socket;
	return chain[Math.max(0, chain.length - proxyHops())] ?? socket;
}
