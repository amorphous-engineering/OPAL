import { describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { risk } from '../../src/db/schema/index.ts';
import { createTestProject } from '../helpers/project.ts'; // added by projects
import { setup } from './helpers.ts';

/** A risk that can be accepted: complete scenario, owner, rationale. */
async function ready(t: Awaited<ReturnType<typeof setup>>, body: Record<string, unknown> = {}) {
	const r = await t.mk({ acceptanceRationale: undefined, ...body });
	const p = await t.call('PATCH', `/risks/${r.id}`, { acceptanceRationale: 'Within appetite' });
	expect(p.status).toBe(200);
	return p.body;
}

describe('creating and reading risks', () => {
	test('a new risk gets RISK-00001, disposition open, and the default score 3 x 3', async () => {
		const t = await setup();
		const r = await t.mk();
		expect(r.riskNumber).toBe('RISK-00001');
		expect(r.disposition).toBe('open');
		expect(r.score).toBe(9);
		expect(r.severity).toBe('medium');
		expect((await t.mk()).riskNumber).toBe('RISK-00002');
	});

	test('an incomplete scenario has no statement', async () => {
		const t = await setup();
		const r = await t.mk({ consequence: null });
		expect(r.statement).toBeNull();
	});

	test('a complete scenario generates the NASA-format statement', async () => {
		const t = await setup();
		const r = await t.mk();
		expect(r.statement).toBe(
			'Given that The valve seat is scored, there is a possibility of Helium leaks past the seat during fill adversely impacting test campaign, thereby leading to Loss of two test days.'
		);
	});

	test('a part asset shows as "name (PN)" and carries the part number', async () => {
		const t = await setup();
		const p = t.mkPart('Valve', 'OPAL-00001');
		const r = await t.mk({ assetText: null, assetPartId: p.id });
		expect(r.assetDisplay).toBe('Valve (OPAL-00001)');
		expect(r.assetPartNumber).toBe('OPAL-00001');
	});

	test('both asset forms on create is refused', async () => {
		const t = await setup();
		const p = t.mkPart('Valve', 'OPAL-00001');
		const r = await t.call('POST', '/risks', { title: 'x', assetPartId: p.id, assetText: 'sched' });
		expect(r.status).toBe(422);
	});

	test('both asset forms set in the database makes the scenario incomplete', async () => {
		const t = await setup();
		const r = await t.mk();
		const p = t.mkPart('Valve', 'OPAL-00001');
		// The CHECK forbids both forms, so exclusivity holds in storage too.
		expect(() =>
			t.db.update(risk).set({ assetPartId: p.id }).where(eq(risk.id, r.id)).run()
		).toThrow();
	});

	test('an unknown owner or asset part is a 404, not a crash', async () => {
		const t = await setup();
		expect((await t.call('POST', '/risks', { title: 'x', ownerId: 999 })).status).toBe(404);
		expect((await t.call('POST', '/risks', { title: 'x', assetPartId: 999 })).status).toBe(404);
	});

	test('out-of-range scores are refused', async () => {
		const t = await setup();
		expect((await t.call('POST', '/risks', { title: 'x', probability: 6 })).status).toBe(422);
		expect((await t.call('POST', '/risks', { title: 'x', impact: 0 })).status).toBe(422);
	});

	test('a partial update leaves other fields alone and explicit null clears', async () => {
		const t = await setup();
		const r = await t.mk({ description: 'narrative' });
		const u = await t.call('PATCH', `/risks/${r.id}`, { probability: 5, description: null });
		expect(u.body.probability).toBe(5);
		expect(u.body.description).toBeNull();
		expect(u.body.title).toBe('Valve leak');
	});

	test('clearing probability or title is refused', async () => {
		const t = await setup();
		const r = await t.mk();
		expect((await t.call('PATCH', `/risks/${r.id}`, { probability: null })).status).toBe(422);
		expect((await t.call('PATCH', `/risks/${r.id}`, { title: null })).status).toBe(422);
	});

	test('setting one asset form clears the other', async () => {
		const t = await setup();
		const p = t.mkPart('Valve', 'OPAL-00001');
		const r = await t.mk();
		const u = await t.call('PATCH', `/risks/${r.id}`, { assetPartId: p.id });
		expect(u.body.assetPartId).toBe(p.id);
		expect(u.body.assetText).toBeNull();
		const v = await t.call('PATCH', `/risks/${r.id}`, { assetText: 'schedule' });
		expect(v.body.assetPartId).toBeNull();
		expect(v.body.assetText).toBe('schedule');
	});
});

describe('lists, filters and the matrix', () => {
	test('the default order is highest score first', async () => {
		const t = await setup();
		await t.mk({ title: 'low', probability: 1, impact: 1 });
		await t.mk({ title: 'high', probability: 5, impact: 5 });
		const l = await t.call('GET', '/risks');
		expect(l.body.items.map((r: any) => r.title)).toEqual(['high', 'low']);
		expect(l.body.total).toBe(2);
	});

	test('the severity filter applies before paging', async () => {
		const t = await setup();
		for (let i = 0; i < 3; i++) await t.mk({ probability: 5, impact: 5 });
		for (let i = 0; i < 3; i++) await t.mk({ probability: 1, impact: 1 });
		const page1 = await t.call('GET', '/risks?severity=high&limit=2');
		expect(page1.body.items).toHaveLength(2);
		expect(page1.body.total).toBe(3);
		const page2 = await t.call('GET', `/risks?severity=high&limit=2&cursor=${page1.body.next}`);
		expect(page2.body.items).toHaveLength(1);
		expect(page2.body.next).toBeNull();
	});

	test('filters by disposition, owner, matrix cell, minimum score and search', async () => {
		const t = await setup();
		await t.mk({ title: 'alpha', probability: 2, impact: 4, ownerId: t.other.id });
		await t.mk({ title: 'beta', probability: 3, impact: 3 });
		expect((await t.call('GET', '/risks?probability=2&impact=4')).body.total).toBe(1);
		expect((await t.call('GET', `/risks?ownerId=${t.other.id}`)).body.items[0].title).toBe('alpha');
		expect((await t.call('GET', '/risks?minScore=9')).body.total).toBe(1);
		expect((await t.call('GET', '/risks?q=RISK-00002')).body.items[0].title).toBe('beta');
		expect((await t.call('GET', '/risks?disposition=watch')).body.total).toBe(0);
	});

	test('active keeps live exposure only: closed and realized drop out', async () => {
		const t = await setup();
		const a = await t.mk();
		await t.mk();
		await t.call('POST', `/risks/${a.id}/disposition`, { disposition: 'closed', note: 'gone' });
		expect((await t.call('GET', '/risks?active=1')).body.total).toBe(1);
		expect((await t.call('GET', '/risks?active=true')).body.total).toBe(1);
		expect((await t.call('GET', '/risks')).body.total).toBe(2);
	});

	test('sorting by residual score puts risks without one last', async () => {
		const t = await setup();
		await t.mk({ title: 'none' });
		await t.mk({ title: 'r4', residualProbability: 2, residualImpact: 2 });
		await t.mk({ title: 'r9', residualProbability: 3, residualImpact: 3 });
		const asc = await t.call('GET', '/risks?sort=residualScore&dir=asc');
		expect(asc.body.items.map((r: any) => r.title)).toEqual(['r4', 'r9', 'none']);
		const desc = await t.call('GET', '/risks?sort=residualScore&dir=desc');
		expect(desc.body.items.map((r: any) => r.title)).toEqual(['r9', 'r4', 'none']);
	});

	test('an unknown sort key is refused', async () => {
		const t = await setup();
		expect((await t.call('GET', '/risks?sort=bogus')).status).toBe(422);
	});

	test('the matrix counts live risks, current and residual, and skips closed ones', async () => {
		const t = await setup();
		await t.mk({ probability: 2, impact: 3, residualProbability: 1, residualImpact: 1 });
		await t.mk({ probability: 2, impact: 3 });
		const c = await t.mk({ probability: 5, impact: 5 });
		await t.call('POST', `/risks/${c.id}/disposition`, { disposition: 'closed', note: 'done' });
		const m = (await t.call('GET', '/risks/matrix')).body;
		expect(m.matrix[1][2]).toBe(2);
		expect(m.matrix[4][4]).toBe(0);
		expect(m.residualMatrix[0][0]).toBe(1);
		expect(m.totalRisks).toBe(2);
		expect(m.labels.probability).toHaveLength(5);
	});
});

describe('dispositions', () => {
	test('mitigate is refused without an open mitigation issue and a residual score, naming both', async () => {
		const t = await setup();
		const r = await t.mk();
		const x = await t.call('POST', `/risks/${r.id}/disposition`, { disposition: 'mitigate' });
		expect(x.status).toBe(409);
		expect(x.body.message).toContain('open linked issue');
		expect(x.body.message).toContain('residual score');
	});

	test('mitigate is refused when the only mitigation issue is closed', async () => {
		const t = await setup();
		const r = await t.mk({ residualProbability: 1, residualImpact: 1 });
		const i = await t.mkIssue();
		await t.call('POST', `/risks/${r.id}/issues`, { issueId: i.id, role: 'mitigation' });
		await t.call('PATCH', `/issues/${i.id}`, { status: 'closed' });
		const x = await t.call('POST', `/risks/${r.id}/disposition`, { disposition: 'mitigate' });
		expect(x.status).toBe(409);
	});

	test('mitigate is allowed with an open mitigation issue and a residual score', async () => {
		const t = await setup();
		const r = await t.mk({ residualProbability: 1, residualImpact: 2 });
		const i = await t.mkIssue();
		await t.call('POST', `/risks/${r.id}/issues`, { issueId: i.id, role: 'mitigation' });
		const x = await t.call('POST', `/risks/${r.id}/disposition`, { disposition: 'mitigate' });
		expect(x.status).toBe(200);
		expect(x.body.disposition).toBe('mitigate');
	});

	test('watch needs an observable and a threshold', async () => {
		const t = await setup();
		const r = await t.mk();
		const x = await t.call('POST', `/risks/${r.id}/disposition`, { disposition: 'watch' });
		expect(x.status).toBe(409);
		expect(x.body.message).toContain('observable');
		expect(x.body.message).toContain('threshold');
		await t.call('PATCH', `/risks/${r.id}`, { watchObservable: 'seat temp', watchThreshold: '> 40C' });
		const ok = await t.call('POST', `/risks/${r.id}/disposition`, { disposition: 'watch' });
		expect(ok.body.disposition).toBe('watch');
	});

	test('research needs a research issue or a narrative', async () => {
		const t = await setup();
		const r = await t.mk();
		expect(
			(await t.call('POST', `/risks/${r.id}/disposition`, { disposition: 'research' })).status
		).toBe(409);
		const i = await t.mkIssue();
		await t.call('POST', `/risks/${r.id}/issues`, { issueId: i.id, role: 'research' });
		expect(
			(await t.call('POST', `/risks/${r.id}/disposition`, { disposition: 'research' })).status
		).toBe(200);
		const s = await t.mk({ description: 'we need data' });
		expect(
			(await t.call('POST', `/risks/${s.id}/disposition`, { disposition: 'research' })).status
		).toBe(200);
	});

	test('closing needs a note', async () => {
		const t = await setup();
		const r = await t.mk();
		expect(
			(await t.call('POST', `/risks/${r.id}/disposition`, { disposition: 'closed' })).status
		).toBe(409);
		const ok = await t.call('POST', `/risks/${r.id}/disposition`, {
			disposition: 'closed',
			note: 'no longer applies'
		});
		expect(ok.body.disposition).toBe('closed');
	});

	test('a change to the current disposition is refused', async () => {
		const t = await setup();
		const r = await t.mk();
		const x = await t.call('POST', `/risks/${r.id}/disposition`, { disposition: 'open' });
		expect(x.status).toBe(409);
		expect(x.body.message).toContain('already open');
	});

	test('accepted is unreachable through setDisposition', async () => {
		const t = await setup();
		const r = await t.mk();
		const x = await t.call('POST', `/risks/${r.id}/disposition`, { disposition: 'accepted' });
		expect(x.status).toBe(409);
		expect(x.body.message).toContain('accept action');
	});

	test('realized needs a linked issue, accepts one in the same call, and is terminal', async () => {
		const t = await setup();
		const r = await t.mk();
		const none = await t.call('POST', `/risks/${r.id}/disposition`, { disposition: 'realized' });
		expect(none.status).toBe(409);
		const i = await t.mkIssue('It happened');
		const ok = await t.call('POST', `/risks/${r.id}/disposition`, {
			disposition: 'realized',
			realizedIssueId: i.id
		});
		expect(ok.body.disposition).toBe('realized');
		expect(ok.body.realizedIssueNumber).toBe(i.issueNumber);
		const again = await t.call('POST', `/risks/${r.id}/disposition`, { disposition: 'open' });
		expect(again.status).toBe(409);
		expect(again.body.message).toContain('terminal');
	});

	test('an unknown realized issue is a 404 and changes nothing', async () => {
		const t = await setup();
		const r = await t.mk();
		const x = await t.call('POST', `/risks/${r.id}/disposition`, {
			disposition: 'realized',
			realizedIssueId: 999
		});
		expect(x.status).toBe(404);
	});

	test('the disposition check lists blockers and counts open response issues', async () => {
		const t = await setup();
		const r = await t.mk();
		const i = await t.mkIssue();
		await t.call('POST', `/risks/${r.id}/issues`, { issueId: i.id, role: 'mitigation' });
		const c = (await t.call('GET', `/risks/${r.id}/disposition-check?target=mitigate`)).body;
		expect(c.openMitigations).toBe(1);
		expect(c.openResearch).toBe(0);
		expect(c.blockers.join()).toContain('residual');
		expect(c.needsNote).toBe(false);
		expect((await t.call('GET', `/risks/${r.id}/disposition-check?target=closed`)).body.needsNote).toBe(true);
	});
});

describe('acceptance', () => {
	test('readiness lists five hard checks and flips with each field', async () => {
		const t = await setup();
		const r = await t.mk({ ownerId: null, consequence: null });
		const rd = (await t.call('GET', `/risks/${r.id}/readiness`)).body;
		expect(rd.ready).toBe(false);
		expect(rd.checks.map((c: any) => c.key)).toEqual([
			'scenario_complete',
			'owner_assigned',
			'scored',
			'rationale_recorded',
			'lint_clean'
		]);
		const by = (k: string) => rd.checks.find((c: any) => c.key === k);
		expect(by('scenario_complete').detail).toBe('missing: consequence');
		expect(by('owner_assigned').passed).toBe(false);
		expect(by('rationale_recorded').passed).toBe(false);
		expect(by('lint_clean').passed).toBe(true);
	});

	test('readiness fails lint_clean when the condition speculates', async () => {
		const t = await setup();
		const r = await t.mk({ condition: 'The seat may be scored' });
		const rd = (await t.call('GET', `/risks/${r.id}/readiness`)).body;
		expect(rd.checks.find((c: any) => c.key === 'lint_clean').passed).toBe(false);
	});

	test('accept is refused with a 409 naming every failing check', async () => {
		const t = await setup();
		const r = await t.mk({ ownerId: null });
		const x = await t.call('POST', `/risks/${r.id}/accept`, {});
		expect(x.status).toBe(409);
		expect(x.body.message).toContain('exactly one owner');
		expect(x.body.message).toContain('acceptance rationale');
	});

	test('accept signs the risk with the session user and the time', async () => {
		const t = await setup();
		const r = await ready(t);
		const x = await t.call('POST', `/risks/${r.id}/accept`, {});
		expect(x.status).toBe(200);
		expect(x.body.disposition).toBe('accepted');
		expect(x.body.acceptedByName).toBe('ABBY');
		expect(x.body.acceptedAt).toBeTruthy();
	});

	test('the rationale can arrive with the accept call', async () => {
		const t = await setup();
		const r = await t.mk();
		const x = await t.call('POST', `/risks/${r.id}/accept`, { rationale: 'Cheaper than a fix' });
		expect(x.status).toBe(200);
		expect(x.body.acceptanceRationale).toBe('Cheaper than a fix');
	});

	test('accept is refused for an API token, which is not a person', async () => {
		const t = await setup();
		const r = await ready(t);
		t.as({ kind: 'token', userId: t.admin.id, isAdmin: true, tokenId: 1 });
		const x = await t.call('POST', `/risks/${r.id}/accept`, {});
		expect(x.status).toBe(403);
		const s = await t.call('POST', '/risks/review-stamp', { riskIds: [r.id] });
		expect(s.status).toBe(403);
	});

	test('accept is refused from accepted and from realized', async () => {
		const t = await setup();
		const r = await ready(t);
		await t.call('POST', `/risks/${r.id}/accept`, {});
		const again = await t.call('POST', `/risks/${r.id}/accept`, {});
		expect(again.status).toBe(409);
		expect(again.body.message).toContain("cannot accept from disposition 'accepted'");
	});

	test('the rationale is frozen while accepted', async () => {
		const t = await setup();
		const r = await ready(t);
		await t.call('POST', `/risks/${r.id}/accept`, {});
		const x = await t.call('PATCH', `/risks/${r.id}`, { acceptanceRationale: 'rewritten' });
		expect(x.status).toBe(409);
		const same = await t.call('PATCH', `/risks/${r.id}`, { acceptanceRationale: 'Within appetite' });
		expect(same.status).toBe(200);
	});

	test('the rationale is editable before acceptance', async () => {
		const t = await setup();
		const r = await ready(t);
		const x = await t.call('PATCH', `/risks/${r.id}`, { acceptanceRationale: 'new words' });
		expect(x.body.acceptanceRationale).toBe('new words');
	});

	test('un-accepting needs a note and keeps the signature as history', async () => {
		const t = await setup();
		const r = await ready(t);
		await t.call('POST', `/risks/${r.id}/accept`, {});
		const noNote = await t.call('POST', `/risks/${r.id}/disposition`, { disposition: 'watch' });
		expect(noNote.body.message).toContain('un-accepting a signed risk requires a note');
		const closeNoNote = await t.call('POST', `/risks/${r.id}/disposition`, { disposition: 'closed' });
		expect(closeNoNote.status).toBe(409);
		const ok = await t.call('POST', `/risks/${r.id}/disposition`, {
			disposition: 'closed',
			note: 'retired'
		});
		expect(ok.body.disposition).toBe('closed');
		expect(ok.body.acceptedByName).toBe('ABBY');
		expect(ok.body.acceptedAt).toBeTruthy();
	});

	test('changing the signed scenario or score withdraws the acceptance and keeps the signature', async () => {
		const t = await setup();
		const r = await ready(t);
		await t.call('POST', `/risks/${r.id}/accept`, {});
		const x = await t.call('PATCH', `/risks/${r.id}`, { probability: 4 });
		expect(x.body.disposition).toBe('open');
		expect(x.body.acceptanceInvalidated).toBe(true);
		expect(x.body.acceptedByName).toBe('ABBY');
		const hist = (await t.call('GET', `/risks/${r.id}/history`)).body;
		expect(hist[0].note).toContain('probability');
	});

	test('an edit outside the signature leaves the acceptance alone', async () => {
		const t = await setup();
		const r = await ready(t);
		await t.call('POST', `/risks/${r.id}/accept`, {});
		const x = await t.call('PATCH', `/risks/${r.id}`, { title: 'Renamed', description: 'more' });
		expect(x.body.disposition).toBe('accepted');
		expect(x.body.acceptanceInvalidated).toBe(false);
	});

	test('blank asset text on an accepted risk is a no-op, not a scenario change', async () => {
		const t = await setup();
		const r = await ready(t);
		await t.call('POST', `/risks/${r.id}/accept`, {});
		// The asset here is text; sending blank text clears it, which IS a change.
		// A risk whose asset is a part treats blank text as already unset.
		const p = t.mkPart('Valve', 'OPAL-00001');
		const s = await ready(t, { assetText: null, assetPartId: p.id });
		await t.call('POST', `/risks/${s.id}/accept`, {});
		const x = await t.call('PATCH', `/risks/${s.id}`, { assetText: '   ' });
		expect(x.body.disposition).toBe('accepted');
	});
});

describe('history, review stamp and delete', () => {
	test('history lists score, disposition and owner changes with names and the note', async () => {
		const t = await setup();
		const r = await t.mk();
		await t.call('PATCH', `/risks/${r.id}`, { impact: 5, ownerId: t.other.id });
		await t.call('POST', `/risks/${r.id}/disposition`, { disposition: 'closed', note: 'done' });
		await t.call('PATCH', `/risks/${r.id}`, { title: 'not in history' });
		const h = (await t.call('GET', `/risks/${r.id}/history`)).body;
		expect(h).toHaveLength(3);
		expect(h[0].note).toBe('done');
		expect(h[0].changes).toEqual([{ field: 'disposition', from: 'open', to: 'closed' }]);
		expect(h[1].changes).toContainEqual({ field: 'impact', from: 3, to: 5 });
		expect(h[1].changes).toContainEqual({ field: 'owner', from: 'ABBY', to: 'BEN' });
		expect(h[1].by).toBe('ABBY');
		expect(h[2].action).toBe('create');
	});

	test('review stamp marks the listed risks reviewed by the signed-in user', async () => {
		const t = await setup();
		const a = await t.mk();
		const b = await t.mk();
		const s = await t.call('POST', '/risks/review-stamp', { riskIds: [a.id] });
		expect(s.body.stamped).toBe(1);
		expect((await t.call('GET', `/risks/${a.id}`)).body.lastReviewedByName).toBe('ABBY');
		expect((await t.call('GET', `/risks/${b.id}`)).body.lastReviewedAt).toBeNull();
	});

	test('review stamp by filters stamps every matching risk, not one page', async () => {
		const t = await setup();
		for (let i = 0; i < 3; i++) await t.mk({ probability: 5, impact: 5 });
		await t.mk({ probability: 1, impact: 1 });
		const s = await t.call('POST', '/risks/review-stamp', { severity: 'high' });
		expect(s.body.stamped).toBe(3);
		expect((await t.call('GET', '/risks?q=RISK-00004')).body.items[0].lastReviewedAt).toBeNull();
	});

	test('review stamp honours the matrix cell filter', async () => {
		const t = await setup();
		await t.mk({ probability: 2, impact: 2 });
		await t.mk({ probability: 3, impact: 3 });
		const s = await t.call('POST', '/risks/review-stamp', { probability: 2, impact: 2 });
		expect(s.body.stamped).toBe(1);
	});

	test('review stamp with an empty id list is refused, and with no match is a 404', async () => {
		const t = await setup();
		await t.mk();
		expect((await t.call('POST', '/risks/review-stamp', { riskIds: [] })).status).toBe(422);
		expect((await t.call('POST', '/risks/review-stamp', { disposition: 'watch' })).status).toBe(404);
	});

	test('delete removes a risk that was never accepted', async () => {
		const t = await setup();
		const r = await t.mk();
		expect((await t.call('DELETE', `/risks/${r.id}`)).status).toBe(200);
		expect((await t.call('GET', `/risks/${r.id}`)).status).toBe(404);
	});

	test('a risk that was accepted stays in the register', async () => {
		const t = await setup();
		const r = await ready(t);
		await t.call('POST', `/risks/${r.id}/accept`, {});
		expect((await t.call('DELETE', `/risks/${r.id}`)).status).toBe(409);
	});

	test('the lint endpoint returns findings, underline segments and the accept flag', async () => {
		const t = await setup();
		const x = (await t.call('POST', '/risks/lint', { condition: 'It may leak', consequence: 'sad' })).body;
		expect(x.findings.condition[0].rule).toBe('RL-01');
		expect(x.segments.condition.find((s: any) => s.severity === 'block').text).toBe('may');
		expect(x.findings.consequence[0].rule).toBe('RL-03');
		expect(x.wouldBlockAccept).toBe(true);
		const clean = (await t.call('POST', '/risks/lint', { consequence: 'Loss of data' })).body;
		expect(clean.wouldBlockAccept).toBe(false);
	});
});

describe('issues linked to risks', () => {
	test('linking an issue shows it with its live status and role; a second link is a 409', async () => {
		const t = await setup();
		const r = await t.mk();
		const i = await t.mkIssue();
		const x = await t.call('POST', `/risks/${r.id}/issues`, { issueId: i.id, role: 'research' });
		expect(x.status).toBe(200);
		expect(x.body.linkedIssues).toHaveLength(1);
		expect(x.body.linkedIssues[0]).toMatchObject({ issueNumber: i.issueNumber, role: 'research', status: 'open' });
		const dup = await t.call('POST', `/risks/${r.id}/issues`, { issueId: i.id });
		expect(dup.status).toBe(409);
		expect(dup.body.message).toContain('already linked');
		await t.call('PATCH', `/issues/${i.id}`, { status: 'closed' });
		expect((await t.call('GET', `/risks/${r.id}`)).body.linkedIssues[0].status).toBe('closed');
	});

	test('linking an unknown issue is a 404 and an unknown role is refused', async () => {
		const t = await setup();
		const r = await t.mk();
		expect((await t.call('POST', `/risks/${r.id}/issues`, { issueId: 999 })).status).toBe(404);
		const i = await t.mkIssue();
		expect((await t.call('POST', `/risks/${r.id}/issues`, { issueId: i.id, role: 'bogus' })).status).toBe(422);
	});

	test('spawning a mitigation creates a task issue and a link', async () => {
		const t = await setup();
		const r = await t.mk();
		const x = await t.call('POST', `/risks/${r.id}/issues/spawn`, { role: 'mitigation', title: 'Replace seat' });
		expect(x.status).toBe(200);
		expect(x.body.linkedIssues[0].role).toBe('mitigation');
		const issue = (await t.call('GET', `/issues/${x.body.linkedIssues[0].issueId}`)).body;
		expect(issue.issueType).toBe('task');
		expect(issue.title).toBe('Replace seat');
	});

	test('spawning a realized issue makes a non-conformance and sets the pointer, with no link row', async () => {
		const t = await setup();
		const r = await t.mk();
		const x = await t.call('POST', `/risks/${r.id}/issues/spawn`, { role: 'realized', title: 'It leaked' });
		expect(x.body.linkedIssues).toHaveLength(0);
		expect(x.body.realizedIssueNumber).toBeTruthy();
		const issue = (await t.call('GET', `/issues/${x.body.realizedIssueId}`)).body;
		expect(issue.issueType).toBe('non_conformance');
	});

	test('spawning a realized issue twice is refused so the first is not orphaned', async () => {
		const t = await setup();
		const r = await t.mk();
		await t.call('POST', `/risks/${r.id}/issues/spawn`, { role: 'realized', title: 'once' });
		const x = await t.call('POST', `/risks/${r.id}/issues/spawn`, { role: 'realized', title: 'twice' });
		expect(x.status).toBe(409);
		expect(x.body.message).toContain('already realized');
	});

	test('unlinking removes the link and leaves the issue', async () => {
		const t = await setup();
		const r = await t.mk();
		const i = await t.mkIssue();
		await t.call('POST', `/risks/${r.id}/issues`, { issueId: i.id });
		const x = await t.call('DELETE', `/risks/${r.id}/issues/${i.id}`);
		expect(x.body.linkedIssues).toHaveLength(0);
		expect((await t.call('GET', `/issues/${i.id}`)).status).toBe(200);
		expect((await t.call('DELETE', `/risks/${r.id}/issues/${i.id}`)).status).toBe(404);
	});

	test('the issue detail lists its risks with the relation, and the generic issue link works', async () => {
		const t = await setup();
		const a = await t.mk();
		const b = await t.mk();
		const i = await t.mkIssue();
		await t.call('POST', `/risks/${a.id}/issues`, { issueId: i.id, role: 'research' });
		await t.call('POST', `/issues/${i.id}/links`, { kind: 'risk', targetId: b.id });
		await t.call('POST', `/risks/${b.id}/disposition`, { disposition: 'realized', realizedIssueId: i.id });
		const d = (await t.call('GET', `/issues/${i.id}`)).body;
		const rel = d.risks.map((x: any) => `${x.riskNumber}:${x.relation}`).sort();
		expect(rel).toEqual(['RISK-00001:research', 'RISK-00002:mitigation', 'RISK-00002:realized']);
		const link = d.links.find((l: any) => l.kind === 'risk' && l.label === 'RISK-00002');
		expect(link.href).toBe(`/risks/${b.id}`);
		const dup = await t.call('POST', `/issues/${i.id}/links`, { kind: 'risk', targetId: b.id });
		expect(dup.status).toBe(409);
		expect((await t.call('POST', `/issues/${i.id}/links`, { kind: 'risk', targetId: 999 })).status).toBe(422);
	});

	test('deleting a risk removes its links to issues', async () => {
		const t = await setup();
		const r = await t.mk();
		const i = await t.mkIssue();
		await t.call('POST', `/risks/${r.id}/issues`, { issueId: i.id });
		await t.call('DELETE', `/risks/${r.id}`);
		expect((await t.call('GET', `/issues/${i.id}`)).body.links).toHaveLength(0);
	});
});

describe('references', () => {
	test('a reference to an OPAL or work order number is normalized, listed and removable', async () => {
		const t = await setup();
		const r = await t.mk();
		const a = await t.call('POST', `/risks/${r.id}/references`, { type: 'opal', value: 'opal-00042', notes: 'the seat' });
		expect(a.body.references[0]).toMatchObject({ type: 'opal', value: 'OPAL-00042', notes: 'the seat' });
		const b = await t.call('POST', `/risks/${r.id}/references`, { type: 'work_order', value: 'WO-00015' });
		expect(b.body.references).toHaveLength(2);
		const gone = await t.call('DELETE', `/risks/${r.id}/references/${a.body.references[0].id}`);
		expect(gone.body.references).toHaveLength(1);
	});

	test('a malformed or repeated reference is refused', async () => {
		const t = await setup();
		const r = await t.mk();
		expect((await t.call('POST', `/risks/${r.id}/references`, { type: 'opal', value: 'WO-1' })).status).toBe(422);
		await t.call('POST', `/risks/${r.id}/references`, { type: 'opal', value: 'OPAL-00001' });
		expect((await t.call('POST', `/risks/${r.id}/references`, { type: 'opal', value: 'OPAL-00001' })).status).toBe(409);
	});
});

describe('projects', () => {
	test('a risk needs an active project and shows its code and name', async () => {
		const { call, db, project, app } = await setup();
		const res = await app.request('/api/risks', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ title: 't' })
		});
		expect(res.status).toBe(422);
		expect((await call('POST', '/risks', { title: 't', projectId: 999 })).status).toBe(404);
		const dead = createTestProject(db, 'DEAD');
		await call('POST', `/projects/${dead.id}/archive`);
		expect((await call('POST', '/risks', { title: 't', projectId: dead.id })).status).toBe(409);
		const r = await call('POST', '/risks', { title: 't', projectId: project.id });
		expect(r.body).toMatchObject({ projectId: project.id, projectCode: 'TP', projectName: 'Project TP' });
	});

	test('the list filters by project and a risk moves to another active project', async () => {
		const { call, mk, db, project } = await setup();
		const b = createTestProject(db, 'B');
		const a1 = await mk();
		const b1 = await mk({ projectId: b.id });
		const ids = async (q: string) => (await call('GET', `/risks${q}`)).body.items.map((x: any) => x.id);
		expect(await ids(`?projectId=${project.id}`)).toEqual([a1.id]);
		expect(await ids(`?projectId=${b.id}`)).toEqual([b1.id]);
		expect(await ids('')).toHaveLength(2);
		const moved = await call('PATCH', `/risks/${a1.id}`, { projectId: b.id });
		expect(moved.body).toMatchObject({ projectId: b.id, projectCode: 'B' });
		expect(await ids(`?projectId=${b.id}`)).toHaveLength(2);
		expect((await call('PATCH', `/risks/${a1.id}`, { projectId: 999 })).status).toBe(404);
	});

	test('the matrix counts only the risks of the project asked for', async () => {
		const { call, mk, db, project } = await setup();
		const b = createTestProject(db, 'B');
		await mk({ probability: 2, impact: 3 });
		await mk({ probability: 2, impact: 3, projectId: b.id });
		await mk({ probability: 4, impact: 4, projectId: b.id });
		const m = async (q: string) => (await call('GET', `/risks/matrix${q}`)).body;
		expect((await m('')).totalRisks).toBe(3);
		const a = await m(`?projectId=${project.id}`);
		expect(a.totalRisks).toBe(1);
		expect(a.matrix[1][2]).toBe(1);
		const bb = await m(`?projectId=${b.id}`);
		expect(bb.totalRisks).toBe(2);
		expect(bb.matrix[3][3]).toBe(1);
	});

	test('an issue spawned from a risk joins the project of the risk', async () => {
		const { call, mk, db } = await setup();
		const b = createTestProject(db, 'B');
		const r = await mk({ projectId: b.id });
		const sp = await call('POST', `/risks/${r.id}/issues/spawn`, { title: 'Respond', role: 'mitigation' });
		expect(sp.status).toBe(200);
		expect(sp.body.linkedIssues[0]).toBeDefined();
		const issue = (await call('GET', `/issues/${sp.body.linkedIssues[0].issueId}`)).body;
		expect(issue).toMatchObject({ projectId: b.id, projectCode: 'B' });
	});
});
