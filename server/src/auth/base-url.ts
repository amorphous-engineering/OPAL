/** The URL a browser or client used to reach this server. */
import type { Context } from 'hono';
import { trustProxy } from './client-ip.ts';

/** Scheme and host the browser used, seeing through a trusted reverse proxy. */
export function requestBase(c: Context): { base: string; secure: boolean } {
	const url = new URL(c.req.url);
	let proto = url.protocol.replace(':', '');
	let host = c.req.header('host') ?? url.host;
	if (trustProxy()) {
		proto = c.req.header('x-forwarded-proto')?.split(',')[0]?.trim() || proto;
		host = c.req.header('x-forwarded-host')?.split(',')[0]?.trim() || host;
	}
	return { base: `${proto}://${host}`, secure: proto === 'https' };
}
