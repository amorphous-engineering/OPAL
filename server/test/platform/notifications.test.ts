import { describe, expect, test } from 'bun:test';
import type { Ctx } from '../../src/context.ts';
import { notification, user } from '../../src/db/schema/index.ts';
import { notify } from '../../src/services/platform/notifications.ts';
import { eq } from 'drizzle-orm';
import { setup } from './helpers.ts';

const base = { kind: 'issue_assigned', title: 'T', href: '/issues/1', subjectType: 'issue', subjectId: 1 } as const;

function ctxFor(s: Awaited<ReturnType<typeof setup>>, i: number): Ctx {
	return { db: s.db, op: 'test', actor: { kind: 'user', userId: s.users[i]!.id, isAdmin: false, sessionId: 1 } };
}

describe('notifications', () => {
	test('notify writes one row per recipient', async () => {
		const s = await setup();
		const rows = notify(ctxFor(s, 0), { ...base, recipients: [s.users[1]!.id, s.users[2]!.id] });
		expect(rows).toHaveLength(2);
		expect(s.db.select().from(notification).all()).toHaveLength(2);
	});

	test('the actor is never notified of their own action', async () => {
		const s = await setup();
		const rows = notify(ctxFor(s, 0), { ...base, recipients: [s.users[0]!.id] });
		expect(rows).toEqual([]);
		const two = notify(ctxFor(s, 0), { ...base, recipients: [s.users[0]!.id, s.users[1]!.id] });
		expect(two.map((r) => r.userId)).toEqual([s.users[1]!.id]);
	});

	test('inactive and unknown users are dropped, duplicates collapse', async () => {
		const s = await setup();
		s.db.update(user).set({ isActive: false }).where(eq(user.id, s.users[2]!.id)).run();
		const rows = notify(ctxFor(s, 0), {
			...base,
			recipients: [s.users[1]!.id, s.users[1]!.id, s.users[2]!.id, 9999, null]
		});
		expect(rows.map((r) => r.userId)).toEqual([s.users[1]!.id]);
	});

	test('category is derived from kind and filters before the limit', async () => {
		const s = await setup();
		const c = ctxFor(s, 0);
		notify(c, { ...base, kind: 'execution_blocked', recipients: [s.users[1]!.id] });
		for (let i = 0; i < 3; i++) notify(c, { ...base, recipients: [s.users[1]!.id] });
		s.as(1);
		const all = await (await s.call('GET', '/notifications?limit=2')).json();
		expect(all.items.every((n: { category: string }) => n.category === 'issues')).toBe(true);
		const ex = await (await s.call('GET', '/notifications?category=executions&limit=2')).json();
		expect(ex.items).toHaveLength(1);
		expect(ex.items[0].category).toBe('executions');
		expect(ex.total).toBe(1);
	});

	test('an unknown category is rejected', async () => {
		const s = await setup();
		expect((await s.call('GET', '/notifications?category=nope')).status).toBe(422);
	});

	test('the list holds only the caller own notifications', async () => {
		const s = await setup();
		notify(ctxFor(s, 0), { ...base, recipients: [s.users[1]!.id] });
		notify(ctxFor(s, 0), { ...base, recipients: [s.users[2]!.id] });
		s.as(1);
		const mine = await (await s.call('GET', '/notifications')).json();
		expect(mine.items).toHaveLength(1);
		expect(mine.unreadCount).toBe(1);
	});

	test('unread count drops on read and read-all, and filters by state', async () => {
		const s = await setup();
		const c = ctxFor(s, 0);
		for (let i = 0; i < 3; i++) notify(c, { ...base, recipients: [s.users[1]!.id] });
		s.as(1);
		const first = (await (await s.call('GET', '/notifications')).json()).items[0];
		const read = await (await s.call('POST', `/notifications/${first.id}/read`)).json();
		expect(read.readAt).not.toBeNull();
		expect((await (await s.call('GET', '/notifications/unread-count')).json()).unreadCount).toBe(2);
		expect((await (await s.call('GET', '/notifications?state=read')).json()).items).toHaveLength(1);
		expect((await (await s.call('GET', '/notifications?state=unread')).json()).items).toHaveLength(2);
		expect((await (await s.call('POST', '/notifications/read-all')).json()).markedRead).toBe(2);
		expect((await (await s.call('GET', '/notifications/unread-count')).json()).unreadCount).toBe(0);
	});

	test('someone else notification is a 404 for read and dismiss', async () => {
		const s = await setup();
		const [row] = notify(ctxFor(s, 0), { ...base, recipients: [s.users[1]!.id] });
		s.as(2);
		expect((await s.call('POST', `/notifications/${row!.id}/read`)).status).toBe(404);
		expect((await s.call('POST', `/notifications/${row!.id}/dismiss`)).status).toBe(404);
	});

	test('dismiss hides the notification and counts it as read', async () => {
		const s = await setup();
		const [row] = notify(ctxFor(s, 0), { ...base, recipients: [s.users[1]!.id] });
		s.as(1);
		const d = await (await s.call('POST', `/notifications/${row!.id}/dismiss`)).json();
		expect(d.readAt).not.toBeNull();
		expect((await (await s.call('GET', '/notifications')).json()).items).toEqual([]);
		expect((await (await s.call('GET', '/notifications/unread-count')).json()).unreadCount).toBe(0);
	});

	test('sort by priority and by unread first; the list reports the actor by name', async () => {
		const s = await setup();
		const c = ctxFor(s, 0);
		notify(c, { ...base, title: 'low', priority: 'low', recipients: [s.users[1]!.id] });
		notify(c, { ...base, title: 'crit', priority: 'critical', recipients: [s.users[1]!.id] });
		notify(c, { ...base, title: 'norm', recipients: [s.users[1]!.id] });
		s.as(1);
		const byPriority = (await (await s.call('GET', '/notifications?sort=priority')).json()).items;
		expect(byPriority.map((n: { title: string }) => n.title)).toEqual(['crit', 'norm', 'low']);
		expect(byPriority[0].actorName).toBe('User 1');
		await s.call('POST', `/notifications/${byPriority[0].id}/read`);
		const unreadFirst = (await (await s.call('GET', '/notifications?sort=unread')).json()).items;
		expect(unreadFirst.at(-1).title).toBe('crit');
	});

	test('the list pages by position', async () => {
		const s = await setup();
		for (let i = 0; i < 3; i++) notify(ctxFor(s, 0), { ...base, title: `n${i}`, recipients: [s.users[1]!.id] });
		s.as(1);
		const p1 = await (await s.call('GET', '/notifications?limit=2')).json();
		expect(p1.items.map((n: { title: string }) => n.title)).toEqual(['n2', 'n1']);
		const p2 = await (await s.call('GET', `/notifications?limit=2&cursor=${p1.next}`)).json();
		expect(p2.items.map((n: { title: string }) => n.title)).toEqual(['n0']);
		expect(p2.next).toBeNull();
	});

	test('anonymous callers get 401', async () => {
		const s = await setup();
		s.setActor({ kind: 'anonymous' });
		expect((await s.call('GET', '/notifications')).status).toBe(401);
	});
});
