import { describe, expect, test } from 'bun:test';
import { auditLog, issueLink } from '../../src/db/schema/index.ts';
import { holdingIssues } from '../../src/services/issues/holds.ts';
import { issueHooks, type IssueNotification } from '../../src/services/issues/hooks.ts';
import { createTestProject } from '../helpers/project.ts'; // added by projects
import { setup } from './helpers.ts';

describe('raising', () => {
	test('an advisory issue gets the next IT number, opens, and is pending', async () => {
		const { call, db } = await setup();
		const r = await call('POST', '/issues', {
			title: 'Test Bug',
			description: 'Something is broken',
			issueType: 'bug',
			priority: 'high'
		});
		expect(r.status).toBe(201);
		expect(r.body).toMatchObject({
			issueNumber: 'IT-00001',
			issueType: 'bug',
			priority: 'high',
			status: 'open',
			containment: 'advisory',
			dispState: 'open',
			ticketState: 'pending',
			isBlocking: false
		});
		const second = await call('POST', '/issues', { title: 'B' });
		expect(second.body.issueNumber).toBe('IT-00002');
		const audit = db.select().from(auditLog).all();
		expect(audit.some((a) => a.entity === 'issue' && a.action === 'create')).toBe(true);
	});

	test('type, priority and containment default to task, medium and advisory', async () => {
		const { raise } = await setup();
		const i = await raise();
		expect([i.issueType, i.priority, i.containment]).toEqual(['task', 'medium', 'advisory']);
	});

	test('a containment-bearing issue enters the disposition gate undispositioned', async () => {
		const { raise } = await setup();
		const i = await raise({ containment: 'wo' });
		expect(i.dispState).toBe('undispositioned');
		expect(i.isBlocking).toBe(true);
		expect(i.ticketState).toBe('pending');
	});

	test('the raiser is the signed-in user and the title is required', async () => {
		const { raise, call, admin } = await setup();
		const i = await raise();
		expect(i.raisedBy).toEqual({ id: admin.id, name: 'ABBY' });
		expect((await call('POST', '/issues', { title: '  ' })).status).toBe(422);
	});

	test('type-specific capture fields are stored', async () => {
		const { raise } = await setup();
		const i = await raise({
			issueType: 'non_conformance',
			shouldBe: '12 N·m',
			actual: '9 N·m',
			stepsToReproduce: 'a',
			expectedBehavior: 'b',
			actualBehavior: 'c',
			expectedBenefit: 'd'
		});
		expect(i).toMatchObject({ shouldBe: '12 N·m', actual: '9 N·m', stepsToReproduce: 'a', expectedBenefit: 'd' });
	});

	test('an unknown assignee is refused', async () => {
		const { call } = await setup();
		expect((await call('POST', '/issues', { title: 'x', assignedToId: 999 })).status).toBe(422);
	});
});

describe('listing', () => {
	test('filters by type', async () => {
		const { raise, call } = await setup();
		await raise({ issueType: 'bug' });
		await raise({ issueType: 'task' });
		const r = await call('GET', '/issues?issueType=bug');
		expect(r.body.items.every((i: any) => i.issueType === 'bug')).toBe(true);
		expect(r.body.total).toBe(1);
	});

	test('the dispState filter separates open, undispositioned, dispositioned and closed', async () => {
		const { raise, call, sign } = await setup();
		const advisory = await raise({ title: 'Advisory Open' });
		const bearing = await raise({ title: 'Bearing', containment: 'wo' });
		const signed = await raise({ title: 'Signed', containment: 'wo' });
		expect((await sign(signed.id)).status).toBe(200);
		const ids = async (q: string) =>
			(await call('GET', `/issues?dispState=${q}`)).body.items.map((i: any) => i.id).sort();
		expect(await ids('open')).toEqual([advisory.id]);
		expect(await ids('undispositioned')).toEqual([bearing.id]);
		expect(await ids('dispositioned')).toEqual([signed.id]);
		expect((await call('GET', '/issues?dispState=bogus')).status).toBe(422);
	});

	test('the state filter takes one state, a comma list, and refuses an unknown one', async () => {
		const { raise, call, sign } = await setup();
		const post = (id: number, p: string, body?: object) => call('POST', `/issues/${id}/${p}`, body);
		const pending = (await raise({ title: 'p' })).id;
		const inWork = (await raise({ title: 'w' })).id;
		const inReview = (await raise({ title: 'r' })).id;
		const done = (await raise({ title: 'd' })).id;
		const held = (await raise({ title: 'h', containment: 'wo' })).id;
		const bearingWork = (await raise({ title: 'bw', containment: 'wo' })).id;
		await post(inWork, 'start');
		for (const id of [inReview, done]) {
			await post(id, 'start');
			await post(id, 'review');
		}
		await post(done, 'signoff');
		await sign(bearingWork);
		const ids = async (q: string) =>
			(await call('GET', `/issues?${q}`)).body.items.map((i: any) => i.id).sort((a: number, b: number) => a - b);
		expect(await ids('state=pending')).toEqual([pending, held]);
		expect(await ids('state=in_work')).toEqual([inWork, bearingWork]);
		expect(await ids('state=in_review')).toEqual([inReview]);
		expect(await ids('state=done')).toEqual([done]);
		expect(await ids('state=pending,done')).toEqual([pending, done, held]);
		expect(await ids('status=closed')).toEqual([done]);
		expect(await ids('dispState=undispositioned')).toEqual([held]);
		expect((await call('GET', '/issues?state=bogus')).status).toBe(422);
	});

	test('the default order puts blocking issues first', async () => {
		const { raise, call } = await setup();
		await raise({ title: 'Advisory old' });
		const blocking = await raise({ title: 'Blocking', containment: 'wo' });
		await raise({ title: 'Advisory new' });
		const items = (await call('GET', '/issues')).body.items;
		expect(items[0].id).toBe(blocking.id);
	});

	test('sort, search and the assignee filter work', async () => {
		const { raise, call, admin } = await setup();
		const a = await raise({ title: 'Bravo', priority: 'low' });
		const b = await raise({ title: 'Alpha', priority: 'critical', assignedToId: admin.id });
		const byTitle = (await call('GET', '/issues?sort=title&dir=asc')).body.items;
		expect(byTitle.map((i: any) => i.title).slice(0, 2)).toEqual(['Alpha', 'Bravo']);
		const byPriority = (await call('GET', '/issues?sort=priority&dir=desc')).body.items;
		expect(byPriority[0].id).toBe(b.id);
		expect((await call('GET', '/issues?sort=bogus')).status).toBe(422);
		const mine = (await call('GET', `/issues?assignedToId=${admin.id}`)).body.items;
		expect(mine.map((i: any) => i.id)).toEqual([b.id]);
		const found = (await call('GET', `/issues?q=${a.issueNumber}`)).body.items;
		expect(found.map((i: any) => i.id)).toEqual([a.id]);
	});

	test('the list pages with a cursor and reports the total', async () => {
		const { raise, call } = await setup();
		for (const t of ['A', 'B', 'C']) await raise({ title: t });
		const first = (await call('GET', '/issues?limit=2')).body;
		expect(first.items.map((i: any) => i.title)).toEqual(['C', 'B']);
		expect(first.total).toBe(3);
		const second = (await call('GET', `/issues?limit=2&cursor=${first.next}`)).body;
		expect(second.items.map((i: any) => i.title)).toEqual(['A']);
		expect(second.next).toBeNull();
	});

	test('the list filters by linked part', async () => {
		const { raise, call, mkPart } = await setup();
		const p = mkPart('Bracket', 'P-1');
		const linked = await raise({ links: [{ kind: 'part', targetId: p.id }] });
		await raise();
		const items = (await call('GET', `/issues?partId=${p.id}`)).body.items;
		expect(items.map((i: any) => i.id)).toEqual([linked.id]);
	});

	test('assignees lists active users only', async () => {
		const { call, db } = await setup();
		const { user } = await import('../../src/db/schema/index.ts');
		const { eq } = await import('drizzle-orm');
		db.update(user).set({ isActive: false }).where(eq(user.username, 'ben')).run();
		const r = await call('GET', '/issues/assignees');
		expect(r.body.map((u: any) => u.name)).toEqual(['ABBY', 'CAT']);
	});
});

describe('editing', () => {
	test('edits title and priority and leaves omitted fields alone', async () => {
		const { raise, call } = await setup();
		const i = await raise({ title: 'Original', description: 'keep' });
		const r = await call('PATCH', `/issues/${i.id}`, { title: 'Updated', priority: 'critical' });
		expect(r.body).toMatchObject({ title: 'Updated', priority: 'critical', description: 'keep' });
	});

	test('null clears the assignee and an omitted assignee is untouched', async () => {
		const { raise, call, admin } = await setup();
		const i = await raise({ assignedToId: admin.id });
		expect(i.assignedTo.id).toBe(admin.id);
		const again = await call('PATCH', `/issues/${i.id}`, { title: 'Renamed' });
		expect(again.body.assignedTo.id).toBe(admin.id);
		const cleared = await call('PATCH', `/issues/${i.id}`, { assignedToId: null });
		expect(cleared.body.assignedTo).toBeNull();
	});

	test('an unknown assignee is refused on edit', async () => {
		const { raise, call } = await setup();
		const i = await raise();
		expect((await call('PATCH', `/issues/${i.id}`, { assignedToId: 999999 })).status).toBe(422);
	});

	test('an unknown issue is 404', async () => {
		const { call } = await setup();
		expect((await call('GET', '/issues/99999')).status).toBe(404);
		expect((await call('POST', '/issues/99999/start')).status).toBe(404);
	});

	test('an update writes an audit row', async () => {
		const { raise, call, db } = await setup();
		const i = await raise();
		await call('PATCH', `/issues/${i.id}`, { title: 'X' });
		const rows = db.select().from(auditLog).all();
		expect(rows.filter((r) => r.entity === 'issue' && r.action === 'update')).toHaveLength(1);
	});
});

describe('disposition', () => {
	test('signing records type, rationale, signer and time, and the issue stays open', async () => {
		const { raise, sign, admin } = await setup();
		const i = await raise({ containment: 'wo' });
		expect(i.dispositioned).toBe(false);
		const r = await sign(i.id, 'rework', 'rework per redline');
		expect(r.status).toBe(200);
		expect(r.body).toMatchObject({
			dispositionType: 'rework',
			dispositionRationale: 'rework per redline',
			dispositioned: true,
			dispState: 'dispositioned',
			status: 'open',
			isBlocking: false,
			dispositionedBy: { id: admin.id, name: 'ABBY' },
			selfDispositioned: true
		});
		expect(r.body.dispositionedAt).toBeTruthy();
	});

	test('a different signer is not self-dispositioned', async () => {
		const { raise, sign, as, other } = await setup();
		const i = await raise({ containment: 'wo' });
		as(other);
		expect((await sign(i.id)).body.selfDispositioned).toBe(false);
	});

	test('signing needs a rationale', async () => {
		const { raise, call } = await setup();
		const i = await raise({ containment: 'wo' });
		const r = await call('POST', `/issues/${i.id}/disposition`, {
			dispositionType: 'use_as_is',
			dispositionRationale: ''
		});
		expect(r.status).toBe(422);
	});

	test('an advisory issue has no disposition to sign', async () => {
		const { raise, sign } = await setup();
		const i = await raise();
		const r = await sign(i.id);
		expect(r.status).toBe(409);
		expect(r.body.message).toContain('advisory');
	});

	test('a signed disposition cannot be edited or signed again', async () => {
		const { raise, sign, call } = await setup();
		const i = await raise({ containment: 'wo' });
		expect((await sign(i.id)).status).toBe(200);
		expect((await call('PATCH', `/issues/${i.id}`, { dispositionType: 'scrap' })).status).toBe(409);
		expect((await sign(i.id, 'scrap', 'second thoughts')).status).toBe(409);
	});

	test('type and rationale can be drafted before the signature without dispositioning', async () => {
		const { raise, call } = await setup();
		const i = await raise({ containment: 'op' });
		const r = await call('PATCH', `/issues/${i.id}`, {
			rootCause: 'Material defect',
			correctiveAction: 'Replace batch',
			dispositionType: 'rework',
			dispositionRationale: 'Rework per procedure'
		});
		expect(r.body).toMatchObject({
			rootCause: 'Material defect',
			dispositionType: 'rework',
			dispositioned: false,
			dispState: 'undispositioned'
		});
		const cleared = await call('PATCH', `/issues/${i.id}`, { dispositionType: null });
		expect(cleared.body.dispositionType).toBeNull();
	});

	test('a closed issue cannot be signed', async () => {
		const { raise, sign, call } = await setup();
		const i = await raise({ containment: 'wo' });
		await sign(i.id);
		await call('PATCH', `/issues/${i.id}`, { status: 'closed' });
		expect((await sign(i.id, 'scrap', 'x')).status).toBe(409);
	});

	test('signing needs the issue.disposition gate', async () => {
		const { raise, sign, as, plain } = await setup();
		const i = await raise({ containment: 'wo' });
		as(plain);
		expect((await sign(i.id)).status).toBe(403);
	});

	test('an API token cannot sign a disposition', async () => {
		const { raise, sign, as, admin } = await setup();
		const i = await raise({ containment: 'wo' });
		as({ kind: 'token', userId: admin.id, isAdmin: true, tokenId: 1 });
		expect((await sign(i.id)).status).toBe(403);
	});
});

describe('closing', () => {
	test('an undispositioned containment issue cannot close: disposition first', async () => {
		const { raise, sign, call } = await setup();
		const i = await raise({ containment: 'wo' });
		const r = await call('PATCH', `/issues/${i.id}`, { status: 'closed' });
		expect(r.status).toBe(409);
		expect(r.body.message).toContain('undispositioned');
		await sign(i.id);
		const ok = await call('PATCH', `/issues/${i.id}`, { status: 'closed' });
		expect(ok.status).toBe(200);
		expect(ok.body.dispState).toBe('closed');
	});

	test('an advisory issue closes freely and stamps who and when', async () => {
		const { raise, call, admin } = await setup();
		const i = await raise();
		const r = await call('PATCH', `/issues/${i.id}`, { status: 'closed' });
		expect(r.body).toMatchObject({
			dispState: 'closed',
			ticketState: 'done',
			closedBy: { id: admin.id, name: 'ABBY' }
		});
		expect(r.body.closedAt).toBeTruthy();
	});

	test('a non-conformance needs corrective action to close, at any containment', async () => {
		const { raise, sign, call } = await setup();
		const i = await raise({ issueType: 'non_conformance', containment: 'wo' });
		await sign(i.id);
		const refused = await call('PATCH', `/issues/${i.id}`, { status: 'closed' });
		expect(refused.status).toBe(409);
		expect(refused.body.message).toContain('corrective action');
		const ok = await call('PATCH', `/issues/${i.id}`, {
			status: 'closed',
			correctiveAction: 'Updated torque spec in template'
		});
		expect(ok.status).toBe(200);
		const advisory = await raise({ issueType: 'non_conformance' });
		const r = await call('PATCH', `/issues/${advisory.id}`, { status: 'closed' });
		expect(r.body.message).toContain('corrective action');
	});

	test('closing needs the issue.approve gate', async () => {
		const { raise, call, as, plain } = await setup();
		const i = await raise();
		as(plain);
		expect((await call('PATCH', `/issues/${i.id}`, { status: 'closed' })).status).toBe(403);
	});

	test('an API token cannot close an issue', async () => {
		const { raise, call, as, admin } = await setup();
		const i = await raise();
		as({ kind: 'token', userId: admin.id, isAdmin: true, tokenId: 1 });
		expect((await call('PATCH', `/issues/${i.id}`, { status: 'closed' })).status).toBe(403);
	});

	test('reopening clears the close and review stamps and derives the state again', async () => {
		const { raise, call } = await setup();
		const i = await raise();
		const p = (path: string) => call('POST', `/issues/${i.id}/${path}`);
		await p('start');
		await p('review');
		await p('signoff');
		const body = (await call('PATCH', `/issues/${i.id}`, { status: 'open' })).body;
		expect(body.closedAt).toBeNull();
		expect(body.closedBy).toBeNull();
		expect(body.reviewRequestedAt).toBeNull();
		expect(body.ticketState).toBe('in_work');
	});

	test('reopening an advisory issue closed directly returns it to pending', async () => {
		const { raise, call } = await setup();
		const i = await raise();
		await call('PATCH', `/issues/${i.id}`, { status: 'closed' });
		const body = (await call('PATCH', `/issues/${i.id}`, { status: 'open' })).body;
		expect(body.ticketState).toBe('pending');
	});

	test('reopening a dispositioned issue returns it to in work', async () => {
		const { raise, sign, call } = await setup();
		const i = await raise({ containment: 'wo' });
		await sign(i.id);
		await call('POST', `/issues/${i.id}/review`);
		await call('POST', `/issues/${i.id}/signoff`);
		const body = (await call('PATCH', `/issues/${i.id}`, { status: 'open' })).body;
		expect(body.ticketState).toBe('in_work');
	});
});

describe('ticket flow', () => {
	const flow = async () => {
		const s = await setup();
		const post = (id: number, path: string, body?: object) => s.call('POST', `/issues/${id}/${path}`, body ?? {});
		return { ...s, post };
	};

	test('an advisory issue goes pending, in work, in review, done with stamps', async () => {
		const { raise, post } = await flow();
		const i = await raise();
		const started = (await post(i.id, 'start')).body;
		expect(started.ticketState).toBe('in_work');
		expect(started.workStartedAt).toBeTruthy();
		expect(started.workStartedBy.name).toBe('ABBY');
		const reviewed = (await post(i.id, 'review')).body;
		expect(reviewed.ticketState).toBe('in_review');
		expect(reviewed.reviewRequestedBy.name).toBe('ABBY');
		const done = (await post(i.id, 'signoff')).body;
		expect(done).toMatchObject({ ticketState: 'done', status: 'closed' });
		expect(done.closedBy.name).toBe('ABBY');
	});

	test('a containment issue is in work once dispositioned, then reviews and signs off', async () => {
		const { raise, post, sign } = await flow();
		const i = await raise({ containment: 'wo' });
		const signed = (await sign(i.id)).body;
		expect(signed).toMatchObject({ ticketState: 'in_work', dispState: 'dispositioned', workStartedAt: null });
		expect((await post(i.id, 'review')).body.ticketState).toBe('in_review');
		expect((await post(i.id, 'signoff')).body.ticketState).toBe('done');
	});

	test('a containment issue cannot start work: it enters work by disposition', async () => {
		const { raise, post } = await flow();
		const i = await raise({ containment: 'wo' });
		const r = await post(i.id, 'start');
		expect(r.status).toBe(409);
		expect(r.body.message).toContain('disposition');
	});

	test('a pending issue refuses review and sign-off', async () => {
		const { raise, post } = await flow();
		for (const path of ['review', 'signoff']) {
			const i = await raise();
			const r = await post(i.id, path);
			expect(r.status).toBe(409);
			expect(r.body.message).toContain('pending');
		}
	});

	test('an undispositioned containment issue cannot enter review', async () => {
		const { raise, post, call } = await flow();
		const i = await raise({ containment: 'wo' });
		expect((await post(i.id, 'review')).status).toBe(409);
		expect((await call('GET', `/issues/${i.id}`)).body.dispState).toBe('undispositioned');
	});

	test('starting twice is refused', async () => {
		const { raise, post } = await flow();
		const i = await raise();
		await post(i.id, 'start');
		expect((await post(i.id, 'start')).status).toBe(409);
	});

	test('sign-off from in work is refused and the issue stays open', async () => {
		const { raise, post, call } = await flow();
		const i = await raise();
		await post(i.id, 'start');
		const r = await post(i.id, 'signoff');
		expect(r.status).toBe(409);
		expect(r.body.message).toContain('in work');
		expect((await call('GET', `/issues/${i.id}`)).body.status).toBe('open');
	});

	test('a done issue refuses every transition', async () => {
		const { raise, post } = await flow();
		const i = await raise();
		for (const p of ['start', 'review', 'signoff']) await post(i.id, p);
		for (const p of ['start', 'review', 'signoff'])
			expect((await post(i.id, p)).status).toBe(409);
		expect((await post(i.id, 'review/return', { comment: 'x' })).status).toBe(409);
	});

	test('returning from the wrong state is refused', async () => {
		const { raise, post } = await flow();
		const i = await raise();
		expect((await post(i.id, 'review/return', { comment: 'x' })).status).toBe(409);
	});

	test('returning needs a non-blank comment', async () => {
		const { raise, post, call } = await flow();
		const i = await raise();
		await post(i.id, 'start');
		await post(i.id, 'review');
		expect((await post(i.id, 'review/return', {})).status).toBe(422);
		expect((await post(i.id, 'review/return', { comment: '   ' })).status).toBe(409);
		expect((await call('GET', `/issues/${i.id}`)).body.ticketState).toBe('in_review');
	});

	test('returning clears the review stamps, keeps the work start and stores the comment', async () => {
		const { raise, post, call } = await flow();
		const i = await raise();
		await post(i.id, 'start');
		await post(i.id, 'review');
		const r = await post(i.id, 'review/return', { comment: 'torque value missing' });
		expect(r.status).toBe(200);
		expect(r.body).toMatchObject({ ticketState: 'in_work', reviewRequestedAt: null, reviewRequestedBy: null });
		expect(r.body.workStartedAt).not.toBeNull();
		const comments = (await call('GET', `/issues/${i.id}/comments`)).body;
		expect(comments.some((c: any) => c.body.includes('torque value missing'))).toBe(true);
		expect((await post(i.id, 'review')).body.ticketState).toBe('in_review');
	});

	test('sign-off of a non-conformance needs corrective action', async () => {
		const { raise, post, call } = await flow();
		const i = await raise({ issueType: 'non_conformance' });
		await post(i.id, 'start');
		await post(i.id, 'review');
		const r = await post(i.id, 'signoff');
		expect(r.status).toBe(409);
		expect(r.body.message).toContain('corrective action');
		expect((await call('GET', `/issues/${i.id}`)).body.ticketState).toBe('in_review');
		await call('PATCH', `/issues/${i.id}`, { correctiveAction: 're-torqued' });
		expect((await post(i.id, 'signoff')).body.ticketState).toBe('done');
	});

	test('sign-off needs the issue.approve gate and refuses an API token', async () => {
		const { raise, post, as, plain, admin } = await flow();
		const i = await raise();
		await post(i.id, 'start');
		await post(i.id, 'review');
		as(plain);
		expect((await post(i.id, 'signoff')).status).toBe(403);
		as({ kind: 'token', userId: admin.id, isAdmin: true, tokenId: 1 });
		expect((await post(i.id, 'signoff')).status).toBe(403);
	});
});

describe('containment', () => {
	test('widening is one step', async () => {
		const { raise, call } = await setup();
		const i = await raise({ containment: 'step' });
		const r = await call('POST', `/issues/${i.id}/containment`, { containment: 'wo' });
		expect(r.body.containment).toBe('wo');
	});

	test('narrowing a hold needs a note, and the note lands in the activity log', async () => {
		const { raise, call } = await setup();
		const i = await raise({ containment: 'step' });
		const refused = await call('POST', `/issues/${i.id}/containment`, { containment: 'advisory' });
		expect(refused.status).toBe(409);
		expect(refused.body.message).toContain('note is required');
		const ok = await call('POST', `/issues/${i.id}/containment`, {
			containment: 'advisory',
			note: 'cosmetic only, crew chief concurs'
		});
		expect(ok.body.containment).toBe('advisory');
		const comments = (await call('GET', `/issues/${i.id}/comments`)).body;
		expect(comments.some((c: any) => c.body.includes('Containment narrowed step → advisory'))).toBe(true);
	});

	test('narrowing a dispositioned issue releases nothing and needs no note', async () => {
		const { raise, call, sign } = await setup();
		const i = await raise({ containment: 'wo' });
		await sign(i.id);
		const r = await call('POST', `/issues/${i.id}/containment`, { containment: 'step' });
		expect(r.status).toBe(200);
	});

	test('an omitted boundary is kept and an explicit null clears it', async () => {
		const { raise, call } = await setup();
		const i = await raise({ containment: 'step', containmentStepId: 7 });
		const kept = await call('POST', `/issues/${i.id}/containment`, { containment: 'op' });
		expect(kept.body.containmentStepId).toBe(7);
		const cleared = await call('POST', `/issues/${i.id}/containment`, {
			containment: 'op',
			containmentStepId: null
		});
		expect(cleared.body.containmentStepId).toBeNull();
	});

	test('an advisory issue holds nothing', async () => {
		const { raise, call } = await setup();
		const i = await raise();
		expect((await call('GET', `/issues/${i.id}/holding`)).body).toEqual([]);
	});

	test('holding names the scope, execution and step of a blocking issue', async () => {
		const { raise, call, sign } = await setup();
		const i = await raise({ containment: 'step', executionId: 4, raisedStepId: 11 });
		expect((await call('GET', `/issues/${i.id}/holding`)).body).toEqual([
			{ scope: 'step', executionId: 4, stepId: 11, label: 'STEP COMPLETE', href: '/executions/4' }
		]);
		const preview = await call('GET', `/issues/${i.id}/holding?containment=wo`);
		expect(preview.body).toEqual([{ scope: 'wo', executionId: 4, stepId: null, label: 'WO COMPLETE', href: '/executions/4' }]);
		await sign(i.id);
		expect((await call('GET', `/issues/${i.id}/holding`)).body).toEqual([]);
	});
});

describe('execution anchors and holds', () => {
	test('the execution cannot be detached while the issue blocks it', async () => {
		const { raise, call, sign } = await setup();
		const i = await raise({ containment: 'wo', executionId: 3 });
		const r = await call('PATCH', `/issues/${i.id}`, { executionId: null });
		expect(r.status).toBe(409);
		expect(r.body.message).toContain('undispositioned');
		await sign(i.id);
		expect((await call('PATCH', `/issues/${i.id}`, { executionId: null })).status).toBe(200);
	});

	test('a step anchor supplies the execution and a step from another execution is refused', async () => {
		const { raise, call } = await setup();
		issueHooks.resolveStep = (_c, stepId) => (stepId === 1 ? { executionId: 5 } : stepId === 2 ? { executionId: 6 } : null);
		const i = await raise({ containment: 'step', raisedStepId: 1 });
		expect(i.executionId).toBe(5);
		const bad = await call('POST', '/issues', { title: 'x', containment: 'step', executionId: 5, raisedStepId: 2 });
		expect(bad.status).toBe(422);
		const missing = await call('POST', '/issues', { title: 'x', containment: 'step', raisedStepId: 99 });
		expect(missing.status).toBe(422);
		const bound = await call('POST', `/issues/${i.id}/containment`, { containment: 'step', containmentStepId: 2 });
		expect(bound.status).toBe(409);
	});

	test('an unknown execution is refused when the execution area is wired in', async () => {
		const { call } = await setup();
		issueHooks.executionExists = (_c, id) => id === 1;
		expect((await call('POST', '/issues', { title: 'x', executionId: 2 })).status).toBe(422);
		expect((await call('POST', '/issues', { title: 'x', executionId: 1 })).status).toBe(201);
	});

	test('a hold change is reported to the execution area on raise, sign, narrow and void', async () => {
		const { raise, call, sign } = await setup();
		const seen: [number, boolean, boolean][] = [];
		issueHooks.holdChanged.push((_c, ch) => seen.push([ch.executionId, ch.wasBlocking, ch.isBlocking]));
		const i = await raise({ containment: 'wo', executionId: 8 });
		await sign(i.id);
		const j = await raise({ containment: 'wo', executionId: 8 });
		await call('POST', `/issues/${j.id}/void`, { reason: 'duplicate' });
		expect(seen).toEqual([
			[8, false, true],
			[8, true, false],
			[8, false, true],
			[8, true, false]
		]);
	});

	test('holdingIssues lists the open undispositioned issues of an execution, by anchor', async () => {
		const { raise, db, sign } = await setup();
		const wo = await raise({ title: 'wo', containment: 'wo', executionId: 2 });
		const step = await raise({ title: 'step', containment: 'step', executionId: 2, raisedStepId: 10 });
		const other = await raise({ title: 'other step', containment: 'step', executionId: 2, containmentStepId: 20, raisedStepId: 10 });
		await raise({ title: 'advisory', executionId: 2 });
		await raise({ title: 'elsewhere', containment: 'wo', executionId: 3 });
		const signed = await raise({ title: 'signed', containment: 'wo', executionId: 2 });
		await sign(signed.id);

		const all = holdingIssues(db, 2);
		expect(all.map((h) => h.id)).toEqual([wo.id, step.id, other.id]);
		expect(all[1]).toMatchObject({ containment: 'step', ticketState: 'pending', raisedStepId: 10, containmentStepId: null });
		expect(holdingIssues(db, 2, { anchorStepIds: [10] }).map((h) => h.id)).toEqual([wo.id, step.id, other.id]);
		expect(holdingIssues(db, 2, { anchorStepIds: [99] }).map((h) => h.id)).toEqual([wo.id]);
		expect(holdingIssues(db, 2, { anchorStepIds: [20] }).map((h) => h.id)).toEqual([wo.id, other.id]);
		expect(holdingIssues(db, 9)).toEqual([]);
	});
});

describe('void', () => {
	test('a voided issue is terminal, keeps the reason, and releases its hold', async () => {
		const { raise, call, db } = await setup();
		const i = await raise({ containment: 'wo', executionId: 2 });
		expect(holdingIssues(db, 2)).toHaveLength(1);
		const r = await call('POST', `/issues/${i.id}/void`, { reason: 'raised by mistake' });
		expect(r.body).toMatchObject({ status: 'void', dispState: 'void', isBlocking: false });
		expect(holdingIssues(db, 2)).toHaveLength(0);
		const comments = (await call('GET', `/issues/${i.id}/comments`)).body;
		expect(comments[0].body).toBe('Voided: raised by mistake');
		expect((await call('PATCH', `/issues/${i.id}`, { title: 'x' })).status).toBe(409);
		expect((await call('PATCH', `/issues/${i.id}`, { status: 'open' })).status).toBe(409);
		expect((await call('POST', `/issues/${i.id}/void`, { reason: 'again' })).status).toBe(409);
		expect((await call('POST', `/issues/${i.id}/disposition`, { dispositionType: 'scrap', dispositionRationale: 'x' })).status).toBe(409);
	});

	test('a void needs a reason', async () => {
		const { raise, call } = await setup();
		const i = await raise();
		expect((await call('POST', `/issues/${i.id}/void`, { reason: ' ' })).status).toBe(422);
	});

	test('a void issue is listed under status void and numbers are not reused', async () => {
		const { raise, call } = await setup();
		const i = await raise();
		await call('POST', `/issues/${i.id}/void`, { reason: 'x' });
		expect((await call('GET', '/issues?status=void')).body.items).toHaveLength(1);
		expect((await raise()).issueNumber).toBe('IT-00002');
	});
});

describe('comments', () => {
	test('a comment carries the author name and comments list oldest first', async () => {
		const { raise, call } = await setup();
		const i = await raise();
		await call('POST', `/issues/${i.id}/comments`, { body: 'First comment' });
		await call('POST', `/issues/${i.id}/comments`, { body: 'Second comment' });
		const r = (await call('GET', `/issues/${i.id}/comments`)).body;
		expect(r.map((c: any) => c.body)).toEqual(['First comment', 'Second comment']);
		expect(r[0].user.name).toBe('ABBY');
	});

	test('an empty comment is refused', async () => {
		const { raise, call } = await setup();
		const i = await raise();
		expect((await call('POST', `/issues/${i.id}/comments`, { body: '  ' })).status).toBe(422);
	});
});

describe('links', () => {
	test('an issue links to a part, at raise time and later, once', async () => {
		const { raise, call, mkPart } = await setup();
		const p = mkPart('Bracket', 'SPX-1');
		const q = mkPart('Plate', 'SPX-2');
		const i = await raise({ links: [{ kind: 'part', targetId: p.id }] });
		expect(i.links).toEqual([
			{ id: expect.any(Number), kind: 'part', targetId: p.id, label: 'SPX-1', sublabel: 'Bracket', href: `/parts/${p.id}` }
		]);
		const added = await call('POST', `/issues/${i.id}/links`, { kind: 'part', targetId: q.id });
		expect(added.status).toBe(200);
		expect((await call('GET', `/issues/${i.id}`)).body.links).toHaveLength(2);
		expect((await call('POST', `/issues/${i.id}/links`, { kind: 'part', targetId: q.id })).status).toBe(409);
	});

	test('a link to an unknown part is refused', async () => {
		const { raise, call } = await setup();
		const i = await raise();
		expect((await call('POST', `/issues/${i.id}/links`, { kind: 'part', targetId: 999 })).status).toBe(422);
		expect((await call('POST', '/issues', { title: 'x', links: [{ kind: 'part', targetId: 999 }] })).status).toBe(422);
	});

	test('a link can be removed, only from its own issue', async () => {
		const { raise, call, mkPart } = await setup();
		const p = mkPart('Bracket', 'SPX-1');
		const i = await raise({ links: [{ kind: 'part', targetId: p.id }] });
		const j = await raise();
		const linkId = i.links[0].id;
		expect((await call('DELETE', `/issues/${j.id}/links/${linkId}`)).status).toBe(404);
		expect((await call('DELETE', `/issues/${i.id}/links/${linkId}`)).status).toBe(200);
		expect((await call('GET', `/issues/${i.id}`)).body.links).toEqual([]);
	});

	test('a link row must name exactly one target', async () => {
		const { raise, db } = await setup();
		const i = await raise();
		expect(() =>
			db.insert(issueLink).values({ issueId: i.id, createdAt: 'x' }).run()
		).toThrow();
	});
});

describe('execution area labels', () => {
	test('labels, boundary candidates and detail extras come from the execution area', async () => {
		const { raise, call } = await setup();
		const i = await raise({ containment: 'step', executionId: 4, raisedStepId: 11 });
		expect(i.execution).toEqual({ id: 4, label: null, procedureId: null, procedureName: null });
		expect((await call('GET', `/issues/${i.id}/steps`)).body).toEqual([]);
		issueHooks.describe = () => ({
			executions: new Map([[4, { id: 4, label: 'WO-9', procedureId: 2, procedureName: 'Torque' }]]),
			steps: new Map([[11, '3.7']])
		});
		issueHooks.stepOptions = () => [{ id: 11, label: '3.7', title: 'Torque bolts' }];
		issueHooks.detailExtras = () => ({
			raisedOpOrder: 3,
			risks: [{ riskId: 1, riskNumber: 'RISK-00001', title: 'Cold solder', relation: 'mitigation' }],
			redlineOps: []
		});
		const d = (await call('GET', `/issues/${i.id}`)).body;
		expect(d.execution.label).toBe('WO-9');
		expect(d.raisedStepLabel).toBe('3.7');
		expect(d.raisedOpOrder).toBe(3);
		expect(d.risks[0].riskNumber).toBe('RISK-00001');
		expect((await call('GET', `/issues/${i.id}/steps`)).body).toHaveLength(1);
		const hold = (await call('GET', `/issues/${i.id}/holding`)).body;
		expect(hold[0].label).toBe('3.7 COMPLETE');
		expect((await call('GET', '/issues')).body.items[0].execution.label).toBe('WO-9');
	});
});

describe('detail', () => {
	test('the viewer gate flags and reasons come with the issue', async () => {
		const { raise, call, as, plain } = await setup();
		const i = await raise();
		const admin = (await call('GET', `/issues/${i.id}`)).body;
		expect([admin.canDisposition, admin.canApprove, admin.gateReasons]).toEqual([true, true, {}]);
		as(plain);
		const r = (await call('GET', `/issues/${i.id}`)).body;
		expect([r.canDisposition, r.canApprove]).toEqual([false, false]);
		expect(r.gateReasons.disposition).toBeTruthy();
		expect(r.gateReasons.approve).toBeTruthy();
	});
});

describe('notifications', () => {
	test('the platform inbox receives the notification for the assignee', async () => {
		const { raise, other, db } = await setup();
		const i = await raise({ assignedToId: other.id, priority: 'critical' });
		const { notification } = await import('../../src/db/schema/index.ts');
		const rows = db.select().from(notification).all();
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			userId: other.id,
			kind: 'issue_assigned',
			priority: 'critical',
			href: `/issues/${i.id}`,
			subjectType: 'issue',
			subjectId: i.id
		});
	});

	const capture = () => {
		const sent: IssueNotification[] = [];
		issueHooks.deliver = (_c, n) => sent.push(n);
		return sent;
	};

	test('assignment tells the new assignee, not the actor', async () => {
		const { raise, call, other, admin } = await setup();
		const sent = capture();
		await raise({ assignedToId: admin.id });
		expect(sent).toEqual([]);
		const i = await raise({ assignedToId: other.id, priority: 'high' });
		expect(sent).toHaveLength(1);
		expect(sent[0]).toMatchObject({ kind: 'issue_assigned', recipients: [other.id], priority: 'high', href: `/issues/${i.id}` });
		await call('PATCH', `/issues/${i.id}`, { assignedToId: admin.id });
		expect(sent).toHaveLength(1);
		await call('PATCH', `/issues/${i.id}`, { assignedToId: other.id });
		expect(sent).toHaveLength(2);
	});

	test('a comment tells the assignee and the raiser except the commenter', async () => {
		const { raise, call, as, other, admin } = await setup();
		const i = await raise({ assignedToId: other.id });
		const sent = capture();
		as(other);
		await call('POST', `/issues/${i.id}/comments`, { body: 'looking now' });
		expect(sent).toHaveLength(1);
		expect(sent[0]).toMatchObject({ kind: 'issue_commented', recipients: [admin.id], title: 'BEN commented on IT-00001', body: 'looking now' });
	});

	test('a disposition tells the audience and a close tells them too', async () => {
		const { raise, call, sign, as, other, admin } = await setup();
		const i = await raise({ containment: 'wo', assignedToId: other.id });
		const sent = capture();
		await sign(i.id, 'scrap');
		expect(sent[0]).toMatchObject({ kind: 'issue_dispositioned', recipients: [other.id], title: 'IT-00001 dispositioned scrap' });
		as(other);
		await call('PATCH', `/issues/${i.id}`, { status: 'closed' });
		expect(sent[1]).toMatchObject({ kind: 'issue_closed', recipients: [admin.id], priority: 'normal' });
	});

	test('returning from review sends the comment notice', async () => {
		const { raise, call, as, other } = await setup();
		const i = await raise({ assignedToId: other.id });
		await call('POST', `/issues/${i.id}/start`);
		await call('POST', `/issues/${i.id}/review`);
		const sent = capture();
		await call('POST', `/issues/${i.id}/review/return`, { comment: 'redo' });
		expect(sent.map((n) => n.kind)).toEqual(['issue_commented']);
		as(other);
	});
});

describe('projects', () => {
	test('an issue needs an active project and shows its code and name', async () => {
		const { call, db, project, app } = await setup();
		const res = await app.request('/api/issues', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ title: 't' })
		});
		expect(res.status).toBe(422);
		expect((await call('POST', '/issues', { title: 't', projectId: 999 })).status).toBe(404);
		const dead = createTestProject(db, 'DEAD');
		await call('POST', `/projects/${dead.id}/archive`);
		expect((await call('POST', '/issues', { title: 't', projectId: dead.id })).status).toBe(409);
		const r = await call('POST', '/issues', { title: 't', projectId: project.id });
		expect(r.body).toMatchObject({ projectId: project.id, projectCode: 'TP', projectName: 'Project TP' });
	});

	test('the list filters by project and an issue moves to another active project', async () => {
		const { call, db, project } = await setup();
		const b = createTestProject(db, 'B');
		const a1 = (await call('POST', '/issues', { title: 'a' })).body;
		const b1 = (await call('POST', '/issues', { title: 'b', projectId: b.id })).body;
		const ids = async (q: string) => (await call('GET', `/issues${q}`)).body.items.map((x: any) => x.id);
		expect(await ids(`?projectId=${project.id}`)).toEqual([a1.id]);
		expect(await ids(`?projectId=${b.id}`)).toEqual([b1.id]);
		expect(await ids('')).toHaveLength(2);
		const moved = await call('PATCH', `/issues/${a1.id}`, { projectId: b.id });
		expect(moved.body).toMatchObject({ projectId: b.id, projectCode: 'B' });
		expect(await ids(`?projectId=${b.id}`)).toHaveLength(2);
	});
});
