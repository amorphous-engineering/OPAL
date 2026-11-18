import { describe, expect, test } from 'bun:test';
import { setup } from '../execution/helpers.ts';

/** An advisory non-conformance with a signed disposition and corrective action text, in work. */
async function inWork(t: Awaited<ReturnType<typeof setup>>) {
	const nc = await t.ok('POST', '/issues', { title: 'Callout wrong', issueType: 'non_conformance', projectId: t.proj.id });
	await t.ok('POST', `/issues/${nc.id}/disposition`, { dispositionType: 'rework', dispositionRationale: 'Rework to the kit' });
	await t.ok('PATCH', `/issues/${nc.id}`, { correctiveAction: 'Callout corrected' });
	return nc;
}

describe('a procedure revision as corrective action', () => {
	test('names the next version after the one released when it was linked', async () => {
		const t = await setup();
		const p = await t.published(['A']);
		const nc = await inWork(t);
		const linked = await t.ok('PATCH', `/issues/${nc.id}`, { correctiveProcedureId: p });
		expect(linked.correctiveRevision).toMatchObject({ procedureId: p, versionNumber: 2, released: false });
		const cleared = await t.ok('PATCH', `/issues/${nc.id}`, { correctiveProcedureId: null });
		expect(cleared.correctiveRevision).toBeNull();
	});

	test('holds the sign-off until that version is released', async () => {
		const t = await setup();
		const p = await t.published(['A']);
		const nc = await inWork(t);
		await t.ok('PATCH', `/issues/${nc.id}`, { correctiveProcedureId: p });
		await t.ok('POST', `/issues/${nc.id}/review`, {});
		const held = await t.call('POST', `/issues/${nc.id}/signoff`, {});
		expect(held.status).toBe(409);
		expect(held.json.message).toMatch(/waits on the release of T-\d+ v2/);
		await t.ok('POST', `/procedures/${p}/publish`, {});
		expect((await t.ok('GET', `/issues/${nc.id}`)).correctiveRevision.released).toBe(true);
		expect((await t.call('POST', `/issues/${nc.id}/signoff`, {})).status).toBe(200);
	});

	test('an unknown procedure is refused', async () => {
		const t = await setup();
		const nc = await inWork(t);
		expect((await t.call('PATCH', `/issues/${nc.id}`, { correctiveProcedureId: 9999 })).status).toBe(422);
	});
});
