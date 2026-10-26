/**
 * Plain routes that forward a request to a plugin process:
 *   ALL /plugins/<id>/<rest>  ->  http://127.0.0.1:<port>/<rest>        signed-in user or panel token
 *   ALL /hooks/<id>/<rest>    ->  http://127.0.0.1:<port>/hooks/<rest>   anyone, when the manifest allows hooks
 */
import { eq } from 'drizzle-orm';
import type { Context, Hono } from 'hono';
import { verifyPayload } from '../../auth/signing.ts';
import { actorUserId } from '../../context.ts';
import type { Db } from '../../db/client.ts';
import { user } from '../../db/schema/index.ts';
import type { ResolveActor } from '../../registry.ts';
import { runtime } from './runtime.ts';
import { findPlugin } from './store.ts';

/** Never forwarded: the plugin must not see an OPAL session or token. */
const STRIP_REQUEST = new Set(['cookie', 'authorization', 'host', 'x-opal-panel', 'x-opal-user', 'connection', 'content-length']);
/** Bun's fetch has already decoded the body, and the connection is ours. */
const STRIP_RESPONSE = new Set(['content-encoding', 'content-length', 'transfer-encoding', 'connection', 'keep-alive', 'set-cookie']);

const fail = (c: Context, status: 401 | 404 | 502 | 503, error: string, message: string) =>
	c.json({ error, message }, status);

/** The active user a request acts for: session, bearer token, or a panel token for this plugin. */
async function userOf(c: Context, db: Db, resolveActor: ResolveActor, key: string): Promise<number | null> {
	const panel = c.req.header('x-opal-panel') ?? c.req.query('pt');
	// A request that offers a panel token stands or falls with it: no fallback to the cookie.
	if (panel !== undefined) {
		const p = verifyPayload(panel);
		if (!p || p.k !== 'panel' || p.p !== key || typeof p.u !== 'number') return null;
		return db.select({ a: user.isActive }).from(user).where(eq(user.id, p.u)).get()?.a ? p.u : null;
	}
	return actorUserId(await resolveActor(c));
}

async function forward(c: Context, port: number, upstreamPath: string, headers: Headers): Promise<Response> {
	const url = new URL(c.req.url);
	url.searchParams.delete('pt');
	const query = url.searchParams.toString();
	const hasBody = c.req.method !== 'GET' && c.req.method !== 'HEAD';
	let res: Response;
	try {
		res = await fetch(`http://127.0.0.1:${port}${upstreamPath}${query ? `?${query}` : ''}`, {
			method: c.req.method,
			headers,
			body: hasBody ? c.req.raw.body : undefined,
			// @ts-expect-error Bun and Node need `duplex` to send a stream
			duplex: 'half',
			redirect: 'manual'
		});
	} catch {
		return fail(c, 502, 'plugin_unreachable', 'The plugin did not answer');
	}
	const out = new Headers();
	res.headers.forEach((v, k) => {
		if (!STRIP_RESPONSE.has(k)) out.set(k, v);
	});
	// Plugin pages share our origin: a page opened outside the panel iframe still gets no script rights on it.
	out.set('content-security-policy', 'sandbox allow-scripts allow-forms allow-popups');
	return new Response(res.body, { status: res.status, statusText: res.statusText, headers: out });
}

function forwardHeaders(c: Context): Headers {
	const h = new Headers();
	c.req.raw.headers.forEach((v, k) => {
		if (!STRIP_REQUEST.has(k)) h.set(k, v);
	});
	return h;
}

/** Path after `/<prefix>/<id>`, with the query dropped. Empty when there is none. */
function restOf(c: Context, prefix: string, key: string): string {
	return new URL(c.req.url).pathname.slice(`/${prefix}/${key}`.length);
}

export function mountPluginProxy(app: Hono, db: Db, resolveActor: ResolveActor): void {
	app.all('/plugins/:id/*', async (c, next) => {
		const key = c.req.param('id');
		const rest = restOf(c, 'plugins', key);
		// `/plugins/<id>` alone is the app's own page for the plugin.
		if (rest === '') return next();
		const userId = await userOf(c, db, resolveActor, key);
		if (userId === null) return fail(c, 401, 'unauthenticated', 'Sign in required');
		const row = findPlugin(db, key);
		if (!row || !row.enabled) return fail(c, 404, 'not_found', 'Plugin not found');
		const port = runtime().port(key);
		if (port === null) return fail(c, 503, 'plugin_not_running', 'The plugin is not running');
		const person = db.select().from(user).where(eq(user.id, userId)).get();
		const headers = forwardHeaders(c);
		headers.set('x-opal-user', JSON.stringify({ id: userId, name: person?.name ?? '', username: person?.username ?? '' }));
		return forward(c, port, rest, headers);
	});

	app.all('/hooks/:id/*', async (c, next) => {
		const key = c.req.param('id');
		const rest = restOf(c, 'hooks', key);
		if (rest === '') return next();
		const row = findPlugin(db, key);
		if (!row || !row.enabled || !row.manifest.permissions.hooks) return fail(c, 404, 'not_found', 'Plugin not found');
		const port = runtime().port(key);
		if (port === null) return fail(c, 503, 'plugin_not_running', 'The plugin is not running');
		return forward(c, port, `/hooks${rest}`, forwardHeaders(c));
	});
}
