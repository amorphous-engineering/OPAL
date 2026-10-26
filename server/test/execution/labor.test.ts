import { describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { workInterval } from '../../src/db/schema/index.ts';
import { setup } from './helpers.ts';

/** Move every open clock-in back by `seconds`, as if it started earlier. */
function backdate(t: Awaited<ReturnType<typeof setup>>, seconds: number) {
	for (const r of t.db.select().from(workInterval).all()) {
		if (r.endedAt) continue;
		const startedAt = new Date(Date.parse(r.startedAt) - seconds * 1000).toISOString();
		t.db.update(workInterval).set({ startedAt }).where(eq(workInterval.id, r.id)).run();
	}
}

async function started(t: Awaited<ReturnType<typeof setup>>) {
	const e = await t.cut(await t.published(['A', 'B']));
	return { e, a: await t.stepOf(e.id, '1'), b: await t.stepOf(e.id, '2') };
}

describe('time worked on an OP', () => {
	test('a claim clocks in; the open clock-in shows its start and no counted time', async () => {
		const t = await setup();
		const { e, a } = await started(t);
		await t.ok('POST', `/executions/${e.id}/focus`, { stepId: a });
		const [row] = (await t.doc(e.id)).labor;
		expect(row).toMatchObject({ opId: a, seconds: 0 });
		expect(row.since).toBeTruthy();
	});

	test('clocking out counts the time from clock-in to clock-out', async () => {
		const t = await setup();
		const { e, a } = await started(t);
		await t.ok('POST', `/executions/${e.id}/focus`, { stepId: a });
		backdate(t, 3600);
		await t.ok('DELETE', `/executions/${e.id}/focus`);
		const [row] = (await t.doc(e.id)).labor;
		expect(row.since).toBeNull();
		expect(row.seconds).toBeGreaterThanOrEqual(3600);
		expect(row.seconds).toBeLessThan(3610);
	});

	test('claiming another OP ends the first clock-in; claiming the same OP again does not', async () => {
		const t = await setup();
		const { e, a, b } = await started(t);
		await t.ok('POST', `/executions/${e.id}/focus`, { stepId: a });
		await t.ok('POST', `/executions/${e.id}/focus`, { stepId: a });
		expect(t.db.select().from(workInterval).all()).toHaveLength(1);
		backdate(t, 600);
		await t.ok('POST', `/executions/${e.id}/focus`, { stepId: b });
		const labor = (await t.doc(e.id)).labor;
		expect(labor.find((r: any) => r.opId === a)).toMatchObject({ since: null });
		expect(labor.find((r: any) => r.opId === a).seconds).toBeGreaterThanOrEqual(600);
		expect(labor.find((r: any) => r.opId === b).since).toBeTruthy();
	});

	test('a finished OP ends an open clock-in at its finish time', async () => {
		const t = await setup();
		const { e, a } = await started(t);
		await t.ok('POST', `/executions/${e.id}/focus`, { stepId: a });
		backdate(t, 7200);
		expect((await t.complete(e.id, '1')).status).toBe(200);
		const [row] = (await t.doc(e.id)).labor;
		expect(row.since).toBeNull();
		expect(row.seconds).toBeGreaterThanOrEqual(7200);
		expect(row.seconds).toBeLessThan(7210);
	});

	test('each person on an OP has a row, in the document and the state poll', async () => {
		const t = await setup();
		const { e, a } = await started(t);
		await t.ok('POST', `/executions/${e.id}/focus`, { stepId: a });
		await t.call('POST', `/executions/${e.id}/focus`, { stepId: a }, t.benActor);
		expect((await t.doc(e.id)).labor.map((r: any) => r.userId).sort()).toHaveLength(2);
		const state = await t.ok('GET', `/executions/${e.id}/state`);
		expect(state.labor.map((r: any) => r.name)).toContain('BEN');
	});
});
