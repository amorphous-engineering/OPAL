import { afterEach, describe, expect, setSystemTime, test } from 'bun:test';
import { hashPassword, LoginThrottle, lockedGuess, withHashSlot } from '../../src/auth/tokens.ts';
import { adminSession, harness, makeUser } from './helpers.ts';

afterEach(() => {
	delete process.env.OPAL_TRUST_PROXY;
	delete process.env.OPAL_TRUST_PROXY_HOPS;
	lockedGuess.delayMs = 1500;
	setSystemTime();
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

	test('the address a trusted proxy appended is the throttle key, not what the client wrote before it', async () => {
		process.env.OPAL_TRUST_PROXY = '1';
		const { call } = await harness();
		let last = 0;
		for (let i = 0; i < 12; i++) {
			// The client rotates the leftmost entries; the proxy appends the one real address.
			last = (
				await call('POST', '/auth/login', { username: 'xff-forged', password: 'x' }, { 'x-forwarded-for': `6.6.${i}.1, 203.0.113.9` })
			).status;
		}
		expect(last).toBe(429);
	});

	test('with several trusted proxies the address is counted from the right by the configured hop count', async () => {
		process.env.OPAL_TRUST_PROXY = '1';
		process.env.OPAL_TRUST_PROXY_HOPS = '2';
		const { call } = await harness();
		let last = 0;
		for (let i = 0; i < 12; i++) {
			last = (
				await call('POST', '/auth/login', { username: 'xff-hops', password: 'x' }, { 'x-forwarded-for': `6.6.${i}.1, 198.51.100.4, 10.0.0.${i}` })
			).status;
		}
		expect(last).toBe(429);
	});

	test('failures against one username from many addresses never lock out a correct password from a clean address', async () => {
		const h = await harness();
		lockedGuess.delayMs = 0;
		makeUser(h, { username: 'per-name', passwordHash: await hashPassword('right-password-1') });
		const attempt = (ip: string, password = 'x') =>
			h.app.request(
				'http://opal.test/api/auth/login',
				{
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ username: 'per-name', password })
				},
				{ ip }
			);
		const early = await Promise.all(Array.from({ length: 50 }, (_, i) => attempt(`192.0.2.${i}`)));
		expect(early.every((r) => r.status === 401)).toBe(true);
		// An address that has already failed against this name is refused.
		expect((await attempt('192.0.2.3', 'right-password-1')).status).toBe(429);
		// A clean address is still checked: a wrong guess is a 401, the right password signs in.
		expect((await attempt('198.51.100.7')).status).toBe(401);
		const ok = await attempt('198.51.100.8', 'right-password-1');
		expect(ok.status).toBe(200);
	});

	test('wrong guesses from clean addresses are answered after a delay once a username is over its cap', async () => {
		const h = await harness();
		lockedGuess.delayMs = 300;
		const attempt = (ip: string) =>
			h.app.request(
				'http://opal.test/api/auth/login',
				{ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'slowed', password: 'x' }) },
				{ ip }
			);
		await Promise.all(Array.from({ length: 50 }, (_, i) => attempt(`192.0.2.${i}`)));
		const t0 = Date.now();
		expect((await attempt('203.0.113.50')).status).toBe(401);
		expect(Date.now() - t0).toBeGreaterThanOrEqual(280);
	});

	test('failure records for names that are never seen again are dropped', () => {
		const t = new LoginThrottle(10, 300_000);
		const start = Date.now();
		for (let i = 0; i < 500; i++) t.fail(`name:ghost-${i}`);
		expect(t.size).toBe(500);
		setSystemTime(new Date(start + 400_000));
		t.fail('name:someone-new');
		expect(t.size).toBe(1);
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

describe('the password hash queue', () => {
	test('a sign-in past the queue is told to try again instead of waiting', async () => {
		let release = () => {};
		const held = new Promise<void>((resolve) => (release = resolve));
		const waiting = Array.from({ length: 4 + 64 }, () => withHashSlot(() => held));
		await expect(withHashSlot(async () => 'never')).rejects.toMatchObject({ status: 429 });
		release();
		await Promise.all(waiting);
		expect(await withHashSlot(async () => 'free again')).toBe('free again');
	});
});
