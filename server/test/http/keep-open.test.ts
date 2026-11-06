import { describe, expect, test } from 'bun:test';
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
