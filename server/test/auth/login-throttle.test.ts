import { afterEach, describe, expect, test } from 'bun:test';
import { adminSession, harness } from './helpers.ts';

afterEach(() => {
	delete process.env.OPAL_TRUST_PROXY;
});

describe('login throttle', () => {
	test('a client cannot pick its throttle key with x-forwarded-for', async () => {
		const { call } = await harness();
		let last = 0;
		for (let i = 0; i < 12; i++) {
			last = (
				await call('POST', '/auth/login', { username: 'xff-rotate', password: 'x' }, { 'x-forwarded-for': `10.1.${i}.2` })
			).status;
		}
		expect(last).toBe(429);
	});

	test('x-forwarded-for keys the throttle only when the trusted-proxy setting is on', async () => {
		process.env.OPAL_TRUST_PROXY = '1';
		const { call } = await harness();
		for (let i = 0; i < 11; i++) {
			const res = await call('POST', '/auth/login', { username: 'xff-trusted', password: 'x' }, { 'x-forwarded-for': '10.2.0.1' });
			expect(res.status).toBe(i < 10 ? 401 : 429);
		}
		// A different forwarded client has its own address key.
		const other = await call('POST', '/auth/login', { username: 'xff-trusted', password: 'x' }, { 'x-forwarded-for': '10.2.0.9' });
		expect(other.status).toBe(401);
	});

	test('failures against one username are limited whatever the source address', async () => {
		const { app } = await harness();
		const attempt = (ip: string) =>
			app.request(
				'http://opal.test/api/auth/login',
				{
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ username: 'per-name', password: 'x' })
				},
				{ ip }
			);
		const early = await Promise.all(Array.from({ length: 50 }, (_, i) => attempt(`192.0.2.${i}`)));
		expect(early.every((r) => r.status === 401)).toBe(true);
		expect((await attempt('198.51.100.7')).status).toBe(429);
	});
});

describe('anonymous password checks', () => {
	test('a write is not held in the write queue while logins verify passwords', async () => {
		const h = await harness();
		const cookie = await adminSession(h);
		const total = 8;
		let done = 0;
		const logins = Array.from({ length: total }, (_, i) =>
			h.call('POST', '/auth/login', { username: `queue-ghost-${i}`, password: 'wrong-password' }).then((r) => {
				done++;
				return r;
			})
		);
		const write = await h.call('POST', '/auth/tokens', { name: 'during-logins' }, { cookie });
		const finishedBefore = done;
		expect(write.status).toBe(201);
		// Behind serialized logins the write would finish after every one of them.
		expect(finishedBefore).toBeLessThan(total);
		expect((await Promise.all(logins)).every((r) => r.status === 401)).toBe(true);
	});

	test('two setup requests at once create one administrator', async () => {
		const h = await harness();
		const body = { username: 'first', name: 'First', password: 'correct-horse-battery' };
		const [a, b] = await Promise.all([h.call('POST', '/auth/setup', body), h.call('POST', '/auth/setup', { ...body, username: 'second' })]);
		expect([a.status, b.status].sort()).toEqual([200, 409]);
	});
});
