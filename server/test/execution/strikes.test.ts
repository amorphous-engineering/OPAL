import { describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import type { Actor } from '../../src/context.ts';
import { role, user, userRole } from '../../src/db/schema/index.ts';
import { ensureSystemRoles } from '../../src/services/org/roles.ts';
import { setup } from './helpers.ts';

async function world() {
	const t = await setup();
	ensureSystemRoles(t.db);
	const person = (name: string, roleKey?: string): Actor => {
		const u = t.db.insert(user).values({ username: name, name, createdAt: 'x', updatedAt: 'x' }).returning().get();
		if (roleKey) {
			const r = t.db.select().from(role).where(eq(role.key, roleKey)).get()!;
			t.db.insert(userRole).values({ userId: u.id, roleId: r.id, grantedAt: 'x' }).run();
		}
		return { kind: 'user', userId: u.id, isAdmin: false, sessionId: 1 };
	};
	/** A started work order with an issue raised on it, ready to close short. */
	const started = async () => {
		const e = await t.cut(await t.published(['A', 'B']));
		await t.complete(e.id, '1');
		const issue = (await t.nc(e.id, '2', { containment: 'advisory' })).json;
		return { e, issue };
	};
	return { ...t, person, started };
}

describe('voiding a work order', () => {
	test('a work order nobody has started can be voided, and the reason stays on the record', async () => {
		const t = await world();
		const e = await t.cut(await t.published(['A']));
		const v = await t.ok('POST', `/executions/${e.id}/void`, { reason: 'wrong template' });
		expect(v.status).toBe('void');
		expect(v.active).toBe(false);
		expect(v.completedAt).not.toBeNull();
		expect(v.closure).toMatchObject({ reason: 'wrong template', issueId: null });
		expect(v.closure.by).not.toBeNull();
		expect(v.steps.map((s: any) => s.title)).toEqual(['A']);
	});

	test('a void needs a reason', async () => {
		const t = await world();
		const e = await t.cut(await t.published(['A']));
		expect((await t.call('POST', `/executions/${e.id}/void`, {})).status).toBe(422);
		expect((await t.call('POST', `/executions/${e.id}/void`, { reason: '   ' })).status).toBe(422);
		expect((await t.get(e.id)).status).toBe('cut');
	});

	test('a started work order cannot be voided', async () => {
		const t = await world();
		const e = await t.cut(await t.published(['A', 'B']));
		await t.complete(e.id, '1');
		const r = await t.call('POST', `/executions/${e.id}/void`, { reason: 'changed my mind' });
		expect(r.status).toBe(409);
		expect(r.json.message).toContain('close it short');
	});

	test('a work order that has consumed material cannot be voided', async () => {
		const t = await world();
		const pid = await t.published(['A']);
		const e = await t.cut(pid);
		const part = await t.bulk('Grease');
		const stock = await t.stock(part.id, '5');
		await t.ok('POST', `/executions/${e.id}/consume`, { items: [{ stockId: stock.id, quantity: '1', usage: 'consume' }] });
		expect((await t.get(e.id)).status).toBe('cut');
		expect((await t.call('POST', `/executions/${e.id}/void`, { reason: 'x' })).status).toBe(409);
		expect((await t.doc(e.id)).execution).toMatchObject({ canVoid: false, canCloseShort: true });
	});

	test('a void work order refuses work, edits and a second strike', async () => {
		const t = await world();
		const e = await t.cut(await t.published(['A']));
		await t.ok('POST', `/executions/${e.id}/void`, { reason: 'wrong template' });
		expect((await t.complete(e.id, '1')).status).toBe(409);
		expect((await t.call('PATCH', `/executions/${e.id}`, { priority: 'urgent' })).status).toBe(409);
		expect((await t.call('POST', `/executions/${e.id}/void`, { reason: 'again' })).status).toBe(409);
	});

	test('an API token cannot void a work order', async () => {
		const t = await world();
		const e = await t.cut(await t.published(['A']));
		const token: Actor = { kind: 'token', userId: t.ben.id, isAdmin: true, tokenId: 1 };
		expect((await t.call('POST', `/executions/${e.id}/void`, { reason: 'x' }, token)).status).toBe(403);
	});
});

describe('closing a work order short', () => {
	test('a started work order closes short with a reason and its issue, and stays legible', async () => {
		const t = await world();
		const { e, issue } = await t.started();
		const c = await t.ok('POST', `/executions/${e.id}/close-short`, { reason: 'Vendor stopped making the part', issueId: issue.id });
		expect(c.status).toBe('closed_short');
		expect(c.closure).toMatchObject({ reason: 'Vendor stopped making the part', issueId: issue.id, issueNumber: issue.issueNumber });
		expect(c.steps.map((s: any) => s.status)).toEqual(['completed', 'pending']);
		const d = await t.doc(e.id);
		expect(d.execution.closure.issueNumber).toBe(issue.issueNumber);
		expect(d.execution).toMatchObject({ active: false, canVoid: false, canCloseShort: false });
	});

	test('closing short needs the gate, which engineers hold by default', async () => {
		const t = await world();
		const { e, issue } = await t.started();
		const body = { reason: 'x', issueId: issue.id };
		const tech = t.person('tom', 'technician');
		expect((await t.call('POST', `/executions/${e.id}/close-short`, body, tech)).status).toBe(403);
		expect((await t.call('GET', `/executions/${e.id}/document`, undefined, tech)).json.execution.canCloseShort).toBe(false);
		const eng = t.person('eve', 'engineer');
		expect((await t.call('GET', `/executions/${e.id}/document`, undefined, eng)).json.execution.canCloseShort).toBe(true);
		expect((await t.call('POST', `/executions/${e.id}/close-short`, body, eng)).status).toBe(200);
	});

	test('closing short needs a reason and a linked issue', async () => {
		const t = await world();
		const { e, issue } = await t.started();
		expect((await t.call('POST', `/executions/${e.id}/close-short`, { issueId: issue.id })).status).toBe(422);
		expect((await t.call('POST', `/executions/${e.id}/close-short`, { reason: 'x' })).status).toBe(422);
		expect((await t.get(e.id)).status).toBe('in_work');
	});

	test('the linked issue must be raised on this work order and not be void', async () => {
		const t = await world();
		const { e } = await t.started();
		const other = await t.started();
		const elsewhere = await t.call('POST', `/executions/${e.id}/close-short`, { reason: 'x', issueId: other.issue.id });
		expect(elsewhere.status).toBe(422);
		expect(elsewhere.json.fields.issueId).toContain('raised on this work order');
	});

	test('a work order nobody has started is voided, not closed short', async () => {
		const t = await world();
		const e = await t.cut(await t.published(['A']));
		const issue = (await t.nc(e.id, '1', { containment: 'advisory' })).json;
		const r = await t.call('POST', `/executions/${e.id}/close-short`, { reason: 'x', issueId: issue.id });
		expect(r.status).toBe(409);
		expect(r.json.message).toContain('void it');
	});

	test('an API token cannot close a work order short', async () => {
		const t = await world();
		const { e, issue } = await t.started();
		const token: Actor = { kind: 'token', userId: t.ben.id, isAdmin: true, tokenId: 1 };
		expect((await t.call('POST', `/executions/${e.id}/close-short`, { reason: 'x', issueId: issue.id }, token)).status).toBe(403);
	});

	test('a closed-short work order with a hold still closes, and the issue stays open', async () => {
		const t = await world();
		const e = await t.cut(await t.published(['A', 'B']));
		await t.complete(e.id, '1');
		const issue = (await t.nc(e.id, '2')).json;
		expect((await t.doc(e.id)).holds).toHaveLength(1);
		await t.ok('POST', `/executions/${e.id}/close-short`, { reason: 'cannot recover', issueId: issue.id });
		expect((await t.ok('GET', `/issues/${issue.id}`)).status).toBe('open');
	});
});

describe('a struck work order on the record', () => {
	test('the report of a void or closed-short work order says why it stopped', async () => {
		const t = await world();
		const { e, issue } = await t.started();
		expect((await t.call('GET', `/executions/${e.id}/report`)).status).toBe(409);
		await t.ok('POST', `/executions/${e.id}/close-short`, { reason: 'Vendor gone', issueId: issue.id });
		const r = await t.ok('GET', `/executions/${e.id}/report`);
		expect(r.execution.status).toBe('closed_short');
		expect(r.execution.closure).toMatchObject({ reason: 'Vendor gone', issueNumber: issue.issueNumber });
		const v = await t.cut(await t.published(['A']));
		await t.ok('POST', `/executions/${v.id}/void`, { reason: 'wrong template' });
		expect((await t.ok('GET', `/executions/${v.id}/report`)).execution.closure.reason).toBe('wrong template');
	});

	test('the list counts each terminal status and filters by it', async () => {
		const t = await world();
		const pid = await t.published(['A', 'B']);
		const v = await t.cut(pid);
		await t.ok('POST', `/executions/${v.id}/void`, { reason: 'x' });
		const s = await t.cut(pid);
		await t.complete(s.id, '1');
		const issue = (await t.nc(s.id, '2', { containment: 'advisory' })).json;
		await t.ok('POST', `/executions/${s.id}/close-short`, { reason: 'x', issueId: issue.id });
		await t.cut(pid);
		const all = await t.ok('GET', `/executions?procedureId=${pid}`);
		expect(all.counts).toMatchObject({ cut: 1, in_work: 0, completed: 0, void: 1, closed_short: 1 });
		const short = await t.ok('GET', `/executions?procedureId=${pid}&status=closed_short`);
		expect(short.items.map((r: any) => r.id)).toEqual([s.id]);
	});

	test('the report metrics count void and closed-short work orders', async () => {
		const t = await world();
		const v = await t.cut(await t.published(['A']));
		await t.ok('POST', `/executions/${v.id}/void`, { reason: 'x' });
		const m = await t.ok('GET', '/reports/analytics/executions');
		expect(m).toMatchObject({ void: 1, closedShort: 0 });
	});
});

describe('undo is for pencil', () => {
	test('undo never reverses a void', async () => {
		const t = await world();
		const e = await t.cut(await t.published(['A']));
		await t.ok('POST', `/executions/${e.id}/void`, { reason: 'x' });
		await t.call('POST', '/undo/last');
		expect((await t.get(e.id)).status).toBe('void');
	});

	test('undo never reverses a close short', async () => {
		const t = await world();
		const { e, issue } = await t.started();
		await t.ok('POST', `/executions/${e.id}/close-short`, { reason: 'x', issueId: issue.id });
		await t.call('POST', '/undo/last');
		expect((await t.get(e.id)).status).toBe('closed_short');
	});

	test('undo never reverses an edit of a work order', async () => {
		const t = await world();
		const e = await t.cut(await t.published(['A']));
		await t.ok('PATCH', `/executions/${e.id}`, { priority: 'urgent' });
		await t.call('POST', '/undo/last');
		expect((await t.get(e.id)).priority).toBe('urgent');
	});

	test('undo never reverses a redline', async () => {
		const t = await world();
		const e = await t.cut(await t.published(['A', 'B']));
		const issue = (await t.nc(e.id, '1')).json;
		const before = (await t.doc(e.id)).ops.length;
		await t.ok('POST', `/executions/${e.id}/redlines`, { issueId: issue.id, title: 'Rework', steps: [{ title: 'Fix it' }] });
		await t.call('POST', '/undo/last');
		expect((await t.doc(e.id)).ops.length).toBe(before + 1);
	});
});
