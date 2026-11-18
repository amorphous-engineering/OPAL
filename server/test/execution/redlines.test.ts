import { describe, expect, test } from 'bun:test';
import { setup } from './helpers.ts';

async function withNc(t: Awaited<ReturnType<typeof setup>>, titles = ['A', 'B', 'C']) {
	const e = await t.cut(await t.published(titles));
	const nc = await t.nc(e.id, '2');
	return { e, nc: nc.json as { id: number; issueNumber: string } };
}
const redline = (t: Awaited<ReturnType<typeof setup>>, e: { id: number }, issueId: number, steps = [{ title: 'Rework' }]) =>
	t.call('POST', `/executions/${e.id}/redlines`, { issueId, title: 'Repair', steps });

describe('redlines', () => {
	test('a redline gets an R-number of its host OP and numbered steps', async () => {
		const t = await setup();
		const { e, nc } = await withNc(t, ['A', 'B', 'C', 'D']);
		const r = await redline(t, e, nc.id, [{ title: 'Grind' }, { title: 'Inspect' }]);
		expect(r.status).toBe(200);
		expect(r.json).toMatchObject({ number: '2R1', title: 'Repair', status: 'pending', issueNumber: nc.issueNumber });
		expect(r.json.steps.map((s: any) => s.number)).toEqual(['2R1.1', '2R1.2']);
		const second = await redline(t, e, nc.id);
		expect(second.json.number).toBe('2R2');
		expect((await t.ok('GET', `/executions/${e.id}/redlines`)).map((x: any) => x.number)).toEqual(['2R1', '2R2']);
	});

	test('the document puts a redline OP before its host and marks it ad hoc', async () => {
		const t = await setup();
		const { e, nc } = await withNc(t);
		await redline(t, e, nc.id);
		const d = await t.doc(e.id);
		expect(d.ops.map((o: any) => o.number)).toEqual(['1', '2R1', '2', '3']);
		const op = d.ops[1];
		expect(op.isAdHoc).toBe(true);
		expect(op.redline).toMatchObject({ issueNumber: nc.issueNumber });
		expect(op.steps[0].number).toBe('2R1.1');
		expect(d.ops[2].openNcs[0].issueNumber).toBe(nc.issueNumber);
		expect(op.openNcs).toEqual([]);
	});

	test('a redline must answer an NC raised at a step of this execution', async () => {
		const t = await setup();
		const e = await t.cut(await t.published(['A', 'B']));
		const task = await t.ok('POST', '/issues', { title: 'task', projectId: t.proj.id });
		expect((await redline(t, e, task.id)).status).toBe(409);
		const loose = await t.ok('POST', '/issues', { title: 'loose', issueType: 'non_conformance', projectId: t.proj.id });
		expect((await redline(t, e, loose.id)).status).toBe(409);
		const e2 = await t.cut(await t.published(['A']));
		const other = await t.nc(e2.id, '1');
		expect((await redline(t, e, other.json.id)).status).toBe(409);
		expect((await redline(t, e, 9999)).status).toBe(404);
	});

	test('the host OP waits for its redline, and the redline rides the NC to completion', async () => {
		const t = await setup();
		const { e, nc } = await withNc(t, ['A', 'B']);
		const r = await redline(t, e, nc.id);
		await t.complete(e.id, '1');
		await t.disposition(nc.id);
		const blocked = await t.complete(e.id, '2');
		expect(blocked.status).toBe(409);
		expect(blocked.json.message).toContain('Waiting on redline op 2R1');
		const d = await t.doc(e.id);
		expect(d.ops[2].step.completeBlockers.map((b: any) => b.kind)).toContain('redline');
		expect(d.ops[1].steps[0].completeBlockers).toEqual([]);
		await t.complete(e.id, '2R1.1');
		expect((await t.doc(e.id)).ops[1].step.status).toBe('completed');
		expect((await t.complete(e.id, '2')).status).toBe(200);
		expect((await t.get(e.id)).status).toBe('completed');
		expect(r.json.number).toBe('2R1');
	});

	test('an open redline blocks skipping its host even after the disposition', async () => {
		const t = await setup();
		const { e, nc } = await withNc(t, ['A', 'B']);
		await redline(t, e, nc.id);
		await t.disposition(nc.id);
		const s = await t.skip(e.id, '2');
		expect(s.status).toBe(409);
		expect(s.json.message).toContain('redline op 2R1');
	});

	test('a redline step with data and a second buyoff behaves like any step', async () => {
		const t = await setup();
		const { e, nc } = await withNc(t, ['A', 'B']);
		await redline(t, e, nc.id, [
			{ title: 'Measure', dataSchema: { fields: [{ name: 'gap', type: 'number', required: true }] }, requiresSignoff: true } as never
		]);
		await t.disposition(nc.id);
		expect((await t.complete(e.id, '2R1.1')).status).toBe(422);
		const first = await t.complete(e.id, '2R1.1', { dataCaptured: { gap: 2 } });
		expect(first.json.step.status).toBe('awaiting_signoff');
		await t.sign(e.id, '2R1.1', 1, {}, t.benActor);
		expect((await t.doc(e.id)).ops[1].step.status).toBe('completed');
	});

	test('a draft can be deleted; a released redline is pen', async () => {
		const t = await setup();
		const { e, nc } = await withNc(t, ['A', 'B']);
		const a = (await redline(t, e, nc.id, [{ title: 'one' }, { title: 'two' }])).json;
		await t.ok('DELETE', `/executions/${e.id}/redlines/${a.id}`);
		expect(await t.ok('GET', `/executions/${e.id}/redlines`)).toEqual([]);
		expect((await t.get(e.id)).steps.map((s: any) => s.number)).toEqual(['1', '2']);
		const b = (await redline(t, e, nc.id)).json;
		await t.disposition(nc.id);
		const refused = await t.call('DELETE', `/executions/${e.id}/redlines/${b.id}`);
		expect(refused.status).toBe(409);
		expect(refused.json.message).toContain('released');
		expect((await t.call('DELETE', `/executions/${e.id}/redlines/9999`)).status).toBe(404);
	});

	test('the floor cannot claim, note or complete a draft redline', async () => {
		const t = await setup();
		const { e, nc } = await withNc(t, ['A', 'B']);
		const r = (await redline(t, e, nc.id)).json;
		expect(r.releasedAt).toBeNull();
		const ids = (await t.get(e.id)).steps.filter((s: any) => /^2R1/.test(s.number)).map((s: any) => s.id);
		const claim = await t.call('POST', `/executions/${e.id}/focus`, { stepId: ids[0] });
		expect(claim.status).toBe(409);
		expect(claim.json.message).toContain('2R1 is a draft');
		expect((await t.call('POST', `/executions/${e.id}/steps/${ids[1]}/notes`, { body: 'Found crack' })).status).toBe(409);
		expect((await t.complete(e.id, '2R1.1')).status).toBe(409);
		const d = await t.doc(e.id);
		expect(d.ops[1].redline).toMatchObject({ releasedAt: null, canEdit: true, canRelease: false });
		expect(d.ops[1].steps[0].completeBlockers.map((b: any) => b.message)).toContain('Redline op 2R1 is a draft');
		// A draft is pencil: it counts for nothing in progress.
		expect(d.progress.total).toBe(2);
	});

	test('signing the disposition releases every draft of the issue, so the hold passes to the redline gate', async () => {
		const t = await setup();
		const { e, nc } = await withNc(t, ['A', 'B']);
		await redline(t, e, nc.id);
		await redline(t, e, nc.id);
		await t.complete(e.id, '1');
		await t.disposition(nc.id);
		const rs = await t.ok('GET', `/executions/${e.id}/redlines`);
		expect(rs.every((r: any) => r.releasedAt !== null)).toBe(true);
		expect((await t.doc(e.id)).ops[1].redline.releasedBy).not.toBeNull();
		expect((await t.complete(e.id, '2')).json.message).toContain('Waiting on redline op 2R1, 2R2');
		expect((await t.complete(e.id, '2R1.1')).status).toBe(200);
	});

	test('a draft is rewritten in place until it is released', async () => {
		const t = await setup();
		const { e, nc } = await withNc(t, ['A', 'B']);
		const r = (await redline(t, e, nc.id, [{ title: 'one' }])).json;
		const put = await t.ok('PUT', `/executions/${e.id}/redlines/${r.id}`, {
			title: 'Rework bracket',
			steps: [{ title: 'Grind' }, { title: 'Inspect' }]
		});
		expect(put.title).toBe('Rework bracket');
		expect(put.steps.map((s: any) => s.number)).toEqual(['2R1.1', '2R1.2']);
		await t.disposition(nc.id);
		const refused = await t.call('PUT', `/executions/${e.id}/redlines/${r.id}`, { title: 'Late', steps: [{ title: 'x' }] });
		expect(refused.status).toBe(409);
	});

	test('a draft written after the disposition is released on its own, by a person', async () => {
		const t = await setup();
		const { e, nc } = await withNc(t, ['A', 'B']);
		await t.disposition(nc.id);
		const r = (await redline(t, e, nc.id)).json;
		expect(r.releasedAt).toBeNull();
		expect((await t.doc(e.id)).ops[1].redline.canRelease).toBe(true);
		expect((await t.call('POST', `/executions/${e.id}/redlines/${r.id}/release`, {}, t.token)).status).toBe(403);
		const released = await t.ok('POST', `/executions/${e.id}/redlines/${r.id}/release`, {});
		expect(released.releasedAt).not.toBeNull();
		expect((await t.call('POST', `/executions/${e.id}/redlines/${r.id}/release`, {})).status).toBe(409);
		expect((await t.complete(e.id, '2R1.1')).status).toBe(200);
	});

	test('a draft is not released on its own before the disposition is signed', async () => {
		const t = await setup();
		const { e, nc } = await withNc(t, ['A', 'B']);
		const r = (await redline(t, e, nc.id)).json;
		const refused = await t.call('POST', `/executions/${e.id}/redlines/${r.id}/release`, {});
		expect(refused.status).toBe(409);
		expect(refused.json.message).toContain('signing it releases 2R1');
	});

	test('a released redline replaces a planned kit line: the line reads struck and its own kit is expected', async () => {
		const t = await setup();
		const old = await t.bulk('O-ring 2-230');
		const neu = await t.bulk('O-ring 2-238');
		const p = await t.proc('Kit proc');
		await t.step(p.id, 'A');
		const b = await t.step(p.id, 'B');
		await t.ok('POST', `/procedures/${p.id}/steps/${b.id}/kit`, { partId: old.id, quantity: '5', usage: 'consume' });
		await t.ok('POST', `/procedures/${p.id}/publish`, {});
		const e = await t.cut(p.id);
		const nc = (await t.nc(e.id, '2')).json;
		const host = await t.stepOf(e.id, '2');
		const lot = await t.stock(old.id, '10');
		await t.ok('POST', `/executions/${e.id}/steps/${host}/consume`, { items: [{ stockId: lot.id, quantity: '3', usage: 'consume' }] });
		const strikes = [{ stepId: host, partId: old.id }];
		const wrong = await t.call('POST', `/executions/${e.id}/redlines`, {
			issueId: nc.id,
			title: 'Swap',
			steps: [{ title: 'x' }],
			strikes: [{ stepId: host, partId: neu.id }]
		});
		expect(wrong.status).toBe(422);
		await t.ok('POST', `/executions/${e.id}/redlines`, {
			issueId: nc.id,
			title: 'Swap O-rings',
			steps: [{ title: 'Install 2-238', kit: [{ partId: neu.id, quantity: '4' }] }],
			strikes
		});
		// While a draft, the plan does not change.
		let d = await t.doc(e.id);
		expect(d.kit.struck).toEqual([]);
		expect(d.kit.items.map((k: any) => k.partId)).toEqual([old.id]);
		await t.disposition(nc.id);
		d = await t.doc(e.id);
		expect(d.kit.struck).toEqual([
			expect.objectContaining({ partId: old.id, quantity: '5', qtyConsumed: '3', stepNumber: '2', redline: '2R1' })
		]);
		expect(d.kit.items).toEqual([expect.objectContaining({ partId: neu.id, qtyRequired: '4', qtyConsumed: '0', addedBy: '2R1' })]);
		expect(d.kit.unplanned).toEqual([]);
		const hostOp = d.ops.find((o: any) => o.number === '2');
		expect(hostOp.step.stepKit[0]).toMatchObject({ partId: old.id, struckBy: '2R1' });
		expect(d.ops[1].redline.strikes[0]).toMatchObject({ partId: old.id, stepNumber: '2', quantity: '5' });
		expect(d.ops[1].steps[0].stepKit[0]).toMatchObject({ partId: neu.id, quantity: '4', struckBy: null });
		// A line is replaced once.
		const again = await t.call('POST', `/executions/${e.id}/redlines`, { issueId: nc.id, title: 'Again', steps: [{ title: 'x' }], strikes });
		expect(again.status).toBe(422);
		expect(again.json.message).toContain('already replaced by 2R1');
	});

	test('an issue waits on its open redlines before review', async () => {
		const t = await setup();
		const { e, nc } = await withNc(t, ['A', 'B']);
		await redline(t, e, nc.id);
		await t.disposition(nc.id);
		const early = await t.call('POST', `/issues/${nc.id}/review`, {});
		expect(early.status).toBe(409);
		expect(early.json.message).toContain('waits on redline 2R1');
		await t.complete(e.id, '2R1.1');
		expect((await t.call('POST', `/issues/${nc.id}/review`, {})).status).toBe(200);
		const i = await t.ok('GET', `/issues/${nc.id}`);
		expect(i.redlineOps[0]).toMatchObject({ label: '2R1', released: true, doneBy: expect.any(String) });
	});

	test('deleting an unworked redline writes an audit delete row for each step execution', async () => {
		const t = await setup();
		const { e, nc } = await withNc(t, ['A', 'B']);
		const r = (await redline(t, e, nc.id, [{ title: 'one' }, { title: 'two' }])).json;
		await t.ok('DELETE', `/executions/${e.id}/redlines/${r.id}`);
		const audit = await t.ok('GET', '/audit?entity=step_execution');
		expect(audit.items.filter((i: any) => i.action === 'delete')).toHaveLength(3);
	});

	test('the issue detail lists the redline ops of its execution', async () => {
		const t = await setup();
		const { e, nc } = await withNc(t, ['A', 'B']);
		await redline(t, e, nc.id);
		const issue = await t.ok('GET', `/issues/${nc.id}`);
		expect(issue.redlineOps.map((r: any) => r.label)).toEqual(['2R1']);
		expect(issue.raisedOpOrder).toBe(await t.stepOf(e.id, '2'));
	});
});
