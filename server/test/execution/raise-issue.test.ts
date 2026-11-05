import { describe, expect, test } from 'bun:test';
import { flushEvents, subscribe } from '../../src/services/platform/index.ts';
import { setup } from './helpers.ts';

/** The body the issue form sends for a person who typed only a title. */
const titleOnly = (t: Awaited<ReturnType<typeof setup>>, executionId: number, stepId: number, extra: Record<string, unknown> = {}) => ({
	projectId: t.proj.id,
	title: 'Bracket cracked',
	issueType: 'non_conformance',
	containment: 'step',
	executionId,
	raisedStepId: stepId,
	containmentStepId: stepId,
	...extra
});

async function eventsDuring(fn: () => Promise<void>) {
	const seen: { type: string; data: Record<string, unknown> }[] = [];
	const stop = subscribe(null, (e) => seen.push(e));
	await fn();
	await flushEvents();
	stop();
	return seen;
}

describe('raising an issue from a step', () => {
	test('a title is all it takes, and the run, step and person are carried', async () => {
		const t = await setup();
		const e = await t.cut(await t.published(['A', 'B']));
		const sid = await t.stepOf(e.id, '1');
		const issue = (await t.call('POST', '/issues', titleOnly(t, e.id, sid), t.benActor)).json;
		expect(issue).toMatchObject({ title: 'Bracket cracked', executionId: e.id, raisedStepId: sid });
		expect(issue.raisedBy.id).toBe(t.ben.id);
	});

	test('an issue raised at a step holds that step on the work order page', async () => {
		const t = await setup();
		const e = await t.cut(await t.published(['A', 'B']));
		const sid = await t.stepOf(e.id, '1');
		await t.ok('POST', '/issues', titleOnly(t, e.id, sid));
		const d = await t.doc(e.id);
		expect(d.holds).toHaveLength(1);
		expect(d.ops[0].step.holds).toHaveLength(1);
		expect(d.ops[0].step.signoffs[0].canSign).toBe(false);
	});

	test('raising an issue tells every open view of the work order to look again', async () => {
		const t = await setup();
		const e = await t.cut(await t.published(['A', 'B']));
		const sid = await t.stepOf(e.id, '1');
		const seen = await eventsDuring(async () => {
			await t.ok('POST', '/issues', titleOnly(t, e.id, sid));
		});
		expect(seen.some((x) => x.type === 'execution_issues_changed' && x.data.executionId === e.id)).toBe(true);
	});

	test('an advisory issue holds nothing but still changes what the light poll reports', async () => {
		const t = await setup();
		const e = await t.cut(await t.published(['A', 'B']));
		const sid = await t.stepOf(e.id, '1');
		expect((await t.ok('GET', `/executions/${e.id}/state`)).issueCount).toBe(0);
		const seen = await eventsDuring(async () => {
			await t.ok('POST', '/issues', titleOnly(t, e.id, sid, { containment: 'advisory', containmentStepId: null }));
		});
		const state = await t.ok('GET', `/executions/${e.id}/state`);
		expect(state.issueCount).toBe(1);
		expect(state.holds).toEqual([]);
		expect(seen.some((x) => x.type === 'execution_issues_changed' && x.data.executionId === e.id)).toBe(true);
	});

	test('striking a work order tells every open view of it', async () => {
		const t = await setup();
		const e = await t.cut(await t.published(['A']));
		const seen = await eventsDuring(async () => {
			await t.ok('POST', `/executions/${e.id}/void`, { reason: 'wrong template' });
		});
		expect(seen.some((x) => x.type === 'instance_closed' && x.data.executionId === e.id)).toBe(true);
	});
});
