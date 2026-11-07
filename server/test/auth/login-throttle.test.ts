import { afterEach, beforeEach, describe, expect, setSystemTime, spyOn, test } from 'bun:test';
import { ignoredForward, throttleAddress } from '../../src/auth/client-ip.ts';
import { dailyThrottle, hashPassword, loginThrottle, LoginThrottle, lockedGuess, usernameThrottle, withHashSlot } from '../../src/auth/tokens.ts';
import { adminSession, cookieOf, harness, makeUser } from './helpers.ts';

// The tests here send x-forwarded-for on purpose. Those that check the warning clear this first.
beforeEach(() => {
	ignoredForward.seenFrom = 'already warned';
});

afterEach(() => {
	delete process.env.OPAL_TRUST_PROXY;
	delete process.env.OPAL_TRUST_PROXY_HOPS;
	lockedGuess.intervalMs = 5000;
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

	test('failures against one username from many addresses never lock out a correct password once its turn comes', async () => {
		const h = await harness();
		lockedGuess.intervalMs = 0;
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
		// Even an address that failed before is checked: one typo must not end the owner's day.
		expect((await attempt('192.0.2.3', 'right-password-1')).status).toBe(200);
		expect((await attempt('198.51.100.7')).status).toBe(401);
		expect((await attempt('198.51.100.8', 'right-password-1')).status).toBe(200);
	});

	/** Puts a name over its cap directly: fifty real password checks are slow and prove nothing here. */
	const overCap = (username: string) => {
		for (let i = 0; i < 50; i++) usernameThrottle.fail(`name:${username}`);
		lockedGuess.intervalMs = 60_000;
	};

	const setupUser = async (username: string) => {
		const h = await harness();
		makeUser(h, { username, passwordHash: await hashPassword('right-password-1') });
		const attempt = (ip: string, password = 'wrong-guess-xxxx') =>
			h.app.request(
				'http://opal.test/api/auth/login',
				{ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password }) },
				{ ip }
			);
		return { h, attempt };
	};

	const setupLocked = async (username: string) => {
		const made = await setupUser(username);
		overCap(username);
		return made;
	};

	describe('past the name cap', () => {
		test('guesses sent at once from many addresses get one password check between them', async () => {
			const { attempt } = await setupLocked('flooded');
			const results = await Promise.all(Array.from({ length: 60 }, (_, i) => attempt(`192.0.2.${i}`)));
			const counts = results.reduce<Record<number, number>>((n, r) => ({ ...n, [r.status]: (n[r.status] ?? 0) + 1 }), {});
			expect(counts).toEqual({ 401: 1, 429: 59 });
		});

		test('an address the person has signed in from still gets in, even after a typo', async () => {
			const h = await harness();
			makeUser(h, { username: 'owner', passwordHash: await hashPassword('right-password-1') });
			const attempt = (ip: string, password = 'wrong-guess-xxxx') =>
				h.app.request(
					'http://opal.test/api/auth/login',
					{ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'owner', password }) },
					{ ip }
				);
			expect((await attempt('198.51.100.9', 'right-password-1')).status).toBe(200);
			lockedGuess.intervalMs = 0;
			for (let i = 0; i < 5; i++) await Promise.all(Array.from({ length: 10 }, (_, j) => attempt(`10.${i}.${j}.1`)));
			lockedGuess.intervalMs = 60_000;
			expect((await attempt('192.0.2.1')).status).toBe(401); // a stranger takes the slot
			expect((await attempt('192.0.2.2', 'right-password-1')).status).toBe(429);
			expect((await attempt('198.51.100.9')).status).toBe(401); // the owner's typo
			expect((await attempt('198.51.100.9', 'right-password-1')).status).toBe(200);
		});
	});

	describe('taking turns past the name cap', () => {
		const status = async (r: Response | Promise<Response>) => (await r).status;

		test('a new address with the right password gets in while a few addresses keep asking', async () => {
			const { attempt } = await setupLocked('line-owner');
			const start = Date.now();
			lockedGuess.intervalMs = 5000;
			const six = Array.from({ length: 6 }, (_, i) => `172.16.0.${i}`);
			const round = () => Promise.all(six.map((ip) => attempt(ip)));
			setSystemTime(new Date(start + 60_000));
			await round();
			let inAt = 0;
			for (let s = 1; s <= 12 && !inAt; s++) {
				setSystemTime(new Date(start + 60_000 + s * 5000));
				await round();
				if ((await status(attempt('203.0.113.77', 'right-password-1'))) === 200) inAt = s;
			}
			// Six addresses asked first and each had a turn. Then the owner, who has had none, goes next.
			expect(inAt).toBeGreaterThan(0);
			expect(inAt).toBeLessThanOrEqual(7);
		});

		test('asking harder does not move an address up the line', async () => {
			const { attempt } = await setupLocked('line-hard');
			lockedGuess.intervalMs = 5000;
			const start = Date.now() + 60_000;
			setSystemTime(new Date(start));
			expect(await status(attempt('172.16.1.1'))).toBe(401); // first turn
			setSystemTime(new Date(start + 100));
			expect(await status(attempt('203.0.113.5', 'right-password-1'))).toBe(429); // joins the line
			for (let i = 0; i < 50; i++) expect(await status(attempt('172.16.1.1'))).toBe(429);
			setSystemTime(new Date(start + 5000));
			// The slot is open and the hammering address asks first, but the waiting address is next.
			expect(await status(attempt('172.16.1.1'))).toBe(429);
			expect(await status(attempt('203.0.113.5', 'right-password-1'))).toBe(200);
		});

		test('the refusal says when to ask again, and coming back then keeps the place', async () => {
			const { attempt } = await setupLocked('line-wait');
			lockedGuess.intervalMs = 5000;
			const start = Date.now() + 60_000;
			setSystemTime(new Date(start));
			expect(await status(attempt('172.16.2.1'))).toBe(401);
			setSystemTime(new Date(start + 1000));
			const refused = await attempt('203.0.113.6', 'right-password-1');
			expect(refused.status).toBe(429);
			expect((await refused.json()).message).toBe('Too many failed attempts. Try again in 4 seconds.');
			setSystemTime(new Date(start + 5000));
			expect(await status(attempt('203.0.113.6', 'right-password-1'))).toBe(200);
		});

		test('an address that stops asking does not hold the line for long', async () => {
			const { attempt } = await setupLocked('line-gone');
			lockedGuess.intervalMs = 5000;
			const start = Date.now() + 60_000;
			setSystemTime(new Date(start));
			expect(await status(attempt('172.16.3.1'))).toBe(401);
			setSystemTime(new Date(start + 100));
			expect(await status(attempt('172.16.3.2'))).toBe(429); // asks once and never returns
			setSystemTime(new Date(start + 200));
			expect(await status(attempt('203.0.113.7', 'right-password-1'))).toBe(429);
			setSystemTime(new Date(start + 30_000));
			expect(await status(attempt('203.0.113.7', 'right-password-1'))).toBe(429); // still behind it
			setSystemTime(new Date(start + 60_200));
			expect(await status(attempt('203.0.113.7', 'right-password-1'))).toBe(200);
		});

		test('hundreds of addresses in line still get one check per interval', async () => {
			const { attempt } = await setupLocked('line-many');
			lockedGuess.intervalMs = 5000;
			const start = Date.now() + 60_000;
			setSystemTime(new Date(start));
			const first = await Promise.all(Array.from({ length: 600 }, (_, i) => attempt(`172.20.${i >> 8}.${i & 255}`)));
			expect(first.filter((r) => r.status === 401).length).toBe(1);
			setSystemTime(new Date(start + 5000));
			const second = await Promise.all(Array.from({ length: 600 }, (_, i) => attempt(`172.20.${i >> 8}.${i & 255}`)));
			expect(second.filter((r) => r.status === 401).length).toBe(1);
		});
	});

	describe('the daily limit on an address', () => {
		const start = Date.now();
		const fillDay = (ip: string, username: string) => {
			for (let i = 0; i < 30; i++) dailyThrottle.fail(`${ip}:${username}`);
		};
		/** Thirty wrong guesses from one address, spread out so the five-minute limit never applies. */
		const useUpDay = async (attempt: (ip: string, password?: string) => Response | Promise<Response>, ip: string) => {
			for (let i = 0; i < 30; i++) {
				setSystemTime(new Date(start + i * 31_000));
				expect((await attempt(ip)).status).toBe(401);
			}
			setSystemTime(new Date(start + 30 * 31_000));
		};

		test('an address stops after thirty wrong guesses at a name in a day, whichever name is locked', async () => {
			const { attempt } = await setupUser('daily-used');
			await useUpDay(attempt, '172.21.0.1');
			expect((await attempt('172.21.0.1')).status).toBe(429);
			expect((await attempt('172.21.0.1', 'right-password-1')).status).toBe(429);
			setSystemTime(new Date(start + 6 * 3600 * 1000));
			expect((await attempt('172.21.0.1')).status).toBe(429);
			setSystemTime(new Date(start + 25 * 3600 * 1000));
			expect((await attempt('172.21.0.1')).status).toBe(401);
		}, 60_000);

		test('another address and a place the person has signed in from are not affected', async () => {
			const { attempt } = await setupUser('daily-others');
			expect((await attempt('198.51.100.30', 'right-password-1')).status).toBe(200);
			fillDay('172.21.1.1', 'daily-others');
			expect((await attempt('172.21.1.1')).status).toBe(429);
			expect((await attempt('203.0.113.30', 'right-password-1')).status).toBe(200);
			expect((await attempt('198.51.100.30', 'right-password-1')).status).toBe(200);
		});

		test('the same address can still try another name', async () => {
			await setupUser('daily-first');
			fillDay('172.21.2.1', 'daily-first');
			const other = await setupUser('daily-second');
			expect((await other.attempt('172.21.2.1', 'right-password-1')).status).toBe(200);
		});

		test('an unknown name is limited the same way, so the limit does not reveal who exists', async () => {
			const { attempt, h } = await setupUser('daily-real');
			fillDay('172.21.3.1', 'daily-real');
			fillDay('172.21.3.1', 'daily-nobody');
			const real = await attempt('172.21.3.1');
			const unknown = await h.app.request(
				'http://opal.test/api/auth/login',
				{ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'daily-nobody', password: 'wrong-guess-xxxx' }) },
				{ ip: '172.21.3.1' }
			);
			expect(unknown.status).toBe(429);
			expect(real.status).toBe(429);
			expect((await unknown.json()).message).toBe((await real.json()).message);
		});

		test('the refusal says how long is left and how else to get in', async () => {
			const { attempt } = await setupUser('daily-told');
			setSystemTime(new Date(start));
			fillDay('172.21.4.1', 'daily-told');
			const fresh = (await (await attempt('172.21.4.1', 'right-password-1')).json()).message;
			expect(fresh).toBe('Too many failed attempts. Try again in 24 hours. An administrator can reset your password, and restarting OPAL clears this limit.');
			setSystemTime(new Date(start + 22.5 * 3600 * 1000));
			expect((await (await attempt('172.21.4.1', 'right-password-1')).json()).message).toContain('Try again in 2 hours.');
		});

		test('an administrator can reset the password of someone at the limit, and the claim link signs them in', async () => {
			const h = await harness();
			const admin = await adminSession(h);
			const bob = makeUser(h, { username: 'daily-claim', passwordHash: await hashPassword('right-password-1') });
			fillDay('172.21.5.1', 'daily-claim');
			expect((await h.call('POST', `/users/${bob.id}/reset-password`, undefined, { cookie: admin })).status).toBe(200);
			const link = await h.call('POST', '/auth/claim-links', { userId: bob.id }, { cookie: admin });
			expect(link.status).toBe(201);
			const claimed = await h.app.request(
				'http://opal.test/api/auth/claim',
				{ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: (await link.json()).token, password: 'brand-new-password-1' }) },
				{ ip: '172.21.5.1' }
			);
			expect(claimed.status).toBe(200);
			expect(cookieOf(claimed)).toBeTruthy();
		});

		test('what a person gets wrong while signed in does not lock them out when they sign out', async () => {
			const { h, attempt } = await setupUser('daily-signed-in');
			const ip = '172.21.6.1';
			const cookie = cookieOf(await attempt(ip, 'right-password-1'));
			for (let i = 0; i < 31; i++) {
				setSystemTime(new Date(start + i * 31_000));
				expect((await attempt(ip)).status).toBe(401);
			}
			setSystemTime(new Date(start + 31 * 31_000));
			expect((await h.call('POST', '/auth/logout', {}, { cookie })).status).toBe(200);
			expect((await attempt(ip, 'right-password-1')).status).toBe(200);
		}, 60_000);
	});

	test('the five-minute limit says how long is left, in minutes', async () => {
		const { attempt } = await setupUser('short-told');
		const start = Date.now();
		setSystemTime(new Date(start));
		for (let i = 0; i < 10; i++) expect((await attempt('172.22.0.1')).status).toBe(401);
		const refused = await attempt('172.22.0.1', 'right-password-1');
		expect(refused.status).toBe(429);
		expect((await refused.json()).message).toBe('Too many failed attempts. Try again in 5 minutes.');
		setSystemTime(new Date(start + 299_500));
		expect((await (await attempt('172.22.0.1')).json()).message).toBe('Too many failed attempts. Try again in 1 second.');
	}, 60_000);

	describe('a forwarded address with trust off', () => {
		const warnings = () => spyOn(console, 'warn').mockImplementation(() => {});
		const forwarded = (h: Awaited<ReturnType<typeof harness>>, value: string) =>
			h.app.request('http://opal.test/api/auth/config', { headers: { 'x-forwarded-for': value } }, { ip: '10.9.9.9' });

		test('warns once in the log, naming the address that sent it and not what it said', async () => {
			const h = await harness();
			ignoredForward.seenFrom = null;
			const warn = warnings();
			try {
				await forwarded(h, '203.0.113.200');
				await forwarded(h, '203.0.113.201');
				const lines = warn.mock.calls.map(([line]) => String(line)).filter((line) => line.includes('X-Forwarded-For'));
				expect(lines).toHaveLength(1);
				expect(lines[0]).toContain('10.9.9.9');
				expect(lines[0]).toContain('OPAL_TRUST_PROXY=1');
				expect(lines[0]).not.toContain('203.0.113.200');
			} finally {
				warn.mockRestore();
			}
		});

		test('tells an administrator under sign-in settings, and no one else', async () => {
			const h = await harness();
			const admin = await adminSession(h);
			ignoredForward.seenFrom = null;
			const settings = async () => (await (await h.call('GET', '/settings/auth', undefined, { cookie: admin })).json()).ignoredForwardFrom;
			expect(await settings()).toBeNull();
			const warn = warnings();
			try {
				await forwarded(h, '203.0.113.200');
			} finally {
				warn.mockRestore();
			}
			expect(await settings()).toBe('10.9.9.9');
			expect((await h.call('GET', '/settings/auth')).status).toBe(401);
			expect(JSON.stringify(await (await h.call('GET', '/auth/config')).json())).not.toContain('10.9.9.9');
		});

		test('says nothing without the header, or with trust on', async () => {
			const h = await harness();
			const admin = await adminSession(h);
			ignoredForward.seenFrom = null;
			await h.app.request('http://opal.test/api/auth/config', {}, { ip: '10.9.9.9' });
			expect(ignoredForward.seenFrom).toBeNull();
			process.env.OPAL_TRUST_PROXY = '1';
			await forwarded(h, '203.0.113.200');
			expect(ignoredForward.seenFrom).toBeNull();
			ignoredForward.seenFrom = '10.9.9.9';
			expect((await (await h.call('GET', '/settings/auth', undefined, { cookie: admin })).json()).ignoredForwardFrom).toBeNull();
		});
	});

	describe('an address whose session was revoked', () => {
		const lockedOut = async (username: string) => {
			const { h, attempt } = await setupUser(username);
			const lock = async () => {
				overCap(username);
				expect((await attempt('192.0.2.1')).status).toBe(401); // a stranger takes the slot
			};
			return { h, attempt, lock };
		};

		test('is a stranger again after a password change ended the session', async () => {
			const { h, attempt, lock } = await lockedOut('stolen');
			const thief = await attempt('198.51.100.66', 'right-password-1');
			expect(thief.status).toBe(200);
			const owner = await attempt('198.51.100.1', 'right-password-1');
			const cookie = cookieOf(owner);
			const changed = await h.call('POST', '/auth/password', { currentPassword: 'right-password-1', newPassword: 'brand-new-password-1' }, { cookie });
			expect(changed.status).toBe(200);
			await lock();
			expect((await attempt('198.51.100.66')).status).toBe(429);
			// The session the change kept still counts.
			expect((await attempt('198.51.100.1', 'brand-new-password-1')).status).toBe(200);
		});

		test('is a stranger again after the person signs out from it', async () => {
			const { h, attempt, lock } = await lockedOut('signed-out');
			const cookie = cookieOf(await attempt('198.51.100.2', 'right-password-1'));
			expect((await h.call('POST', '/auth/logout', {}, { cookie })).status).toBe(200);
			await lock();
			expect((await attempt('198.51.100.2', 'right-password-1')).status).toBe(429);
		});
	});

	test('addresses in one IPv6 /64 count as one client', async () => {
		const h = await harness();
		const attempt = (ip: string) =>
			h.app.request(
				'http://opal.test/api/auth/login',
				{ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'sixty-four', password: 'wrong-guess-xxxx' }) },
				{ ip }
			);
		for (let i = 1; i <= 10; i++) expect((await attempt(`2001:db8:1:2::${i.toString(16)}`)).status).toBe(401);
		expect((await attempt('2001:db8:1:2:ffff::1')).status).toBe(429);
		expect((await attempt('2001:db8:1:3::1')).status).toBe(401);
		expect(throttleAddress('2001:0db8:0:2:aaaa:bbbb:cccc:dddd')).toBe('2001:db8:0:2::/64');
		expect(throttleAddress('::ffff:192.0.2.1')).toBe('192.0.2.1');
		expect(throttleAddress('192.0.2.1')).toBe('192.0.2.1');
		expect(throttleAddress(null)).toBe('unknown');
	});

	test('a sign-in the full queue turned away does not count as a failed attempt', async () => {
		const h = await harness();
		let release = () => {};
		const held = new Promise<void>((resolve) => (release = resolve));
		const waiting = Array.from({ length: 4 + 64 }, () => withHashSlot(() => held));
		const attempt = () =>
			h.app.request(
				'http://opal.test/api/auth/login',
				{ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'queued', password: 'wrong-guess-xxxx' }) },
				{ ip: '198.51.100.20' }
			);
		for (let i = 0; i < 12; i++) expect((await attempt()).status).toBe(429);
		release();
		await Promise.all(waiting);
		expect((await attempt()).status).toBe(401);
	});

	test('a limit with a bound on its keys forgets the oldest first', () => {
		const t = new LoginThrottle(2, 300_000, 3);
		for (const key of ['a', 'b', 'c', 'd']) t.fail(key);
		expect(t.size).toBe(3);
		expect(t.count('a')).toBe(0);
		expect(t.count('d')).toBe(1);
	});

	test('failing against many other names does not clear a limit an address has reached', () => {
		const t = new LoginThrottle(2, 300_000, 3);
		t.fail('reached');
		t.fail('reached');
		for (let i = 0; i < 20; i++) t.fail(`other-${i}`);
		expect(t.size).toBe(3);
		expect(t.blocked('reached')).toBe(true);
	});

	test('failing against many other names does not give back guesses an address has used', () => {
		const t = new LoginThrottle(30, 300_000, 100);
		for (let i = 0; i < 29; i++) t.fail('guesser');
		for (let i = 0; i < 1000; i++) t.fail(`other-${i}`);
		expect(t.size).toBe(100);
		expect(t.count('guesser')).toBe(29);
	});

	test('with the table full, a guess at another name between guesses does not clear the count', () => {
		const t = new LoginThrottle(30, 300_000, 100);
		for (let i = 0; i < 100; i++) t.fail(`filler-${i}`);
		for (let i = 0; i < 30; i++) {
			t.fail('guesser');
			t.fail(`between-${i}`);
		}
		expect(t.blocked('guesser')).toBe(true);
	});

	test('a table of keys with several failures gives up the one with the fewest', () => {
		const t = new LoginThrottle(30, 300_000, 3);
		for (const [key, n] of [['most', 3], ['fewest', 2], ['more', 3]] as const) for (let i = 0; i < n; i++) t.fail(key);
		t.fail('new');
		expect(t.count('fewest')).toBe(0);
		expect(t.count('most')).toBe(3);
		expect(t.count('more')).toBe(3);
	});

	test('a key at its limit holds no more failures than the limit, and still ages out from the newest', () => {
		const start = Date.now();
		const t = new LoginThrottle(3, 300_000);
		for (let i = 0; i < 20; i++) {
			setSystemTime(new Date(start + i * 1000));
			t.fail('hot');
		}
		expect(t.count('hot')).toBe(3);
		setSystemTime(new Date(start + 17 * 1000 + 299_000));
		expect(t.blocked('hot')).toBe(true);
		expect(t.retryAfter('hot')).toBe(1000);
		setSystemTime(new Date(start + 17 * 1000 + 300_000));
		expect(t.blocked('hot')).toBe(false);
		expect(t.retryAfter('hot')).toBe(0);
	});

	test('taking back the only failure leaves no record of the key', () => {
		const t = new LoginThrottle(3, 300_000);
		t.fail('once');
		t.release('once');
		expect(t.size).toBe(0);
	});

	test('sign-ins the full queue turned away leave no record at any limit, whatever names they use', async () => {
		const h = await harness();
		let release = () => {};
		const held = new Promise<void>((resolve) => (release = resolve));
		const waiting = Array.from({ length: 4 + 64 }, () => withHashSlot(() => held));
		const before = [loginThrottle.size, usernameThrottle.size, dailyThrottle.size];
		for (let i = 0; i < 300; i++) {
			const res = await h.app.request(
				'http://opal.test/api/auth/login',
				{ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: `turned-away-${i}`, password: 'wrong-guess-xxxx' }) },
				{ ip: `198.51.101.${i % 250}` }
			);
			expect(res.status).toBe(429);
		}
		release();
		await Promise.all(waiting);
		expect([loginThrottle.size, usernameThrottle.size, dailyThrottle.size]).toEqual(before);
	});

	test('a turn in line is not used up by a sign-in the full queue turned away', async () => {
		const { attempt } = await setupLocked('queued-turn');
		let release = () => {};
		const held = new Promise<void>((resolve) => (release = resolve));
		const waiting = Array.from({ length: 4 + 64 }, () => withHashSlot(() => held));
		expect((await attempt('192.0.2.60')).status).toBe(429);
		release();
		await Promise.all(waiting);
		expect((await attempt('192.0.2.60')).status).toBe(401);
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
		// Every check waits for the write, so this does not depend on how long a check takes.
		let release = () => {};
		const held = new Promise<void>((resolve) => (release = resolve));
		const verify = spyOn(Bun.password, 'verify').mockImplementation(async () => {
			await held;
			return false;
		});
		try {
			const logins = Array.from({ length: total }, (_, i) =>
				h.call('POST', '/auth/login', { username: `queue-ghost-${i}`, password: 'wrong-password' }).then((r) => {
					done++;
					return r;
				})
			);
			const write = await h.call('POST', '/auth/tokens', { name: 'during-logins' }, { cookie });
			const finishedBefore = done;
			release();
			expect(write.status).toBe(201);
			// Behind serialized logins the write would never get its turn.
			expect(finishedBefore).toBeLessThan(total);
			expect((await Promise.all(logins)).every((r) => r.status === 401)).toBe(true);
		} finally {
			release();
			verify.mockRestore();
		}
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
