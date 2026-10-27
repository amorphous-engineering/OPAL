/** The URL a browser or client used to reach this server. */
import type { Context } from 'hono';
import { trustProxy } from './client-ip.ts';

/**
 * OPAL_PUBLIC_URL names the URL people use, when a proxy chain hides it (a proxy that
 * terminates TLS behind another one sends `x-forwarded-proto: http`).
 */
function configuredBase(): string | null {
	const raw = process.env.OPAL_PUBLIC_URL?.trim();
	if (!raw) return null;
	try {
		const u = new URL(raw);
		return u.protocol === 'https:' || u.protocol === 'http:' ? u.origin : null;
	} catch {
		return null;
	}
}

/** Scheme and host the browser used: OPAL_PUBLIC_URL, else the request, seen through a trusted proxy. */
export function requestBase(c: Context): { base: string; secure: boolean } {
	const configured = configuredBase();
	if (configured) return { base: configured, secure: configured.startsWith('https:') };
	const url = new URL(c.req.url);
	let proto = url.protocol.replace(':', '');
	let host = c.req.header('host') ?? url.host;
	if (trustProxy()) {
		proto = c.req.header('x-forwarded-proto')?.split(',')[0]?.trim() || proto;
		host = c.req.header('x-forwarded-host')?.split(',')[0]?.trim() || host;
	}
	return { base: `${proto}://${host}`, secure: proto === 'https' };
}
