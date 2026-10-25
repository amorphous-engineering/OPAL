import { describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { canonicalDesignator } from '@opal/shared';
import { notification } from '../../src/db/schema/index.ts';
import { setup } from './helpers.ts';

async function tree(t: Awaited<ReturnType<typeof setup>>) {
	const p = await t.proc('Tree');
	await t.tree(p.id);
	await t.ok('POST', `/procedures/${p.id}/publish`, {});
	return p.id as number;
}

describe('non-conformance on a step', () => {
	test('raising an NC fills the context and holds the step it was raised at', async () => {
		const t = await setup();
		const e = await t.cut(await t.published(['A', 'B']));
		const r = await t.nc(e.id, '1', { shouldBe: '5 mm', actual: '4 mm', priority: 'high' });
		expect(r.status).toBe(200);
		expect(r.json.issueNumber).toMatch(/^IT-/);
		const issue = await t.ok('GET', `/issues/${r.json.id}`);
		expect(issue).toMatchObject({
			issueType: 'non_conformance',
			containment: 'step',
			executionId: e.id,
			raisedStepId: await t.stepOf(e.id, '1'),
			projectId: t.proj.id,
			shouldBe: '5 mm',
			priority: 'high'
		});
		expect(issue.execution.label).toBe(e.woNumber);
		expect(issue.raisedStepLabel).toBe('1');
	});

	test('an undispositioned NC refuses complete and skip, and names the issue', async () => {
		const t = await setup();
		const e = await t.cut(await t.published(['A', 'B']));
		const nc = await t.nc(e.id, '1');
		const c = await t.complete(e.id, '1');
		expect(c.status).toBe(409);
		expect(c.json.message).toContain(`Undispositioned ${nc.json.issueNumber}`);
		expect((await t.skip(e.id, '1')).status).toBe(409);
		const d = await t.doc(e.id);
		expect(d.ops[0].step.completeBlockers[0]).toMatchObject({ kind: 'nc', issueNumber: nc.json.issueNumber });
		expect(d.ops[0].step.holds[0]).toMatchObject({ kind: 'raised', issueNumber: nc.json.issueNumber });
		expect(d.ops[0].holds).toHaveLength(1);
		expect(d.holds[0]).toMatchObject({ issueNumber: nc.json.issueNumber, blocks: ['1'] });
		// The other step is free.
		expect((await t.complete(e.id, '2')).status).toBe(200);
	});

	test('signing the disposition releases the hold and the issue stays open', async () => {
		const t = await setup();
		const e = await t.cut(await t.published(['A', 'B']));
		const nc = await t.nc(e.id, '1');
		expect((await t.disposition(nc.json.id)).status).toBe(200);
		const issue = await t.ok('GET', `/issues/${nc.json.id}`);
		expect(issue.status).toBe('open');
		expect((await t.complete(e.id, '1')).status).toBe(200);
		const d = await t.doc(e.id);
		expect(d.ops[0].step.issueHistory[0]).toMatchObject({ issueNumber: nc.json.issueNumber, state: 'dispositioned' });
	});

	test('two NCs on a step both need a disposition', async () => {
		const t = await setup();
		const e = await t.cut(await t.published(['A']));
		const n1 = await t.nc(e.id, '1');
		const n2 = await t.nc(e.id, '1', { title: 'Second' });
		await t.disposition(n1.json.id);
		expect((await t.complete(e.id, '1')).status).toBe(409);
		await t.disposition(n2.json.id);
		expect((await t.complete(e.id, '1')).status).toBe(200);
	});

	test('an advisory issue blocks nothing', async () => {
		const t = await setup();
		const e = await t.cut(await t.published(['A']));
		await t.nc(e.id, '1', { containment: 'advisory' });
		expect((await t.complete(e.id, '1')).status).toBe(200);
		expect((await t.ok('GET', `/executions/${e.id}/holds`)).held).toBe(false);
	});

	test('the holds payload names what each issue stops', async () => {
		const t = await setup();
		const e = await t.cut(await t.published(['A', 'B']));
		const nc = await t.nc(e.id, '1');
		const h = await t.ok('GET', `/executions/${e.id}/holds`);
		expect(h.held).toBe(true);
		expect(h.holds[0]).toMatchObject({ issueNumber: nc.json.issueNumber, containment: 'step', blocks: ['OP 1 COMPLETE'] });
	});

	test('a containment other than the allowed ones is rejected', async () => {
		const t = await setup();
		const e = await t.cut(await t.published(['A']));
		expect((await t.nc(e.id, '1', { containment: 'galaxy' })).status).toBe(422);
	});
});

describe('containment scope', () => {
	test('an NC on a sub-step holds its parent OP too, while a sibling sub-step can still be completed', async () => {
		const t = await setup();
		const e = await t.cut(await tree(t));
		const nc = await t.nc(e.id, '1.1');
		expect((await t.complete(e.id, '1.2')).status).toBe(200);
		expect((await t.complete(e.id, '1.1')).status).toBe(409);
		const d = await t.doc(e.id);
		expect(d.ops[0].holds).toHaveLength(1);
		expect(d.ops[0].step.holds[0].issueNumber).toBe(nc.json.issueNumber);
		await t.disposition(nc.json.id);
		expect((await t.complete(e.id, '1.1')).status).toBe(200);
		expect((await t.doc(e.id)).ops[0].step.status).toBe('completed');
	});

	test('op containment holds the OP complete and not its steps', async () => {
		const t = await setup();
		const e = await t.cut(await tree(t));
		const nc = await t.nc(e.id, '1.1', { containment: 'op' });
		expect((await t.complete(e.id, '1.1')).status).toBe(200);
		expect((await t.complete(e.id, '1.2')).status).toBe(200);
		// Both sub-steps are done but the OP must not auto-complete over the hold.
		const d = await t.doc(e.id);
		expect(d.ops[0].step.status).toBe('pending');
		expect(d.ops[0].step.completeBlockers.map((b: any) => b.kind)).toContain('nc');
		await t.disposition(nc.json.id);
		// Releasing the hold lets the OP complete and the execution follow.
		await t.complete(e.id, '2.1');
		expect((await t.doc(e.id)).ops[0].step.status).toBe('completed');
		expect((await t.get(e.id)).status).toBe('completed');
	});

	test('wo containment keeps the execution open after every step is done', async () => {
		const t = await setup();
		const e = await t.cut(await t.published(['A', 'B']));
		const nc = await t.nc(e.id, '1', { containment: 'wo' });
		expect((await t.complete(e.id, '1')).status).toBe(200);
		expect((await t.complete(e.id, '2')).status).toBe(200);
		expect((await t.get(e.id)).status).toBe('in_work');
		await t.disposition(nc.json.id);
		expect((await t.get(e.id)).status).toBe('completed');
	});

	test('a boundary hold binds a later step: work goes on up to it, which cannot complete', async () => {
		const t = await setup();
		const e = await t.cut(await t.published(['A', 'B', 'C']));
		const boundary = await t.stepOf(e.id, '3');
		const nc = await t.nc(e.id, '1', { containmentStepId: boundary });
		expect((await t.complete(e.id, '1')).status).toBe(200);
		expect((await t.complete(e.id, '2')).status).toBe(200);
		const c = await t.complete(e.id, '3');
		expect(c.status).toBe(409);
		const d = await t.doc(e.id);
		expect(d.ops[2].step.holds[0]).toMatchObject({ kind: 'bound', issueNumber: nc.json.issueNumber });
		await t.disposition(nc.json.id);
		expect((await t.complete(e.id, '3')).status).toBe(200);
	});

	test('the execution stays open under a boundary hold bound to a finished step', async () => {
		const t = await setup();
		const e = await t.cut(await t.published(['A', 'B']));
		await t.complete(e.id, '1');
		const nc = await t.nc(e.id, '2', { containmentStepId: await t.stepOf(e.id, '1') });
		expect((await t.complete(e.id, '2')).status).toBe(200);
		expect((await t.get(e.id)).status).toBe('in_work');
		await t.disposition(nc.json.id);
		expect((await t.get(e.id)).status).toBe('completed');
	});

	test('an NC anchored in another execution is refused', async () => {
		const t = await setup();
		const pid = await t.published(['A', 'B']);
		const e1 = await t.cut(pid);
		const e2 = await t.cut(pid);
		const foreign = await t.stepOf(e2.id, '1');
		expect((await t.nc(e1.id, '1', { containmentStepId: foreign })).status).toBe(404);
		const r = await t.call('POST', '/issues', { title: 'x', executionId: e1.id, raisedStepId: foreign, containment: 'step' });
		expect(r.status).toBe(422);
	});

	test('voiding the issue lifts the hold', async () => {
		const t = await setup();
		const e = await t.cut(await t.published(['A']));
		const nc = await t.nc(e.id, '1');
		expect((await t.complete(e.id, '1')).status).toBe(409);
		await t.ok('POST', `/issues/${nc.json.id}/void`, { reason: 'raised by mistake' });
		expect((await t.complete(e.id, '1')).status).toBe(200);
	});
});

describe('notifications', () => {
	test('people who worked the run hear when it becomes blocked and unblocked', async () => {
		const t = await setup();
		const e = await t.cut(await t.published(['A', 'B', 'C']));
		// ben completes a step, so ben has worked the run.
		await t.complete(e.id, '1', {}, t.benActor);
		const nc = await t.nc(e.id, '2');
		const mine = () => t.db.select().from(notification).where(eq(notification.userId, t.ben.id)).all();
		expect(mine().map((n) => n.kind)).toEqual(['execution_blocked']);
		expect(mine()[0]).toMatchObject({ href: `/executions/${e.id}`, subjectType: 'execution', priority: 'high' });
		expect(mine()[0]!.title).toContain(canonicalDesignator(e.woNumber)); // the table holds the stored form
		// A second blocker on a blocked run is silent.
		const nc2 = await t.nc(e.id, '3');
		expect(mine()).toHaveLength(1);
		await t.disposition(nc.json.id);
		expect(mine()).toHaveLength(1);
		await t.disposition(nc2.json.id);
		expect(mine().map((n) => n.kind)).toEqual(['execution_blocked', 'execution_unblocked']);
	});

	test('an advisory issue raises no execution notification, and nobody hears about their own act', async () => {
		const t = await setup();
		const e = await t.cut(await t.published(['A', 'B']));
		await t.complete(e.id, '1', {}, t.benActor);
		await t.nc(e.id, '2', { containment: 'advisory' });
		expect(t.db.select().from(notification).where(eq(notification.userId, t.ben.id)).all()).toHaveLength(0);
		// The author cut it and raises the NC: the author is the actor and is not told.
		await t.nc(e.id, '2');
		expect(t.db.select().from(notification).where(eq(notification.userId, t.author.userId)).all()).toHaveLength(0);
	});
});

describe('issue links', () => {
	test('the issues list filters by the procedure of the execution', async () => {
		const t = await setup();
		const pa = await t.published(['A']);
		const pb = await t.published(['B']);
		const ea = await t.cut(pa);
		const eb = await t.cut(pb);
		await t.nc(ea.id, '1');
		await t.nc(eb.id, '1');
		const list = await t.ok('GET', `/issues?procedureId=${pa}`);
		expect(list.items).toHaveLength(1);
		expect(list.items[0].executionId).toBe(ea.id);
		expect((await t.ok('GET', `/issues?executionId=${eb.id}`)).items).toHaveLength(1);
	});

	test('an issue can name the steps of its execution as boundary options', async () => {
		const t = await setup();
		const e = await t.cut(await t.published(['A', 'B']));
		const nc = await t.nc(e.id, '1');
		const opts = await t.ok('GET', `/issues/${nc.json.id}/steps`);
		expect(opts.map((o: any) => o.label)).toEqual(['1', '2']);
		const holding = await t.ok('GET', `/issues/${nc.json.id}/holding`);
		expect(holding[0].label).toBe('1 COMPLETE');
	});
});
