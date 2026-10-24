/** Local control server. Loopback only; every API call needs the per-launch secret. */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { CONTROL_PAGE } from './page.ts';

export interface ControlHandlers {
	status(): unknown;
	act(action: string): Promise<{ ok: boolean; message?: string }>;
}

export interface Control {
	port: number;
	secret: string;
	origin: string;
	url: string;
	stop(): void;
}

const ACTIONS = new Set(['start', 'stop', 'restart', 'check', 'update', 'quit']);

function sameSecret(a: string | null, b: string): boolean {
	if (!a) return false;
	const x = Buffer.from(a);
	const y = Buffer.from(b);
	return x.length === y.length && timingSafeEqual(x, y);
}

export function startControl(port: number, handlers: ControlHandlers): Control {
	const secret = randomBytes(24).toString('hex');
	const server = Bun.serve({
		port,
		hostname: '127.0.0.1',
		async fetch(req) {
			const origin = `http://127.0.0.1:${server.port}`;
			const json = (body: unknown, status = 200) => Response.json(body, { status });
			const url = new URL(req.url);
			// Block DNS rebinding: only our own host names are served.
			const host = req.headers.get('host');
			if (host !== `127.0.0.1:${server.port}` && host !== `localhost:${server.port}`) {
				return json({ error: 'bad host' }, 403);
			}
			if (url.pathname === '/' && req.method === 'GET') {
				return new Response(CONTROL_PAGE, {
					headers: {
						'content-type': 'text/html; charset=utf-8',
						'cache-control': 'no-store',
						'referrer-policy': 'no-referrer',
						'x-frame-options': 'DENY'
					}
				});
			}
			if (!url.pathname.startsWith('/api/')) return json({ error: 'not found' }, 404);
			// Browsers send Origin on cross-site requests; a foreign one is never ours.
			const reqOrigin = req.headers.get('origin');
			if (reqOrigin !== null && reqOrigin !== origin && reqOrigin !== `http://localhost:${server.port}`) {
				return json({ error: 'bad origin' }, 403);
			}
			if (!sameSecret(req.headers.get('x-opal-key'), secret)) return json({ error: 'unauthorized' }, 401);
			const name = url.pathname.slice('/api/'.length);
			if (name === 'status' && req.method === 'GET') return json(handlers.status());
			if (ACTIONS.has(name) && req.method === 'POST') {
				try {
					return json(await handlers.act(name));
				} catch (e) {
					return json({ ok: false, error: (e as Error).message }, 500);
				}
			}
			return json({ error: 'not found' }, 404);
		}
	});
	const origin = `http://127.0.0.1:${server.port}`;
	return {
		port: server.port!,
		secret,
		origin,
		url: `${origin}/?k=${secret}`,
		stop: () => void server.stop(true)
	};
}
