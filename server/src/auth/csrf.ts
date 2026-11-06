/**
 * CSRF guard, as in legacy middleware: an unsafe request that carries an
 * Origin must come from the Host it asks. Without Origin (curl, scripts) it
 * passes unless a Referer says otherwise. Bearer requests are immune.
 */
import type { Context, MiddlewareHandler } from 'hono';
import { trustProxy } from './client-ip.ts';
import { browserHost } from './host-guard.ts';

const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function hostOf(url: string): string {
	try {
		return new URL(url).host;
	} catch {
		return '';
	}
}

/** Behind a trusted proxy that names the scheme, an http page must not post to an https site. */
function sameScheme(c: Context, url: string): boolean {
	const proto = trustProxy() ? c.req.header('x-forwarded-proto')?.split(',')[0]?.trim() : undefined;
	if (!proto) return true;
	try {
		return new URL(url).protocol === `${proto}:`;
	} catch {
		return false;
	}
}

export const csrfGuard: MiddlewareHandler = async (c, next) => {
	if (!UNSAFE.has(c.req.method)) return next();
	if (/^Bearer\s/i.test(c.req.header('authorization') ?? '')) return next();
	// Plugin proxy: webhooks carry no cookies, and a panel (sandboxed iframe, Origin: null)
	// proves itself with its signed panel token. The proxy checks the token.
	const path = c.req.path;
	if (path.startsWith('/hooks/')) return next();
	// OAuth registration and token calls carry no cookies, so a cross-site request gains nothing.
	if (path === '/oauth/register' || path === '/oauth/token') return next();
	if (path.startsWith('/plugins/') && c.req.header('x-opal-panel')) return next();
	// The host the browser used. A trusted proxy may reach this server under its own address.
	const host = browserHost(c);
	const origin = c.req.header('origin');
	let bad = false;
	if (origin !== undefined) {
		bad = origin === 'null' || hostOf(origin) !== host || !sameScheme(c, origin);
	} else {
		const referer = c.req.header('referer');
		bad = !!referer && hostOf(referer) !== '' && (hostOf(referer) !== host || !sameScheme(c, referer));
	}
	if (bad) {
		return c.json({ error: 'forbidden', message: 'Cross-origin request rejected' }, 403);
	}
	return next();
};
