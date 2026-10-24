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
		await t.sign(e.id, '2R1.1', 1);
		expect((await t.doc(e.id)).ops[1].step.status).toBe('completed');
	});

	test('a redline can be deleted only while nothing in it started', async () => {
		const t = await setup();
		const { e, nc } = await withNc(t, ['A', 'B']);
		const a = (await redline(t, e, nc.id, [{ title: 'one' }, { title: 'two' }])).json;
		await t.ok('DELETE', `/executions/${e.id}/redlines/${a.id}`);
		expect(await t.ok('GET', `/executions/${e.id}/redlines`)).toEqual([]);
		expect((await t.get(e.id)).steps.map((s: any) => s.number)).toEqual(['1', '2']);
		const b = (await redline(t, e, nc.id)).json;
		await t.disposition(nc.id);
		await t.complete(e.id, '2R1.1');
		const refused = await t.call('DELETE', `/executions/${e.id}/redlines/${b.id}`);
		expect(refused.status).toBe(409);
		expect((await t.call('DELETE', `/executions/${e.id}/redlines/9999`)).status).toBe(404);
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
