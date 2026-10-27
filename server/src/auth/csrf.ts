/**
 * CSRF guard, as in legacy middleware: an unsafe request that carries an
 * Origin must come from the Host it asks. Without Origin (curl, scripts) it
 * passes unless a Referer says otherwise. Bearer requests are immune.
 */
import type { MiddlewareHandler } from 'hono';

const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function hostOf(url: string): string {
	try {
		return new URL(url).host;
	} catch {
		return '';
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
	const host = c.req.header('host') ?? new URL(c.req.url).host;
	const origin = c.req.header('origin');
	let bad = false;
	if (origin !== undefined) {
		bad = origin === 'null' || hostOf(origin) !== host;
	} else {
		const referer = c.req.header('referer');
		bad = !!referer && hostOf(referer) !== '' && hostOf(referer) !== host;
	}
	if (bad) {
		return c.json({ error: 'forbidden', message: 'Cross-origin request rejected' }, 403);
	}
	return next();
};
