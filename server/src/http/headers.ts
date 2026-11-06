/** Response headers every reply carries. Replies that set their own policy (uploaded files, plugin pages) keep it. */
import type { MiddlewareHandler } from 'hono';
import { requestBase } from '../auth/base-url.ts';

/**
 * Policy for the web client. Script comes only from our own files and the client's inline
 * bootstrap, named by hash (see `pageCsp`). Styles allow inline: Svelte writes `style`
 * attributes, and a hash cannot cover an attribute.
 */
const PAGE_DIRECTIVES = [
	"default-src 'self'",
	"img-src 'self' data:",
	"style-src 'self' 'unsafe-inline'",
	"object-src 'none'",
	"base-uri 'none'",
	"frame-ancestors 'none'",
	"form-action 'self'"
];

/** The page policy with `hashes` (`sha256-...`) allowed as inline script. */
export function pageCsp(hashes: string[]): string {
	const script = ["script-src 'self'", ...hashes.map((h) => `'${h}'`)].join(' ');
	return [...PAGE_DIRECTIVES, script].join('; ');
}

/** For replies that are data, not pages: nothing loads, nothing frames them. */
const DATA_CSP = "default-src 'none'; frame-ancestors 'none'";

export const securityHeaders: MiddlewareHandler = async (c, next) => {
	await next();
	const h = c.res.headers;
	const set = (name: string, value: string) => {
		if (!h.has(name)) c.header(name, value);
	};
	set('X-Content-Type-Options', 'nosniff');
	// Not no-referrer: a browser then sends `Origin: null` on same-origin posts, which the CSRF guard refuses.
	// Claim and panel tokens can sit in URLs, so nothing leaves for another origin.
	set('Referrer-Policy', 'same-origin');
	set('X-Frame-Options', 'DENY');
	set('Content-Security-Policy', DATA_CSP);
	if (requestBase(c).secure) set('Strict-Transport-Security', 'max-age=31536000');
	// Signed-in data is never kept by a shared cache or a back button. SSE and files set their own.
	if (c.req.path.startsWith('/api/') && h.get('content-type')?.startsWith('application/json')) {
		set('Cache-Control', 'no-store');
	}
};
