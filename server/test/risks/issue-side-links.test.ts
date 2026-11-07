import { describe, expect, test } from 'bun:test';
import { setup } from './helpers.ts';

type T = Awaited<ReturnType<typeof setup>>;

async function acceptable(t: T) {
	const r = await t.mk();
	expect((await t.call('PATCH', `/risks/${r.id}`, { acceptanceRationale: 'Within appetite' })).status).toBe(200);
	return r;
}

describe('a risk link obeys the risk from the issue side too', () => {
	test('an issue cannot add a line to a realized or closed risk, by link or at raise', async () => {
		const t = await setup();
		const realized = await t.mk();
		const happened = await t.mkIssue('It happened');
		expect((await t.call('POST', `/risks/${realized.id}/disposition`, { disposition: 'realized', realizedIssueId: happened.id })).status).toBe(200);
		const closed = await t.mk();
		expect((await t.call('POST', `/risks/${closed.id}/disposition`, { disposition: 'closed', note: 'gone' })).status).toBe(200);
		const i = await t.mkIssue('Late');
		for (const r of [realized, closed]) {
			const link = await t.call('POST', `/issues/${i.id}/links`, { kind: 'risk', targetId: r.id });
			expect(link.status).toBe(409);
			expect(link.body.error).toBe('risk_state');
			const raised = await t.call('POST', '/issues', { title: 'Raised with a line', links: [{ kind: 'risk', targetId: r.id }] });
			expect(raised.status).toBe(409);
			expect(raised.body.error).toBe('risk_state');
		}
		expect((await t.call('GET', `/risks/${closed.id}`)).body.linkedIssues).toHaveLength(0);
		// The refused raise left nothing behind.
		expect((await t.call('GET', '/issues')).body.items.map((x: { title: string }) => x.title)).not.toContain('Raised with a line');
	});

	test('an issue cannot remove a line from an accepted or closed risk', async () => {
		const t = await setup();
		const r = await acceptable(t);
		const i = await t.mkIssue('Evidence');
		expect((await t.call('POST', `/risks/${r.id}/issues`, { issueId: i.id, role: 'research' })).status).toBe(200);
		const linkId = (await t.call('GET', `/issues/${i.id}`)).body.links.find((l: { kind: string }) => l.kind === 'risk').id;
		expect((await t.call('POST', `/risks/${r.id}/accept`, {})).status).toBe(200);

		const refused = await t.call('DELETE', `/issues/${i.id}/links/${linkId}`);
		expect(refused.status).toBe(409);
		expect(refused.body.error).toBe('risk_state');
		expect((await t.call('GET', `/risks/${r.id}`)).body.linkedIssues).toHaveLength(1);

		expect((await t.call('POST', `/risks/${r.id}/disposition`, { disposition: 'closed', note: 'gone' })).status).toBe(200);
		expect((await t.call('DELETE', `/issues/${i.id}/links/${linkId}`)).status).toBe(409);
		expect((await t.call('GET', `/risks/${r.id}`)).body.linkedIssues).toHaveLength(1);
	});

	test('an open risk takes a line from a pending issue and gives it back, and an accepted risk only takes one', async () => {
		const t = await setup();
		const open = await t.mk();
		const i = await t.mkIssue('Evidence');
		const link = await t.call('POST', `/issues/${i.id}/links`, { kind: 'risk', targetId: open.id });
		expect(link.status).toBe(200);
		expect((await t.call('DELETE', `/issues/${i.id}/links/${link.body.id}`)).status).toBe(200);

		const held = await acceptable(t);
		expect((await t.call('POST', `/risks/${held.id}/accept`, {})).status).toBe(200);
		const added = await t.call('POST', `/issues/${i.id}/links`, { kind: 'risk', targetId: held.id });
		expect(added.status).toBe(200);
		expect((await t.call('DELETE', `/issues/${i.id}/links/${added.body.id}`)).status).toBe(409);
	});
});
