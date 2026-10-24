import { describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import type { Ctx } from '../../src/context.ts';
import { auditLog, part } from '../../src/db/schema/index.ts';
import { registerReversible, revertRows } from '../../src/services/platform/undo.ts';
import { insert, update } from '../../src/write.ts';
import { setup } from './helpers.ts';

// Test operations: the real ones are registered by their areas.
registerReversible('t.create', { revert: (ctx, rows) => revertRows(ctx, rows, { part }) });
registerReversible('t.rename', { group: () => 1, revert: (ctx, rows) => revertRows(ctx, rows, { part }) });

const newPart = (n: number) =>
	({ internalPn: `P-${n}`, name: `Part ${n}`, unitOfMeasure: 'ea', trackingType: 'bulk', procurement: 'make', tier: 1 }) as const;

type S = Awaited<ReturnType<typeof setup>>;
const ctx = (s: S, i: number, op: string): Ctx => ({
	db: s.db,
	op,
	actor: { kind: 'user', userId: s.users[i]!.id, isAdmin: false, sessionId: 1 }
});

/** One call of the test create operation: an insert and a follow-up update, like parts.create. */
function create(s: S, i: number, n: number) {
	const c = ctx(s, i, 't.create');
	const p = insert(c, part, newPart(n));
	update(c, part, p.id, { description: 'd' });
	return p;
}

describe('undo last action', () => {
	test('preview names the action and the record, not its id', async () => {
		const s = await setup();
		create(s, 0, 1);
		const p = await (await s.call('GET', '/undo/last')).json();
		expect(p).toMatchObject({ op: 't.create', canUndo: true, reason: null });
		expect(p.summary).toBe('CREATE Part P-1');
	});

	test('undoing a create removes the record, and the whole call is one action', async () => {
		const s = await setup();
		create(s, 0, 1);
		create(s, 0, 2);
		const r = await (await s.call('POST', '/undo/last')).json();
		expect(r.summary).toContain('P-2');
		expect(s.db.select().from(part).all().map((p) => p.internalPn)).toEqual(['P-1']);
	});

	test('a second undo reaches the action before the first', async () => {
		const s = await setup();
		create(s, 0, 1);
		create(s, 0, 2);
		await s.call('POST', '/undo/last');
		await s.call('POST', '/undo/last');
		expect(s.db.select().from(part).all()).toEqual([]);
		expect((await s.call('GET', '/undo/last')).status).toBe(404);
	});

	test('undoing an update gives back the old values', async () => {
		const s = await setup();
		const p = create(s, 0, 1);
		update(ctx(s, 0, 't.rename'), part, p.id, { name: 'Renamed' });
		const pre = await (await s.call('GET', '/undo/last')).json();
		expect(pre.summary).toBe('UPDATE Part P-1 (changed: name)');
		await s.call('POST', '/undo/last');
		expect(s.db.select().from(part).where(eq(part.id, p.id)).get()!.name).toBe('Part 1');
	});

	test('an operation that is not marked reversible cannot be undone, and undo does not reach past it', async () => {
		const s = await setup();
		const p = create(s, 0, 1);
		update(ctx(s, 0, 't.irreversible'), part, p.id, { name: 'X' });
		const pre = await (await s.call('GET', '/undo/last')).json();
		expect(pre).toMatchObject({ canUndo: false, op: 't.irreversible' });
		expect(pre.reason).toContain('t.irreversible');
		const res = await s.call('POST', '/undo/last');
		expect(res.status).toBe(409);
		expect(s.db.select().from(part).all()).toHaveLength(1);
	});

	test('undo refuses when the record changed after the action', async () => {
		const s = await setup();
		const p = create(s, 0, 1);
		update(ctx(s, 1, 'other.edit'), part, p.id, { name: 'By someone else' });
		s.as(0);
		// The newest action of user 1 is create; the record has a newer change.
		const res = await s.call('POST', '/undo/last');
		expect(res.status).toBe(409);
		expect((await res.json()).error).toBe('changed_since');
		expect(s.db.select().from(part).all()).toHaveLength(1);
	});

	test('undo looks only at the caller own actions', async () => {
		const s = await setup();
		create(s, 1, 1);
		s.as(0);
		expect((await s.call('GET', '/undo/last')).status).toBe(404);
		expect((await s.call('POST', '/undo/last')).status).toBe(404);
	});

	test('actions older than one hour are out of reach', async () => {
		const s = await setup();
		create(s, 0, 1);
		const old = new Date(Date.now() - 61 * 60 * 1000).toISOString();
		s.db.update(auditLog).set({ at: old }).run();
		expect((await s.call('GET', '/undo/last')).status).toBe(404);
	});

	test('the undo itself is audited under its own operation name', async () => {
		const s = await setup();
		create(s, 0, 1);
		await s.call('POST', '/undo/last');
		const ops = s.db.select().from(auditLog).all().map((r) => r.op);
		expect(ops.filter((o) => o === 'undo.last').length).toBeGreaterThan(0);
	});
});
