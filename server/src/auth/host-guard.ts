/**
 * Host allowlist. A web page can reach this server under any name it likes (DNS rebinding), and
 * the server builds links and metadata from the Host it is given. When OPAL_PUBLIC_URL or
 * OPAL_ALLOWED_HOSTS is set, a request for any other Host is refused. Without either, nothing
 * is checked: people reach a LAN instance by whatever address or name they have.
 */
import type { MiddlewareHandler } from 'hono';
import { trustProxy } from './client-ip.ts';

interface Allowed {
	/** Names with no port: any port matches. */
	names: Set<string>;
	/** Names with a port: only that port matches. */
	withPort: Set<string>;
}

function split(raw: string): { name: string; host: string; hasPort: boolean } | null {
	try {
		const u = new URL(`http://${raw.trim().toLowerCase()}`);
		if (!u.hostname) return null;
		return { name: u.hostname, host: u.host, hasPort: u.port !== '' };
	} catch {
		return null;
	}
}

function allowed(): Allowed | null {
	const out: Allowed = { names: new Set(), withPort: new Set() };
	const add = (raw: string) => {
		const h = split(raw);
		if (!h) return;
		if (h.hasPort) out.withPort.add(h.host);
		else out.names.add(h.name);
	};
	let configured = false;
	const pub = process.env.OPAL_PUBLIC_URL?.trim();
	if (pub) {
		try {
			// The public URL names the host; the port it is served on can differ behind a proxy.
			out.names.add(new URL(pub).hostname.toLowerCase());
			configured = true;
		} catch {
			/* an unusable URL allows nothing extra */
		}
	}
	for (const entry of (process.env.OPAL_ALLOWED_HOSTS ?? '').split(',')) {
		if (!entry.trim()) continue;
		add(entry.trim());
		configured = true;
	}
	return configured ? out : null;
}

const isLoopback = (name: string) => name === 'localhost' || name === '[::1]' || /^127(\.\d{1,3}){3}$/.test(name);

/** True when `host` (a Host header value) may reach this server under the current settings. */
export function hostAllowed(host: string): boolean {
	const list = allowed();
	if (!list) return true;
	const h = split(host);
	if (!h) return false;
	return isLoopback(h.name) || list.names.has(h.name) || list.withPort.has(h.host);
}

export const hostGuard: MiddlewareHandler = async (c, next) => {
	if (!allowed()) return next();
	// Behind a trusted proxy the forwarded host is the one the browser used and the one links are
	// built from; the Host header is then the proxy's own address for the backend.
	const forwarded = trustProxy() ? c.req.header('x-forwarded-host')?.split(',')[0]?.trim() : undefined;
	const host = forwarded || (c.req.header('host') ?? new URL(c.req.url).host);
	if (hostAllowed(host)) return next();
	return c.json({ error: 'misdirected_request', message: 'This host name is not served here' }, 421);
};
