import { describe, expect, test } from 'bun:test';
import { connect } from 'node:net';
import { addPlugin, restoreRuntime, setup, stubRuntime } from '../plugins/helpers.ts';

describe('work that can sit silent past the idle timeout', () => {
	const env = () => {
		let calls = 0;
		return { env: { ip: null, keepOpen: () => void calls++ }, calls: () => calls };
	};

	test('a plugin download keeps its connection open; an ordinary operation does not', async () => {
		const s = await setup();
		process.env.OPAL_PLUGINS = '0';
		try {
			const download = env();
			await s.app.request('/api/plugins/preview', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"source":"o/r"}' }, download.env);
			expect(download.calls()).toBe(1);
			const ordinary = env();
			await s.app.request('/api/plugins', {}, ordinary.env);
			expect(ordinary.calls()).toBe(0);
		} finally {
			delete process.env.OPAL_PLUGINS;
		}
	});

	test('nobody keeps a connection open before they have shown they may run the operation', async () => {
		const s = await setup();
		const preview = (e: object) => s.app.request('/api/plugins/preview', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"source":"o/r"}' }, e);
		process.env.OPAL_PLUGINS = '0';
		try {
			s.setActor({ kind: 'anonymous' });
			const anon = env();
			expect((await preview(anon.env)).status).toBe(401);
			expect(anon.calls()).toBe(0);
			s.setActor({ kind: 'user', userId: s.person.id, isAdmin: false, sessionId: 1 });
			const staff = env();
			expect((await preview(staff.env)).status).toBe(403);
			expect(staff.calls()).toBe(0);
		} finally {
			delete process.env.OPAL_PLUGINS;
		}
	});

	test('an anonymous request that stops partway through its body is closed by the idle timeout', async () => {
		const s = await setup();
		s.setActor({ kind: 'anonymous' });
		const server = Bun.serve({
			port: 0,
			hostname: '127.0.0.1',
			idleTimeout: 1,
			fetch: (req, srv) => s.app.fetch(req, { ip: null, keepOpen: () => srv.timeout(req, 0) })
		});
		try {
			for (const path of ['/api/plugins/preview', '/api/plugins/install']) {
				const closed = await new Promise<boolean>((resolve) => {
					const sock = connect(server.port!, '127.0.0.1');
					const timer = setTimeout(() => {
						sock.destroy();
						resolve(false);
					}, 12_000);
					sock.on('close', () => {
						clearTimeout(timer);
						resolve(true);
					});
					sock.on('error', () => undefined);
					sock.write(`POST ${path} HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: 1000\r\n\r\n{`);
				});
				expect(closed).toBe(true);
			}
		} finally {
			server.stop(true);
		}
	}, 40_000);

	test('an anonymous webhook stays under the idle timeout', async () => {
		const s = await setup();
		const upstream = Bun.serve({ port: 0, fetch: () => new Response('ok') });
		try {
			addPlugin(s.db, 'hooked', { permissions: { ops: [], events: [], hooks: true } });
			stubRuntime({ hooked: upstream.port! });
			s.setActor({ kind: 'anonymous' });
			const hook = env();
			const res = await s.app.request('/hooks/hooked/event', { method: 'POST', body: 'x' }, hook.env);
			expect(res.status).toBe(200);
			expect(hook.calls()).toBe(0);
		} finally {
			restoreRuntime();
			upstream.stop(true);
		}
	});

	test('a plugin page keeps its connection open', async () => {
		const s = await setup();
		const upstream = Bun.serve({ port: 0, fetch: () => new Response('ok') });
		try {
			addPlugin(s.db, 'kaneo');
			stubRuntime({ kaneo: upstream.port! });
			const page = env();
			const res = await s.app.request('/plugins/kaneo/page', {}, page.env);
			expect(res.status).toBe(200);
			expect(page.calls()).toBe(1);
		} finally {
			restoreRuntime();
			upstream.stop(true);
		}
	});

	test('Bun lets a request outlast the idle timeout once it asks to', async () => {
		const handler = (keep: boolean) => async (req: Request, server: Bun.Server<unknown>) => {
			if (keep) server.timeout(req, 0);
			await Bun.sleep(4000);
			return new Response('done');
		};
		const server = Bun.serve({ port: 0, hostname: '127.0.0.1', idleTimeout: 1, fetch: handler(true) });
		try {
			const res = await fetch(`http://127.0.0.1:${server.port}/`);
			expect(await res.text()).toBe('done');
		} finally {
			server.stop(true);
		}
	}, 20_000);
});
