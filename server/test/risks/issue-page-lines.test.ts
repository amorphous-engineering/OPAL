import { describe, expect, test } from 'bun:test';
import { setup } from './helpers.ts';

type T = Awaited<ReturnType<typeof setup>>;

async function acceptable(t: T) {
	const r = await t.mk();
	expect((await t.call('PATCH', `/risks/${r.id}`, { acceptanceRationale: 'Within appetite' })).status).toBe(200);
	return r;
}

describe('the issue page is told which risk lines can be removed', () => {
	test('a line of an open risk can be unlinked, and one of an accepted, realized or closed risk cannot', async () => {
		const t = await setup();
		const r = await acceptable(t);
		const i = await t.mkIssue('Evidence');
		expect((await t.call('POST', `/risks/${r.id}/issues`, { issueId: i.id, role: 'research' })).status).toBe(200);
		const shown = async () => (await t.call('GET', `/issues/${i.id}`)).body.risks;

		expect((await shown())[0]).toMatchObject({ riskId: r.id, relation: 'research', canUnlink: true });
		expect((await t.call('POST', `/risks/${r.id}/accept`, {})).status).toBe(200);
		expect((await shown())[0].canUnlink).toBe(false);
		expect((await t.call('POST', `/risks/${r.id}/disposition`, { disposition: 'closed', note: 'gone' })).status).toBe(200);
		expect((await shown())[0].canUnlink).toBe(false);
	});

	test('the realized pointer is not a line anyone can unlink', async () => {
		const t = await setup();
		const r = await t.mk();
		const i = await t.mkIssue('It happened');
		expect((await t.call('POST', `/risks/${r.id}/disposition`, { disposition: 'realized', realizedIssueId: i.id })).status).toBe(200);
		expect((await t.call('GET', `/issues/${i.id}`)).body.risks).toEqual([expect.objectContaining({ relation: 'realized', canUnlink: false })]);
	});

	test('the list of live risks holds every risk that takes a line and no other', async () => {
		const t = await setup();
		const open = await t.mk();
		const held = await acceptable(t);
		expect((await t.call('POST', `/risks/${held.id}/accept`, {})).status).toBe(200);
		const closed = await t.mk();
		expect((await t.call('POST', `/risks/${closed.id}/disposition`, { disposition: 'closed', note: 'gone' })).status).toBe(200);
		const realized = await t.mk();
		const happened = await t.mkIssue('It happened');
		expect((await t.call('POST', `/risks/${realized.id}/disposition`, { disposition: 'realized', realizedIssueId: happened.id })).status).toBe(200);

		const listed = (await t.call('GET', '/risks?active=1')).body.items.map((x: { id: number }) => x.id);
		expect(listed.sort()).toEqual([open.id, held.id].sort());
		const i = await t.mkIssue('Evidence');
		for (const r of [open, held]) expect((await t.call('POST', `/issues/${i.id}/links`, { kind: 'risk', targetId: r.id })).status).toBe(200);
	});
});
