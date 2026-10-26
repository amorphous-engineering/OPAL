import { Hono, type Context } from 'hono';
import type { Client, Contracts, OpalEvent } from '@opal/shared';
import { makeApi } from './client.ts';
import { SseParser } from './sse.ts';

export interface PluginContext {
	id: string;
	api: Client<Contracts>;
	settings: Record<string, unknown>;
	dataDir: string;
	log: (...args: unknown[]) => void;
	opalUrl: string;
}

export interface PluginDefinition {
	start?(ctx: PluginContext): Promise<void> | void;
	events?: { [type: string]: (event: OpalEvent, ctx: PluginContext) => Promise<void> | void };
	reconcile?: { everyMinutes: number; run(ctx: PluginContext): Promise<void> };
	routes?(app: Hono, ctx: PluginContext): void;
}

export interface PluginOptions {
	/** Defaults to process.env. */
	env?: Record<string, string | undefined>;
	/** Install a SIGTERM handler that stops the plugin and exits 0. Default true. */
	signals?: boolean;
	fetch?: typeof fetch;
}

export interface PluginHandle {
	ctx: PluginContext;
	/** Port the HTTP server listens on. */
	port: number;
	/** Resolves when `start` has run and the event loop is going. */
	ready: Promise<void>;
	stop(): Promise<void>;
}

export interface OpalUser {
	id: number;
	name: string;
	username: string;
}

/** The person behind a proxied request, from the X-Opal-User header the host sets. */
export function userOf(c: Context): OpalUser | null {
	const h = c.req.header('X-Opal-User');
	if (!h) return null;
	try {
		return JSON.parse(h) as OpalUser;
	} catch {
		return null;
	}
}

export function log(...args: unknown[]): void {
	const line = args.map((a) => (typeof a === 'string' ? a : a instanceof Error ? a.stack ?? a.message : safeJson(a))).join(' ');
	process.stdout.write(`${line.replace(/\r?\n/g, ' | ')}\n`);
}

function safeJson(v: unknown): string {
	try {
		return JSON.stringify(v) ?? String(v);
	} catch {
		return String(v);
	}
}

function need(env: Record<string, string | undefined>, name: string): string {
	const v = env[name];
	if (v === undefined || v === '') {
		throw new Error(`@opal/plugin-sdk: environment variable ${name} is missing. Run the plugin through OPAL.`);
	}
	return v;
}

const sleep = (ms: number, signal: AbortSignal) =>
	new Promise<void>((resolve) => {
		const t = setTimeout(resolve, ms);
		signal.addEventListener('abort', () => (clearTimeout(t), resolve()), { once: true });
	});

export function definePlugin(def: PluginDefinition, opts: PluginOptions = {}): PluginHandle {
	const env = opts.env ?? process.env;
	const fetchFn = opts.fetch ?? fetch;
	const id = need(env, 'OPAL_PLUGIN_ID');
	const opalUrl = need(env, 'OPAL_URL').replace(/\/+$/, '');
	const token = need(env, 'OPAL_TOKEN');
	const port = Number(need(env, 'OPAL_PLUGIN_PORT'));
	const dataDir = need(env, 'OPAL_PLUGIN_DATA');
	if (!Number.isInteger(port) || port < 0) throw new Error('@opal/plugin-sdk: OPAL_PLUGIN_PORT is not a port number.');
	let settings: Record<string, unknown>;
	try {
		settings = JSON.parse(need(env, 'OPAL_SETTINGS')) as Record<string, unknown>;
	} catch (e) {
		if (e instanceof SyntaxError) throw new Error('@opal/plugin-sdk: OPAL_SETTINGS is not valid JSON.');
		throw e;
	}

	const ctx: PluginContext = { id, api: makeApi(opalUrl, token, fetchFn), settings, dataDir, log, opalUrl };

	const app = new Hono();
	app.get('/__health', (c) => c.text('ok'));
	def.routes?.(app, ctx);
	app.onError((err, c) => {
		log(`route error ${c.req.method} ${c.req.path}:`, err);
		return c.json({ error: 'internal', message: 'Plugin error' }, 500);
	});
	const server = Bun.serve({ hostname: '127.0.0.1', port, fetch: app.fetch });

	const abort = new AbortController();
	let reconciling = false;

	async function reconcile(): Promise<void> {
		if (!def.reconcile || reconciling || abort.signal.aborted) return;
		reconciling = true;
		try {
			await def.reconcile.run(ctx);
		} catch (e) {
			log('reconcile failed:', e);
		} finally {
			reconciling = false;
		}
	}

	async function dispatch(data: string): Promise<void> {
		let event: OpalEvent;
		try {
			event = JSON.parse(data) as OpalEvent;
		} catch {
			return;
		}
		if (!event || typeof event.type !== 'string' || event.type === 'heartbeat') return;
		const handler = def.events?.[event.type];
		if (!handler) return;
		try {
			await handler(event, ctx);
		} catch (e) {
			log(`handler ${event.type} failed:`, e);
		}
	}

	async function readStream(): Promise<void> {
		const res = await fetchFn(`${opalUrl}/api/events/stream`, {
			headers: { Authorization: `Bearer ${token}`, Accept: 'text/event-stream' },
			signal: abort.signal
		});
		if (!res.ok || !res.body) throw new Error(`event stream answered ${res.status}`);
		// Connected: catch up on what happened while the stream was down.
		void reconcile();
		const parser = new SseParser();
		const decoder = new TextDecoder();
		const reader = res.body.getReader();
		for (;;) {
			const { done, value } = await reader.read();
			if (done) return;
			for (const data of parser.push(decoder.decode(value, { stream: true }))) await dispatch(data);
		}
	}

	async function eventLoop(): Promise<void> {
		let delay = 1000;
		while (!abort.signal.aborted) {
			const t0 = Date.now();
			try {
				await readStream();
			} catch (e) {
				if (abort.signal.aborted) break;
				log('event stream:', e instanceof Error ? e.message : e);
			}
			if (abort.signal.aborted) break;
			// A stream that lasted a while was healthy, so start the backoff again.
			delay = Date.now() - t0 > 30_000 ? 1000 : Math.min(delay * 2, 30_000);
			await sleep(delay, abort.signal);
		}
	}

	let timer: ReturnType<typeof setInterval> | undefined;
	let loop: Promise<void> = Promise.resolve();
	const ready = (async () => {
		await def.start?.(ctx);
		if (def.reconcile) timer = setInterval(() => void reconcile(), def.reconcile.everyMinutes * 60_000);
		if (def.events || def.reconcile) loop = eventLoop();
	})();
	ready.catch((e) => log('start failed:', e));

	let stopped: Promise<void> | undefined;
	const stop = () =>
		(stopped ??= (async () => {
			abort.abort();
			if (timer) clearInterval(timer);
			await server.stop(true);
			await ready.catch(() => {});
			await loop.catch(() => {});
		})());

	if (opts.signals !== false) {
		process.once('SIGTERM', () => {
			void stop().finally(() => process.exit(0));
		});
	}

	return { ctx, port: server.port ?? port, ready, stop };
}
