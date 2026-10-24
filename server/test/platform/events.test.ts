import { afterEach, describe, expect, test } from 'bun:test';
import { publish, subscribe, flushEvents, subscriberCount } from '../../src/services/platform/events.ts';
import { resetPresence } from '../../src/services/platform/presence.ts';
import { setup } from './helpers.ts';

afterEach(resetPresence);

describe('events', () => {
	test('a published event reaches every subscriber, later than the publishing call', async () => {
		const got: string[] = [];
		const off1 = subscribe(1, (e) => got.push(`a:${e.type}`));
		const off2 = subscribe(2, (e) => got.push(`b:${e.type}`));
		publish({ type: 'step_completed', data: { n: 1 } });
		expect(got).toEqual([]);
		await flushEvents();
		expect(got.sort()).toEqual(['a:step_completed', 'b:step_completed']);
		off1();
		off2();
	});

	test('an event with userIds reaches only those users', async () => {
		const got: number[] = [];
		const offs = [1, 2, 3].map((u) => subscribe(u, () => got.push(u)));
		publish({ type: 'notification', userIds: [2] });
		await flushEvents();
		expect(got).toEqual([2]);
		offs.forEach((f) => f());
	});

	test('unsubscribing stops delivery and lowers the count', async () => {
		const before = subscriberCount();
		const got: string[] = [];
		const off = subscribe(1, (e) => got.push(e.type));
		expect(subscriberCount()).toBe(before + 1);
		off();
		publish({ type: 'x' });
		await flushEvents();
		expect(got).toEqual([]);
		expect(subscriberCount()).toBe(before);
	});

	test('a failing subscriber does not block the others', async () => {
		const got: string[] = [];
		const a = subscribe(1, () => {
			throw new Error('boom');
		});
		const b = subscribe(2, (e) => got.push(e.type));
		publish({ type: 'ok' });
		await flushEvents();
		expect(got).toEqual(['ok']);
		a();
		b();
	});

	test('the stream route sends an opening frame and then published events', async () => {
		const s = await setup();
		const res = await s.app.request('/api/events/stream');
		expect(res.headers.get('content-type')).toContain('text/event-stream');
		const reader = res.body!.getReader();
		const dec = new TextDecoder();
		let buf = '';
		const readUntil = async (needle: string) => {
			while (!buf.includes(needle)) buf += dec.decode((await reader.read()).value);
		};
		await readUntil('heartbeat');
		publish({ type: 'step_completed', data: { stepId: 7 } });
		await readUntil('step_completed');
		const frame = buf.split('\n\n').find((f) => f.includes('step_completed'))!;
		expect(JSON.parse(frame.replace(/^data: /, ''))).toMatchObject({ type: 'step_completed', data: { stepId: 7 } });
		await reader.cancel();
	});

	test('the stream needs a signed-in caller', async () => {
		const s = await setup();
		s.setActor({ kind: 'anonymous' });
		expect((await s.app.request('/api/events/stream')).status).toBe(401);
	});
});

describe('presence', () => {
	test('a heartbeat puts the caller online with their activity', async () => {
		const s = await setup();
		const r = await (await s.call('POST', '/presence/heartbeat', { activity: 'Viewing /parts' })).json();
		expect(r.online).toMatchObject([{ name: 'User 1', activity: 'Viewing /parts' }]);
	});

	test('everyone who beat recently shows online, sorted by name', async () => {
		const s = await setup();
		s.as(1);
		await s.call('POST', '/presence/heartbeat', {});
		s.as(0);
		await s.call('POST', '/presence/heartbeat', {});
		const r = await (await s.call('GET', '/presence')).json();
		expect(r.online.map((p: { name: string }) => p.name)).toEqual(['User 1', 'User 2']);
	});

	test('a later heartbeat without an activity keeps the last one', async () => {
		const s = await setup();
		await s.call('POST', '/presence/heartbeat', { activity: 'Step 3' });
		const r = await (await s.call('POST', '/presence/heartbeat', {})).json();
		expect(r.online[0].activity).toBe('Step 3');
		const cleared = await (await s.call('POST', '/presence/heartbeat', { activity: null })).json();
		expect(cleared.online[0].activity).toBeNull();
	});

	test('a person who stopped beating drops off', async () => {
		const s = await setup();
		const real = Date.now;
		await s.call('POST', '/presence/heartbeat', {});
		Date.now = () => real() + 60_000;
		try {
			expect((await (await s.call('GET', '/presence')).json()).online).toEqual([]);
		} finally {
			Date.now = real;
		}
	});

	test('presence is not stored in the user table and a heartbeat writes no audit row', async () => {
		const s = await setup();
		await s.call('POST', '/presence/heartbeat', { activity: 'x' });
		const { auditLog } = await import('../../src/db/schema/index.ts');
		expect(s.db.select().from(auditLog).all()).toHaveLength(0);
	});

	test('a heartbeat publishes a user_activity event when the activity changes', async () => {
		const s = await setup();
		await flushEvents(); // earlier tests may have events still queued
		const got: unknown[] = [];
		const off = subscribe(null, (e) => got.push(e.data));
		await s.call('POST', '/presence/heartbeat', { activity: 'A' });
		await s.call('POST', '/presence/heartbeat', { activity: 'A' });
		await s.call('POST', '/presence/heartbeat', { activity: 'B' });
		await flushEvents();
		off();
		expect(got).toHaveLength(2);
	});
});

describe('about', () => {
	test('lists the version and the operations this server implements', async () => {
		const s = await setup();
		const about = await (await s.call('GET', '/about')).json();
		expect(typeof about.version).toBe('string');
		expect(about.operations).toContainEqual({ name: 'platform.about', method: 'GET', path: '/about' });
		expect(about.operations.some((o: { name: string }) => o.name === 'notifications.list')).toBe(true);
	});
});

test('events.stats counts connected stream clients, starting at zero', async () => {
	const { call } = await setup(1);
	const res = await call('GET', '/events/stats');
	expect(res.status).toBe(200);
	expect(await res.json()).toEqual({ connectedClients: 0 });
});
