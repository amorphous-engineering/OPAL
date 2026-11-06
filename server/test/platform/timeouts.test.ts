import { afterEach, describe, expect, test } from 'bun:test';
import { connect } from 'node:net';
import { idleTimeoutSeconds } from '../../src/http/limits.ts';
import { HEARTBEAT_MS } from '../../src/services/platform/files.ts';
import { setup } from './helpers.ts';

const saved = process.env.OPAL_IDLE_TIMEOUT_SECONDS;
afterEach(() => {
	if (saved === undefined) delete process.env.OPAL_IDLE_TIMEOUT_SECONDS;
	else process.env.OPAL_IDLE_TIMEOUT_SECONDS = saved;
});

describe('connection timeouts', () => {
	test('the idle timeout is finite, longer than the stream heartbeat, and a bad setting falls back to it', () => {
		delete process.env.OPAL_IDLE_TIMEOUT_SECONDS;
		expect(idleTimeoutSeconds()).toBeGreaterThan(HEARTBEAT_MS / 1000);
		expect(idleTimeoutSeconds()).toBe(60);
		process.env.OPAL_IDLE_TIMEOUT_SECONDS = '30';
		expect(idleTimeoutSeconds()).toBe(30);
		for (const bad of ['0', '-1', '999', 'abc']) {
			process.env.OPAL_IDLE_TIMEOUT_SECONDS = bad;
			expect(idleTimeoutSeconds(), bad).toBe(60);
		}
	});

	test('an event stream outlives the idle timeout on its heartbeat, while a half-sent request is closed', async () => {
		// Just above the 5 s heartbeat, so the stream must keep itself alive to pass.
		process.env.OPAL_IDLE_TIMEOUT_SECONDS = '7';
		const { app } = await setup();
		const server = Bun.serve({ port: 0, hostname: '127.0.0.1', idleTimeout: idleTimeoutSeconds(), fetch: app.fetch });
		try {
			const started = performance.now();
			// A request whose body never arrives.
			const stalled = new Promise<number>((resolve) => {
				const sock = connect(server.port, '127.0.0.1');
				sock.on('close', () => resolve(performance.now() - started));
				sock.on('error', () => undefined);
				sock.write('POST /api/attachments HTTP/1.1\r\nHost: x\r\nContent-Length: 100000\r\nContent-Type: multipart/form-data; boundary=x\r\n\r\n{');
			});
			const res = await fetch(`http://127.0.0.1:${server.port}/api/events/stream`);
			expect(res.status).toBe(200);
			const reader = res.body!.getReader();
			const decoder = new TextDecoder();
			let beats = 0;
			while (performance.now() - started < 11_000) {
				const { value, done } = await reader.read();
				if (done) break;
				beats += decoder.decode(value).split('"heartbeat"').length - 1;
			}
			await reader.cancel();
			const closedAfter = await stalled;
			expect(beats).toBeGreaterThanOrEqual(3);
			expect(closedAfter).toBeGreaterThan(5_000);
			expect(closedAfter).toBeLessThan(11_000);
		} finally {
			await server.stop(true);
		}
	}, 30_000);
});
