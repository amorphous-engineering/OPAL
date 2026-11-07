import { describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { auditLog, partRequirement, requirement } from '../../src/db/schema/index.ts';
import { PROJECT_CONFIG_KEY } from '../../src/services/org/project.ts';
import { setSetting } from '../../src/services/org/settings.ts';
import { GOOD, setup } from './helpers.ts';
import { createTestProject } from '../helpers/project.ts'; // added by projects

const iso = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString();

describe('creating and editing', () => {
	test('a requirement gets the next REQ number, starts as a draft revision 1, and is audited', async () => {
		const { req, call, db } = await setup();
		const a = await req();
		expect(a).toMatchObject({
			reqNumber: 'REQ-0001',
			revision: 1,
			lifecycleState: 'draft',
			level: 0,
			stale: false,
			tbd: false,
			tbr: false
		});
		expect((await req()).reqNumber).toBe('REQ-0002');
		expect(db.select().from(auditLog).all().some((x) => x.entity === 'requirement' && x.action === 'create')).toBe(true);
		expect((await call('POST', '/requirements', { title: '', statement: 'x' })).status).toBe(422);
	});

	test('a child inherits level parent + 1, and an explicit level wins', async () => {
		const { req } = await setup();
		const root = await req();
		expect((await req({ parentId: root.id })).level).toBe(1);
		expect((await req({ parentId: root.id, level: 3 })).level).toBe(3);
	});

	test('an unknown parent or an unknown verification method is refused', async () => {
		const { call, req } = await setup();
		expect((await call('POST', '/requirements', { title: 't', statement: 's', parentId: 999 })).status).toBe(422);
		expect((await call('POST', '/requirements', { title: 't', statement: 's', verificationMethod: 'vibes' })).status).toBe(422);
		const r = await req();
		expect((await call('PATCH', `/requirements/${r.id}`, { verificationMethod: 'vibes' })).status).toBe(422);
	});

	test('an import that claimed a number does not collide with the counter', async () => {
		const { req, db, project } = await setup();
		const ts = new Date().toISOString();
		db.insert(requirement)
			.values({ reqNumber: 'REQ-0000000001', projectId: project.id, title: 'imported', statement: 's', createdAt: ts, updatedAt: ts })
			.run();
		expect((await req()).reqNumber).toBe('REQ-0002');
	});

	test('a draft edits in place and moves between draft and preliminary only', async () => {
		const { req, call } = await setup();
		const r = await req();
		const up = await call('PATCH', `/requirements/${r.id}`, { title: 'New title', lifecycleState: 'preliminary' });
		expect(up.status).toBe(200);
		expect(up.body).toMatchObject({ title: 'New title', lifecycleState: 'preliminary' });
		expect((await call('PATCH', `/requirements/${r.id}`, { lifecycleState: 'baselined' })).status).toBe(422);
	});

	test('an explicit null clears a nullable field; an absent key leaves it', async () => {
		const { req, call, admin } = await setup();
		const r = await req({
			category: 'safety',
			tbr: true,
			tbrOwnerId: admin.id,
			tbrDue: iso(10)
		});
		const kept = await call('PATCH', `/requirements/${r.id}`, { title: 'x' });
		expect(kept.body).toMatchObject({ category: 'safety', tbrOwnerId: admin.id });
		const cleared = await call('PATCH', `/requirements/${r.id}`, {
			category: null,
			tbrOwnerId: null,
			tbrDue: null,
			rationale: null,
			verificationMethod: null
		});
		expect(cleared.body).toMatchObject({
			category: null,
			tbrOwnerId: null,
			tbrDue: null,
			rationale: null,
			verificationMethod: null
		});
	});

	test('a parent can be cleared, but not set to the row itself or its descendant', async () => {
		const { req, call } = await setup();
		const root = await req();
		const mid = await req({ parentId: root.id });
		const leaf = await req({ parentId: mid.id });
		expect((await call('PATCH', `/requirements/${mid.id}`, { parentId: null })).body.parentId).toBeNull();
		await call('PATCH', `/requirements/${mid.id}`, { parentId: root.id });
		expect((await call('PATCH', `/requirements/${mid.id}`, { parentId: mid.id })).status).toBe(422);
		expect((await call('PATCH', `/requirements/${root.id}`, { parentId: leaf.id })).status).toBe(422);
	});

	test('a baselined requirement cannot be edited', async () => {
		const { req, call, baseline } = await setup();
		const r = await req();
		await baseline(r.id);
		const res = await call('PATCH', `/requirements/${r.id}`, { title: 'nope' });
		expect(res.status).toBe(409);
		expect(res.body.message).toContain('immutable');
	});
});

describe('baselining', () => {
	test('baseline needs a rationale, no TBD, and a TBR with owner and due date', async () => {
		const { req, call } = await setup();
		const noRationale = await req({ rationale: null });
		const r1 = await call('POST', `/requirements/${noRationale.id}/baseline`);
		expect(r1.status).toBe(409);
		expect(r1.body.message).toContain('rationale is required to baseline');
		const tbd = await req({ tbd: true });
		expect((await call('POST', `/requirements/${tbd.id}/baseline`)).body.message).toContain('TBD');
		const tbr = await req({ tbr: true });
		const r3 = await call('POST', `/requirements/${tbr.id}/baseline`);
		expect(r3.body.message).toContain('TBR requires an owner');
		expect(r3.body.message).toContain('TBR requires a closure due date');
	});

	test('baseline blocks on lint and lists every blocker', async () => {
		const { req, call } = await setup();
		const r = await req({ statement: 'The tank shall be sufficient.' });
		const res = await call('POST', `/requirements/${r.id}/baseline`);
		expect(res.status).toBe(409);
		expect(res.body.message).toContain('sufficient');
	});

	test('baseline stamps the row, locks it, and writes one event with a null label', async () => {
		const { req, call, baseline, admin } = await setup();
		const r = await req();
		const done = await baseline(r.id);
		expect(done).toMatchObject({ lifecycleState: 'baselined', baselinedById: admin.id });
		expect(done.baselinedAt).toBeTruthy();
		const events = await call('GET', '/requirements/baselines');
		expect(events.body).toHaveLength(1);
		expect(events.body[0]).toMatchObject({ label: null, signedBy: 'ABBY', locked: 1, revised: 0 });
		expect((await call('POST', `/requirements/${r.id}/baseline`)).status).toBe(409);
	});

	test('baseline, batch and reaffirm refuse an API token', async () => {
		const { req, call, as, admin, baseline } = await setup();
		const r = await req();
		as({ kind: 'token', userId: admin.id, isAdmin: true, tokenId: 1 });
		expect((await call('POST', `/requirements/${r.id}/baseline`)).status).toBe(403);
		expect((await call('POST', '/requirements/baseline-batch', { ids: [r.id] })).status).toBe(403);
		expect((await call('POST', `/requirements/${r.id}/reaffirm`)).status).toBe(403);
		// Reading stays open to a token.
		expect((await call('GET', '/requirements/queue')).status).toBe(200);
		as(admin);
		await baseline(r.id);
	});

	test('a batch baselines every item in one event with its label and note', async () => {
		const { req, call, db } = await setup();
		const a = await req();
		const b = await req();
		const res = await call('POST', '/requirements/baseline-batch', { ids: [a.id, b.id], label: 'l0-freeze', note: 'first' });
		expect(res.status).toBe(200);
		expect(res.body.label).toBe('l0-freeze');
		expect(res.body.baselined.map((x: any) => x.reqNumber)).toEqual(['REQ-0001', 'REQ-0002']);
		const events = (await call('GET', '/requirements/baselines')).body;
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({ locked: 2, note: 'first' });
		const detail = (await call('GET', `/requirements/baselines/${events[0].id}`)).body;
		expect(detail.items.map((i: any) => i.reqNumber)).toEqual(['REQ-0001', 'REQ-0002']);
		expect(db.select().from(auditLog).all().some((x) => x.entity === 'baseline_event')).toBe(true);
	});

	test('one offender aborts the whole batch and names the failing checks', async () => {
		const { req, call } = await setup();
		const good = await req();
		const bad = await req({ rationale: null });
		const res = await call('POST', '/requirements/baseline-batch', { ids: [good.id, bad.id] });
		expect(res.status).toBe(409);
		expect(res.body.fields['REQ-0002']).toContain('rationale_present');
		expect((await call('GET', `/requirements/${good.id}`)).body.lifecycleState).toBe('draft');
		expect((await call('GET', '/requirements/baselines')).body).toEqual([]);
	});

	test('repeated ids in a batch are counted once', async () => {
		const { req, call } = await setup();
		const a = await req();
		const res = await call('POST', '/requirements/baseline-batch', { ids: [a.id, a.id] });
		expect(res.status).toBe(200);
		expect(res.body.baselined).toHaveLength(1);
	});

	test('an event item points at the exact revision row it locked', async () => {
		const { req, call, baseline } = await setup();
		const r = await req();
		await baseline(r.id);
		const rev2 = (await call('POST', `/requirements/${r.id}/revise`)).body;
		await call('PATCH', `/requirements/${rev2.id}`, { statement: 'The engine shall sustain a chamber pressure of 25 bar ± 1 bar.' });
		await baseline(rev2.id);
		const events = (await call('GET', '/requirements/baselines')).body;
		expect(events[0]).toMatchObject({ locked: 1, revised: 1 });
		const detail = (await call('GET', `/requirements/baselines/${events[0].id}`)).body;
		expect(detail.items[0]).toMatchObject({ id: rev2.id, revision: 2, previousRevision: 1 });
		expect(detail.items[0].changed).toEqual(['statement']);
		expect(detail.items[0].diff.statement.some((s: any) => s.op === 'insert')).toBe(true);
		expect((await call('GET', '/requirements/baselines/999')).status).toBe(404);
	});
});

describe('revisions', () => {
	test('only a baselined row can be revised, and only once', async () => {
		const { req, call, baseline } = await setup();
		const r = await req();
		expect((await call('POST', `/requirements/${r.id}/revise`)).status).toBe(409);
		await baseline(r.id);
		const rev2 = await call('POST', `/requirements/${r.id}/revise`);
		expect(rev2.status).toBe(200);
		expect((await call('POST', `/requirements/${r.id}/revise`)).status).toBe(409);
	});

	test('a revision shares the number, bumps the revision, points at its source, and is a fresh draft', async () => {
		const { req, call, baseline } = await setup();
		const root = await req();
		const child = await req({ parentId: root.id });
		await baseline(root.id);
		const rev2 = (await call('POST', `/requirements/${root.id}/revise`)).body;
		expect(rev2).toMatchObject({
			reqNumber: root.reqNumber,
			revision: 2,
			lifecycleState: 'draft',
			supersedesId: root.id,
			stale: false
		});
		expect(child.stale).toBe(false);
		const chain = (await call('GET', `/requirements/${rev2.id}/revisions`)).body;
		expect(chain.map((x: any) => [x.revision, x.lifecycleState])).toEqual([[1, 'baselined'], [2, 'draft']]);
	});

	test('the predecessor stays in force until the revision baselines, then it is superseded', async () => {
		const { req, call, baseline } = await setup();
		const r = await req();
		await baseline(r.id);
		const rev2 = (await call('POST', `/requirements/${r.id}/revise`)).body;
		expect((await call('GET', `/requirements/${r.id}`)).body.lifecycleState).toBe('baselined');
		await baseline(rev2.id);
		expect((await call('GET', `/requirements/${r.id}`)).body.lifecycleState).toBe('superseded');
		const list = (await call('GET', '/requirements')).body;
		expect(list.items.map((x: any) => x.id)).toEqual([rev2.id]);
		const all = (await call('GET', '/requirements?includeSuperseded=true')).body;
		expect(all.items).toHaveLength(2);
		expect((await call('GET', '/requirements?state=superseded')).body.items.map((x: any) => x.id)).toEqual([r.id]);
	});

	test('the supersede and the stale flips are audited in the same operation', async () => {
		const { req, call, baseline, db } = await setup();
		const parent = await req();
		const child = await req({ parentId: parent.id });
		await baseline(parent.id);
		const rev2 = (await call('POST', `/requirements/${parent.id}/revise`)).body;
		await baseline(rev2.id);
		const rows = db.select().from(auditLog).where(eq(auditLog.entity, 'requirement')).all();
		expect(rows.some((x) => x.entityId === parent.id && x.action === 'update' && (x.after as any).lifecycleState === 'superseded')).toBe(true);
		expect(rows.some((x) => x.entityId === child.id && (x.after as any).stale === true)).toBe(true);
	});

	test('cancel works from any live state and not from a terminal one', async () => {
		const { req, call, baseline } = await setup();
		const a = await req();
		expect((await call('POST', `/requirements/${a.id}/cancel`, { reason: 'dropped' })).body.lifecycleState).toBe('cancelled');
		expect((await call('POST', `/requirements/${a.id}/cancel`, { reason: 'dropped' })).status).toBe(409);
		const b = await req();
		await baseline(b.id);
		expect((await call('POST', `/requirements/${b.id}/cancel`, { reason: 'dropped' })).body.lifecycleState).toBe('cancelled');
	});

	test('the redline defaults to the superseded revision and 404s on an unknown one', async () => {
		const { req, call, baseline } = await setup();
		const r = await req();
		await baseline(r.id);
		const rev2 = (await call('POST', `/requirements/${r.id}/revise`)).body;
		await call('PATCH', `/requirements/${rev2.id}`, { statement: 'The engine shall sustain a chamber pressure of 25 bar ± 1 bar.' });
		await baseline(rev2.id);
		const diff = (await call('GET', `/requirements/${rev2.id}/redline`)).body;
		expect([diff.revA, diff.revB]).toEqual([1, 2]);
		expect(new Set(diff.statement.map((s: any) => s.op))).toEqual(new Set(['equal', 'delete', 'insert']));
		expect((await call('GET', `/requirements/${rev2.id}/redline?revA=1&revB=2`)).status).toBe(200);
		expect((await call('GET', `/requirements/${rev2.id}/redline?revA=9`)).status).toBe(404);
	});
});

describe('staleness', () => {
	async function staleChild() {
		const s = await setup();
		const parent = await s.req();
		const child = await s.req({ parentId: parent.id });
		await s.baseline(parent.id);
		const rev2 = (await s.call('POST', `/requirements/${parent.id}/revise`)).body;
		await s.call('PATCH', `/requirements/${rev2.id}`, { statement: 'The engine shall sustain a chamber pressure of 25 bar ± 1 bar.' });
		await s.baseline(rev2.id);
		return { ...s, parent, child };
	}

	test('children go stale when the parent revision supersedes', async () => {
		const { call, child } = await staleChild();
		expect((await call('GET', `/requirements/${child.id}`)).body.stale).toBe(true);
	});

	test('baselining a first revision marks nothing stale', async () => {
		const { req, call, baseline } = await setup();
		const parent = await req();
		const child = await req({ parentId: parent.id });
		await baseline(parent.id);
		expect((await call('GET', `/requirements/${child.id}`)).body.stale).toBe(false);
	});

	test('any edit clears the stale flag', async () => {
		const { call, child } = await staleChild();
		const r = await call('PATCH', `/requirements/${child.id}`, { rationale: 'Re-derived against parent rev 2.' });
		expect(r.body.stale).toBe(false);
	});

	test('reaffirm clears the flag, is audited with the user, and refuses a row that is not stale', async () => {
		const { call, child, db, admin } = await staleChild();
		const r = await call('POST', `/requirements/${child.id}/reaffirm`);
		expect(r.status).toBe(200);
		expect(r.body.stale).toBe(false);
		const last = db.select().from(auditLog).where(eq(auditLog.entity, 'requirement')).all().filter((x) => x.entityId === child.id).at(-1)!;
		expect(last.actorUserId).toBe(admin.id);
		expect((last.after as any).stale).toBe(false);
		expect((await call('POST', `/requirements/${child.id}/reaffirm`)).status).toBe(409);
	});

	test('reaffirm works on a baselined row', async () => {
		const { call, child, baseline } = await staleChild();
		await baseline(child.id);
		expect((await call('POST', `/requirements/${child.id}/reaffirm`)).body.stale).toBe(false);
	});

	test('the flag shows in the tree, the dossier and the summary until cleared', async () => {
		const { call, child } = await staleChild();
		const tree = (await call('GET', '/requirements/tree')).body;
		expect(tree.items.find((i: any) => i.id === child.id).stale).toBe(true);
		expect((await call('GET', `/requirements/${child.id}/dossier`)).body.stale).toBe(true);
		expect((await call('GET', '/requirements/summary')).body.stale.map((x: any) => x.id)).toEqual([child.id]);
		await call('POST', `/requirements/${child.id}/reaffirm`);
		expect((await call('GET', '/requirements/summary')).body.stale).toEqual([]);
	});

	test('a new revision starts fresh, not stale', async () => {
		const { call, child, baseline } = await staleChild();
		await baseline(child.id);
		expect((await call('POST', `/requirements/${child.id}/revise`)).body.stale).toBe(false);
	});
});

describe('deleting', () => {
	test('a stillborn draft is removed; a baselined, parent or allocated row is not', async () => {
		const { req, call, baseline, mkPart } = await setup();
		const root = await req();
		const child = await req({ parentId: root.id });
		const lone = await req();
		expect((await call('DELETE', `/requirements/${root.id}`)).status).toBe(409);
		expect((await call('DELETE', `/requirements/${child.id}`)).status).toBe(200);
		expect((await call('GET', `/requirements/${child.id}`)).status).toBe(404);
		await baseline(lone.id);
		expect((await call('DELETE', `/requirements/${lone.id}`)).status).toBe(409);
		const alloc = await req();
		const p = mkPart('Bracket', 'P-1');
		await call('POST', `/requirements/parts/${p.id}`, { reqNumber: alloc.reqNumber });
		const res = await call('DELETE', `/requirements/${alloc.id}`);
		expect(res.status).toBe(409);
		expect(res.body.message).toContain('unassign');
	});

	test('a deleted number is never reused', async () => {
		const { req, call } = await setup();
		const a = await req();
		await call('DELETE', `/requirements/${a.id}`);
		expect((await req()).reqNumber).toBe('REQ-0002');
	});
});

describe('readiness and the queue', () => {
	test('a clean draft is ready with all six checks passing', async () => {
		const { req, call } = await setup();
		const r = await req();
		const res = (await call('GET', `/requirements/${r.id}/readiness`)).body;
		expect(res.ready).toBe(true);
		expect(res.checks.map((c: any) => c.key).sort()).toEqual(
			['lint_clean', 'no_tbd', 'parent_baselined', 'rationale_present', 'tbr_fields', 'verification_method'].sort()
		);
		expect(res.checks.every((c: any) => c.passed)).toBe(true);
	});

	test.each([
		[{ rationale: null }, 'rationale_present'],
		[{ tbd: true }, 'no_tbd'],
		[{ tbr: true }, 'tbr_fields'],
		[{ verificationMethod: null }, 'verification_method'],
		[{ statement: 'The engine shall maximize thrust.' }, 'lint_clean']
	])('only the %p check fails for %p', async (over, key) => {
		const { req, call } = await setup();
		const r = await req(over);
		const res = (await call('GET', `/requirements/${r.id}/readiness`)).body;
		expect(res.ready).toBe(false);
		expect(res.checks.filter((c: any) => !c.passed).map((c: any) => c.key)).toEqual([key]);
		expect(res.checks.find((c: any) => c.key === key).detail).toBeTruthy();
	});

	test('the lint check counts extra findings', async () => {
		const { req, call } = await setup();
		const r = await req({ statement: 'It maximizes performance as appropriate.' });
		const res = (await call('GET', `/requirements/${r.id}/readiness`)).body;
		expect(res.checks.find((c: any) => c.key === 'lint_clean').detail).toContain('more)');
	});

	test('an unbaselined parent warns but never blocks', async () => {
		const { req, call, baseline } = await setup();
		const parent = await req();
		const child = await req({ parentId: parent.id });
		const warn = (await call('GET', `/requirements/${child.id}/readiness`)).body;
		const check = warn.checks.find((c: any) => c.key === 'parent_baselined');
		expect(check).toMatchObject({ severity: 'warning', passed: false });
		expect(check.detail).toContain(parent.reqNumber);
		expect(warn.ready).toBe(true);
		await baseline(parent.id);
		const ok = (await call('GET', `/requirements/${child.id}/readiness`)).body;
		expect(ok.checks.find((c: any) => c.key === 'parent_baselined').passed).toBe(true);
	});

	test('a TBR passes once it has an owner and a due date', async () => {
		const { req, call, admin } = await setup();
		const r = await req({ tbr: true, tbrOwnerId: admin.id, tbrDue: iso(30) });
		const res = (await call('GET', `/requirements/${r.id}/readiness`)).body;
		expect(res.checks.find((c: any) => c.key === 'tbr_fields').passed).toBe(true);
		expect(res.ready).toBe(true);
	});

	test('ready is true exactly when baselining succeeds', async () => {
		const { req, call } = await setup();
		for (const over of [{}, { rationale: null }, { tbd: true }, { statement: 'The tank shall be sufficient.' }]) {
			const r = await req(over);
			const ready = (await call('GET', `/requirements/${r.id}/readiness`)).body.ready;
			const done = (await call('POST', `/requirements/${r.id}/baseline`)).status === 200;
			expect(done).toBe(ready);
		}
	});

	test('a baselined row is not ready, and has no readiness panel in the dossier', async () => {
		const { req, call, baseline } = await setup();
		const r = await req();
		await baseline(r.id);
		expect((await call('GET', `/requirements/${r.id}/readiness`)).body.ready).toBe(false);
		expect((await call('GET', `/requirements/${r.id}/dossier`)).body.readiness).toBeNull();
		expect((await call('GET', '/requirements/999/readiness')).status).toBe(404);
	});

	test('the queue is exactly the ready set, with review context', async () => {
		const { req, call, baseline } = await setup();
		const root = await req();
		const child = await req({ parentId: root.id });
		await req({ rationale: null });
		const q = (await call('GET', '/requirements/queue')).body;
		expect(q.ids).toEqual([root.id, child.id]);
		expect(q.count).toBe(2);
		const item = q.items.find((i: any) => i.id === child.id);
		expect(item.chain.map((c: any) => c.reqNumber)).toEqual([root.reqNumber]);
		expect(item.warnings[0]).toContain(root.reqNumber);
		expect(item.change).toBeNull();
		const rev = await req();
		await baseline(rev.id);
		const rev2 = (await call('POST', `/requirements/${rev.id}/revise`)).body;
		await call('PATCH', `/requirements/${rev2.id}`, { statement: 'The engine shall sustain a chamber pressure of 25 bar ± 1 bar.' });
		const q2 = (await call('GET', '/requirements/queue')).body;
		expect(q2.items.find((i: any) => i.id === rev2.id).change.revA).toBe(1);
		expect((await call('GET', '/requirements/tree')).body.queueCount).toBe(q2.count);
	});
});

describe('tree and dossier', () => {
	test('the tree nests by parent and carries lint for editable rows only', async () => {
		const { req, call, baseline } = await setup();
		const root = await req();
		const child = await req({ parentId: root.id, statement: 'The tank shall be sufficient.' });
		await baseline(root.id);
		const t = (await call('GET', '/requirements/tree')).body;
		const c = t.items.find((i: any) => i.id === child.id);
		expect(c.parentId).toBe(root.id);
		expect(c.lint.some((f: any) => f.severity === 'block_baseline')).toBe(true);
		expect(t.items.find((i: any) => i.id === root.id).lint).toEqual([]);
		expect(t.total).toBe(2);
	});

	test('a row whose parent is no longer current shows as an orphan root', async () => {
		const { req, call, baseline, db } = await setup();
		const parent = await req();
		const child = await req({ parentId: parent.id });
		await baseline(parent.id);
		const rev2 = (await call('POST', `/requirements/${parent.id}/revise`)).body;
		await baseline(rev2.id);
		// A row a revision did not carry: one from before children followed their parent.
		db.update(requirement).set({ parentId: parent.id }).where(eq(requirement.id, child.id)).run();
		const row = (await call('GET', '/requirements/tree')).body.items.find((i: any) => i.id === child.id);
		expect(row).toMatchObject({ parentId: null, orphan: true });
	});

	test('the dossier shows the flow-down chain, the children, and the delete rule', async () => {
		const { req, call, baseline } = await setup();
		const root = await req();
		const mid = await req({ parentId: root.id });
		const leaf = await req({ parentId: mid.id });
		const d = (await call('GET', `/requirements/${leaf.id}/dossier`)).body;
		expect(d.parentChain.map((p: any) => p.reqNumber)).toEqual([root.reqNumber, mid.reqNumber]);
		expect(d.canDelete).toBe(true);
		expect(d.readiness.ready).toBe(true);
		const top = (await call('GET', `/requirements/${root.id}/dossier`)).body;
		expect(top.children.map((c: any) => c.reqNumber)).toEqual([mid.reqNumber]);
		expect(top.canDelete).toBe(false);
		await baseline(leaf.id);
		const done = (await call('GET', `/requirements/${leaf.id}/dossier`)).body;
		expect(done).toMatchObject({ readiness: null, canDelete: false, lint: [] });
		expect(done.baselineEvents[0].revision).toBe(1);
		expect((await call('GET', '/requirements/9999/dossier')).status).toBe(404);
	});

	test('the dossier lists every revision of the number', async () => {
		const { req, call, baseline } = await setup();
		const r = await req();
		await baseline(r.id);
		const rev2 = (await call('POST', `/requirements/${r.id}/revise`)).body;
		const d = (await call('GET', `/requirements/${rev2.id}/dossier`)).body;
		expect(d.revisions.map((x: any) => x.revision)).toEqual([1, 2]);
		expect(d.predecessorRevision).toBe(1);
	});

	test('a requirement is found by number, and the lint operation matches the baseline gate', async () => {
		const { req, call } = await setup();
		const r = await req();
		expect((await call('GET', `/requirements/number/${r.reqNumber}`)).body.id).toBe(r.id);
		expect((await call('GET', '/requirements/number/REQ-9999')).status).toBe(404);
		const lint = (await call('POST', '/requirements/lint', { statement: 'The tank shall be sufficient.' })).body;
		expect(lint.wouldBlockBaseline).toBe(true);
		const clean = (await call('POST', '/requirements/lint', { statement: GOOD, rationale: 'because physics differs', verificationMethod: 'test' })).body;
		expect(clean.wouldBlockBaseline).toBe(false);
	});

	test('the list filters by state, level, category and text', async () => {
		const { req, call } = await setup();
		const a = await req({ category: 'safety', title: 'Alpha' });
		await req({ parentId: a.id, title: 'Beta' });
		expect((await call('GET', '/requirements?category=safety')).body.items).toHaveLength(1);
		expect((await call('GET', '/requirements?level=1')).body.items[0].title).toBe('Beta');
		expect((await call('GET', '/requirements?q=alph')).body.total).toBe(1);
		expect((await call('GET', `/requirements?parentId=${a.id}`)).body.total).toBe(1);
		const page = (await call('GET', '/requirements?limit=1')).body;
		expect(page.items).toHaveLength(1);
		expect(page.next).toBe('1');
	});
});

describe('part links', () => {
	test('a requirement is linked to a part by number and shows in the tree and dossier', async () => {
		const { req, call, mkPart } = await setup();
		const r = await req({ title: 'Feed pressure' });
		const p = mkPart('Feed Manifold', 'P-1');
		const res = await call('POST', `/requirements/parts/${p.id}`, { reqNumber: r.reqNumber.toLowerCase() });
		expect(res.status).toBe(200);
		expect(res.body).toMatchObject({ reqNumber: r.reqNumber, status: 'open', partId: p.id });
		const d = (await call('GET', `/requirements/${r.id}/dossier`)).body;
		expect(d.allocations[0]).toMatchObject({ partName: 'Feed Manifold', status: 'open' });
		expect(d.verification).toBe('open');
		expect(d.canDelete).toBe(false);
		const row = (await call('GET', '/requirements/tree')).body.items.find((i: any) => i.id === r.id);
		expect(row.parts.map((x: any) => x.name)).toEqual(['Feed Manifold']);
		expect((await call('GET', `/requirements/parts/${p.id}`)).body).toHaveLength(1);
	});

	test('an unknown number, an unknown part and a second link are refused', async () => {
		const { req, call, mkPart } = await setup();
		const r = await req();
		const p = mkPart('Bracket', 'P-1');
		expect((await call('POST', `/requirements/parts/${p.id}`, { reqNumber: 'REQ-9999' })).status).toBe(422);
		expect((await call('POST', '/requirements/parts/999', { reqNumber: r.reqNumber })).status).toBe(404);
		await call('POST', `/requirements/parts/${p.id}`, { reqNumber: r.reqNumber });
		expect((await call('POST', `/requirements/parts/${p.id}`, { reqNumber: r.reqNumber })).status).toBe(409);
	});

	test('verify stamps the caller and the time; status updates; unassign removes an unverified link', async () => {
		const { req, call, mkPart, admin } = await setup();
		const r = await req();
		const p = mkPart('Bracket', 'P-1');
		const link = (await call('POST', `/requirements/parts/${p.id}`, { reqNumber: r.reqNumber })).body;
		const v = (await call('POST', `/requirements/allocations/${link.id}/verify`, { notes: 'tested' })).body;
		expect(v).toMatchObject({ status: 'verified', notes: 'tested', verifiedBy: { id: admin.id } });
		expect(v.verifiedAt).toBeTruthy();
		expect((await call('GET', `/requirements/${r.id}/dossier`)).body.verification).toBe('verified');
		const q = mkPart('Valve', 'P-2');
		const open = (await call('POST', `/requirements/parts/${q.id}`, { reqNumber: r.reqNumber })).body;
		const u = await call('PATCH', `/requirements/allocations/${open.id}`, { status: 'waived' });
		expect(u.body.status).toBe('waived');
		expect((await call('PATCH', `/requirements/allocations/${open.id}`, { status: 'bogus' })).status).toBe(422);
		expect((await call('DELETE', `/requirements/allocations/${open.id}`)).status).toBe(200);
		expect((await call('GET', `/requirements/parts/${q.id}`)).body).toEqual([]);
		expect((await call('DELETE', `/requirements/allocations/${open.id}`)).status).toBe(404);
	});

	test('links follow the revision chain, and a verification against an old revision is outdated', async () => {
		const { req, call, mkPart, baseline, db } = await setup();
		const r = await req();
		const p = mkPart('Bracket', 'P-1');
		const link = (await call('POST', `/requirements/parts/${p.id}`, { reqNumber: r.reqNumber })).body;
		await call('POST', `/requirements/allocations/${link.id}/verify`, {});
		await baseline(r.id);
		expect((await call('GET', `/requirements/${r.id}/dossier`)).body.verification).toBe('verified');
		const rev2 = (await call('POST', `/requirements/${r.id}/revise`)).body;
		const d = (await call('GET', `/requirements/${rev2.id}/dossier`)).body;
		expect(d.allocations[0]).toMatchObject({ againstRevision: 1, status: 'verified', outdated: true });
		expect(d.verification).toBe('open');
		expect((await call('GET', '/requirements/tree')).body.items.find((i: any) => i.id === rev2.id).verification).toBe('open');
		// A new link to the same number is refused while the old one stands.
		expect((await call('POST', `/requirements/parts/${p.id}`, { reqNumber: r.reqNumber })).status).toBe(409);
		expect(db.select().from(partRequirement).all()).toHaveLength(1);
	});

	test('the roll-up reads unallocated, partial, not applicable and verified', async () => {
		const { req, call, mkPart } = await setup();
		const r = await req();
		const verification = async () => (await call('GET', `/requirements/${r.id}/dossier`)).body.verification;
		expect(await verification()).toBe('unallocated');
		const a = (await call('POST', `/requirements/parts/${mkPart('A', 'P-1').id}`, { reqNumber: r.reqNumber })).body;
		const b = (await call('POST', `/requirements/parts/${mkPart('B', 'P-2').id}`, { reqNumber: r.reqNumber })).body;
		await call('PATCH', `/requirements/allocations/${a.id}`, { status: 'not_applicable' });
		await call('PATCH', `/requirements/allocations/${b.id}`, { status: 'not_applicable' });
		expect(await verification()).toBe('not_applicable');
		await call('PATCH', `/requirements/allocations/${a.id}`, { status: 'open' });
		await call('PATCH', `/requirements/allocations/${b.id}`, { status: 'open' });
		await call('POST', `/requirements/allocations/${a.id}/verify`, {});
		expect(await verification()).toBe('partial');
		await call('POST', `/requirements/allocations/${b.id}/verify`, {});
		expect(await verification()).toBe('verified');
	});
});

describe('withdrawing a verification', () => {
	const token = (u: { id: number }) => ({ kind: 'token', userId: u.id, isAdmin: true, tokenId: 1 }) as const;

	async function verified() {
		const s = await setup();
		const r = await s.req();
		const p = s.mkPart('Bracket', 'P-1');
		const link = (await s.call('POST', `/requirements/parts/${p.id}`, { reqNumber: r.reqNumber })).body;
		await s.baseline(r.id);
		expect((await s.call('POST', `/requirements/allocations/${link.id}/verify`, {})).status).toBe(200);
		return { ...s, r, p, link, path: `/requirements/allocations/${link.id}` };
	}

	test('a verified link cannot leave verified through a status edit, by a person or a token', async () => {
		const { call, as, admin, path, r } = await verified();
		for (const status of ['open', 'waived', 'not_applicable']) {
			const refused = await call('PATCH', path, { status });
			expect(refused.status).toBe(409);
			expect(refused.body.error).toBe('use_withdraw');
		}
		as(token(admin));
		expect((await call('PATCH', path, { status: 'open' })).status).toBe(409);
		as(admin);
		expect((await call('GET', `/requirements/${r.id}/dossier`)).body.verification).toBe('verified');
	});

	test('the same holds on a draft requirement', async () => {
		const { req, call, mkPart, as, admin } = await setup();
		const r = await req();
		const link = (await call('POST', `/requirements/parts/${mkPart('B', 'P-1').id}`, { reqNumber: r.reqNumber })).body;
		await call('POST', `/requirements/allocations/${link.id}/verify`, {});
		as(token(admin));
		expect((await call('PATCH', `/requirements/allocations/${link.id}`, { status: 'open' })).status).toBe(409);
		expect((await call('POST', `/requirements/allocations/${link.id}/withdraw-verification`, { reason: 'x' })).status).toBe(403);
	});

	test('the notes of a verified link stay as verified, for a person and a token, until the verification is withdrawn', async () => {
		const { call, as, admin, path } = await verified();
		const refused = await call('PATCH', path, { notes: 'rewritten' });
		expect(refused.status).toBe(409);
		expect(refused.body.error).toBe('verified_frozen');
		as(token(admin));
		expect((await call('PATCH', path, { notes: 'rewritten' })).status).toBe(409);
		as(admin);
		expect((await call('POST', `${path}/withdraw-verification`, { reason: 'test was wrong', status: 'open' })).status).toBe(200);
		expect((await call('PATCH', path, { notes: 'rewritten' })).status).toBe(200);
	});

	test('withdrawing needs a person and a reason', async () => {
		const { call, as, admin, path } = await verified();
		expect((await call('POST', `${path}/withdraw-verification`, { reason: '  ' })).status).toBe(422);
		expect((await call('POST', `${path}/withdraw-verification`, {})).status).toBe(422);
		as(token(admin));
		expect((await call('POST', `${path}/withdraw-verification`, { reason: 'x' })).status).toBe(403);
	});

	test('a withdrawal clears the stamps and keeps who verified, who withdrew, when and why on the link', async () => {
		const { call, as, admin, plain, path, r, p } = await verified();
		as(plain);
		const w = await call('POST', `${path}/withdraw-verification`, { reason: 'test rig out of calibration' });
		expect(w.status).toBe(200);
		expect(w.body).toMatchObject({ status: 'open', verifiedAt: null, verifiedBy: null });
		const entry = { by: plain.username.toUpperCase(), reason: 'test rig out of calibration', status: 'open', verifiedBy: admin.username.toUpperCase() };
		expect(w.body.withdrawals).toMatchObject([entry]);
		expect(w.body.withdrawals[0].verifiedAt).toBeTruthy();
		expect(w.body.withdrawals[0].at).toBeTruthy();
		const d = (await call('GET', `/requirements/${r.id}/dossier`)).body;
		expect(d.verification).toBe('open');
		expect(d.allocations[0].withdrawals).toMatchObject([entry]);
		expect((await call('GET', `/requirements/parts/${p.id}`)).body[0].withdrawals).toMatchObject([entry]);
	});

	test('a withdrawal can land on waived or not applicable, and a link verified again keeps its history', async () => {
		const { call, path } = await verified();
		expect((await call('POST', `${path}/withdraw-verification`, { status: 'verified', reason: 'x' })).status).toBe(422);
		const w = await call('POST', `${path}/withdraw-verification`, { status: 'waived', reason: 'covered elsewhere' });
		expect(w.body.status).toBe('waived');
		const again = await call('POST', `${path}/verify`, {});
		expect(again.body.status).toBe('verified');
		expect(again.body.withdrawals).toHaveLength(1);
		const twice = await call('POST', `${path}/withdraw-verification`, { reason: 'second thoughts' });
		expect(twice.body.withdrawals).toHaveLength(2);
		expect((await call('POST', `${path}/withdraw-verification`, { reason: 'nothing left' })).status).toBe(409);
	});

	test('verifying a verified link is refused, so who and when cannot be replaced', async () => {
		const { call, as, plain, admin, path, p } = await verified();
		as(plain);
		expect((await call('POST', `${path}/verify`, {})).status).toBe(409);
		as(admin);
		const after = (await call('GET', `/requirements/parts/${p.id}`)).body;
		expect(after[0].verifiedBy.id).toBe(admin.id);
	});

	test('a verified link cannot be removed, and neither can one with a withdrawn verification', async () => {
		const { call, path, p } = await verified();
		const refused = await call('DELETE', path);
		expect(refused.status).toBe(409);
		expect(refused.body.error).toBe('link_verified');
		await call('POST', `${path}/withdraw-verification`, { reason: 'wrong part' });
		const kept = await call('DELETE', path);
		expect(kept.status).toBe(409);
		expect(kept.body.error).toBe('link_has_history');
		expect((await call('PATCH', path, { status: 'not_applicable' })).status).toBe(200);
		expect((await call('GET', `/requirements/parts/${p.id}`)).body).toHaveLength(1);
	});

	test('a superseded requirement keeps its verified links as they stand', async () => {
		const { call, path, r, baseline } = await verified();
		const rev2 = (await call('POST', `/requirements/${r.id}/revise`)).body;
		await baseline(rev2.id);
		expect((await call('POST', `${path}/withdraw-verification`, { reason: 'late' })).status).toBe(409);
	});
});

describe('a revision that baselines takes over from the one it supersedes', () => {
	const NEW_TEXT = 'The engine shall sustain a chamber pressure of 25 bar ± 1 bar.';

	/** A baselined requirement with `Bracket` allocated, then a new revision in draft. */
	async function revising(status: 'open' | 'verified' | 'waived' | 'not_applicable' = 'verified') {
		const s = await setup();
		const r1 = await s.req();
		const p = s.mkPart('Bracket', 'P-1');
		const link = (await s.call('POST', `/requirements/parts/${p.id}`, { reqNumber: r1.reqNumber, notes: 'load path' })).body;
		await s.baseline(r1.id);
		if (status === 'verified') await s.call('POST', `/requirements/allocations/${link.id}/verify`, {});
		else if (status !== 'open') await s.call('PATCH', `/requirements/allocations/${link.id}`, { status });
		const r2 = (await s.call('POST', `/requirements/${r1.id}/revise`)).body;
		await s.call('PATCH', `/requirements/${r2.id}`, { statement: NEW_TEXT });
		return { ...s, r1, r2, p, link };
	}
	const linkOf = (db: any, requirementId: number) =>
		db.select().from(partRequirement).where(eq(partRequirement.requirementId, requirementId)).all();

	describe('part allocations', () => {
		test('a part verified against the old text starts open on the new revision, keeps its notes, and can be verified again', async () => {
			const { call, baseline, r2, p, admin } = await revising();
			await baseline(r2.id);
			const rows = (await call('GET', `/requirements/parts/${p.id}`)).body;
			expect(rows).toHaveLength(1);
			expect(rows[0]).toMatchObject({ requirementId: r2.id, revision: 2, status: 'open', notes: 'load path', verifiedAt: null, verifiedBy: null });
			const v = await call('POST', `/requirements/allocations/${rows[0].id}/verify`, {});
			expect(v.status).toBe(200);
			expect(v.body).toMatchObject({ status: 'verified', revision: 2, verifiedBy: { id: admin.id } });
			expect((await call('GET', `/requirements/${r2.id}/dossier`)).body.verification).toBe('verified');
		});

		test('the verification on the superseded revision stays as the evidence for that text', async () => {
			const { call, baseline, db, r1, r2, link, admin } = await revising();
			const before = linkOf(db, r1.id)[0];
			await baseline(r2.id);
			expect(linkOf(db, r1.id)).toEqual([before]);
			const old = (await call('GET', `/requirements/${r1.id}/dossier`)).body;
			expect(old.verification).toBe('verified');
			expect(old.allocations).toHaveLength(1);
			expect(old.allocations[0]).toMatchObject({ id: link.id, againstRevision: 1, status: 'verified', outdated: false, previous: null });
			expect((await call('POST', `/requirements/allocations/${link.id}/verify`, {})).status).toBe(409);
			expect(before.verifiedById).toBe(admin.id);
		});

		test('the new allocation says how the part closed on the prior revision, read from that revision', async () => {
			const { call, baseline, r2 } = await revising();
			await baseline(r2.id);
			const d = (await call('GET', `/requirements/${r2.id}/dossier`)).body;
			expect(d.allocations).toHaveLength(1);
			expect(d.allocations[0]).toMatchObject({ againstRevision: 2, status: 'open', outdated: false });
			expect(d.allocations[0].previous).toMatchObject({ revision: 1, status: 'verified', verifiedBy: 'ABBY' });
			expect(d.allocations[0].previous.verifiedAt).toBeTruthy();
			expect(d.verification).toBe('open');
		});

		test('a waiver does not carry either: the part starts open', async () => {
			const { call, baseline, r2, p } = await revising('waived');
			await baseline(r2.id);
			expect((await call('GET', `/requirements/parts/${p.id}`)).body[0]).toMatchObject({ revision: 2, status: 'open' });
			expect((await call('GET', `/requirements/${r2.id}/dossier`)).body.allocations[0].previous).toMatchObject({ revision: 1, status: 'waived', verifiedBy: null });
		});

		test('a link marked not applicable stays behind, and the part can still be allocated by hand', async () => {
			const { call, baseline, db, r1, r2, p } = await revising('not_applicable');
			await baseline(r2.id);
			expect(linkOf(db, r2.id)).toEqual([]);
			expect((await call('GET', `/requirements/${r2.id}/dossier`)).body.verification).toBe('unallocated');
			expect((await call('POST', `/requirements/parts/${p.id}`, { reqNumber: r1.reqNumber })).status).toBe(200);
		});

		test('a carried allocation is written through the audit, by the baseline operation', async () => {
			const { baseline, db, r2, admin } = await revising();
			await baseline(r2.id);
			const created = db.select().from(auditLog).where(eq(auditLog.entity, 'part_requirement')).all().filter((x) => x.action === 'create').at(-1)!;
			expect(created.op).toBe('requirements.baseline');
			expect(created.actorUserId).toBe(admin.id);
			expect((created.after as any).requirementId).toBe(r2.id);
		});

		test('a batch baseline carries allocations the same way', async () => {
			const { call, db, r2 } = await revising();
			expect((await call('POST', '/requirements/baseline-batch', { ids: [r2.id] })).status).toBe(200);
			expect(linkOf(db, r2.id).map((l: any) => l.status)).toEqual(['open']);
		});

		test('the second revision to baseline carries from the first, not from further back', async () => {
			const { call, baseline, db, r2 } = await revising();
			await baseline(r2.id);
			const r3 = (await call('POST', `/requirements/${r2.id}/revise`)).body;
			await baseline(r3.id);
			expect(linkOf(db, r3.id)).toHaveLength(1);
			expect((await call('GET', `/requirements/${r3.id}/dossier`)).body.allocations[0].previous).toBeNull();
		});

		test('a person can remove a carried allocation, and it stays gone from the new revision', async () => {
			const { call, baseline, db, r1, r2, p } = await revising();
			await baseline(r2.id);
			const carried = (await call('GET', `/requirements/parts/${p.id}`)).body[0];
			expect((await call('DELETE', `/requirements/allocations/${carried.id}`)).status).toBe(200);
			expect((await call('GET', `/requirements/${r2.id}/dossier`)).body.verification).toBe('unallocated');
			expect(linkOf(db, r1.id)).toHaveLength(1);
			const left = (await call('GET', `/requirements/parts/${p.id}`)).body;
			expect(left.map((x: any) => [x.revision, x.lifecycleState])).toEqual([[1, 'superseded']]);
		});
	});

	describe('views count a part once', () => {
		test('the tree, the summary and the part page each see the part once, as open, until it is verified again', async () => {
			const { call, baseline, r2, p } = await revising();
			await baseline(r2.id);
			const item = (await call('GET', '/requirements/tree')).body.items.find((i: any) => i.id === r2.id);
			expect(item.parts).toEqual([{ partId: p.id, name: 'Bracket', status: 'open' }]);
			expect(item.verification).toBe('open');
			const s = (await call('GET', '/requirements/summary')).body;
			expect(s.total).toBe(1);
			expect(s.verification).toMatchObject({ open: 1, verified: 0 });
			expect(s.coverage).toMatchObject({ leaves: 1, leavesAllocated: 1 });
			const [link] = (await call('GET', `/requirements/parts/${p.id}`)).body;
			await call('POST', `/requirements/allocations/${link.id}/verify`, {});
			expect((await call('GET', '/requirements/summary')).body.verification).toMatchObject({ open: 0, verified: 1 });
		});

		test('a part counts as one requirement among what references it, across revisions', async () => {
			const { call, baseline, r2, p } = await revising();
			await baseline(r2.id);
			expect((await call('GET', `/parts/${p.id}/detail`)).body.references.requirement_allocations).toBe(1);
		});
	});

	describe('a draft revision changes nothing until it baselines', () => {
		test('the baseline in force keeps its allocation, which a person can still verify and which does not carry as verified', async () => {
			const { call, baseline, db, r1, r2, link } = await revising('open');
			expect(linkOf(db, r2.id)).toEqual([]);
			expect((await call('GET', `/requirements/${r1.id}`)).body.allocationCount).toBe(1);
			expect((await call('POST', `/requirements/allocations/${link.id}/verify`, {})).status).toBe(200);
			await baseline(r2.id);
			expect(linkOf(db, r1.id)[0].status).toBe('verified');
			expect(linkOf(db, r2.id)[0].status).toBe('open');
		});

		test('the draft shows the allocations of the baseline in force, and a draft with no links of its own can be deleted', async () => {
			const { call, db, r1, r2, p } = await revising();
			const d = (await call('GET', `/requirements/${r2.id}/dossier`)).body;
			expect(d.allocations).toHaveLength(1);
			expect(d.allocations[0]).toMatchObject({ againstRevision: 1, outdated: true, previous: null });
			expect(d.canDelete).toBe(true);
			expect((await call('DELETE', `/requirements/${r2.id}`)).status).toBe(200);
			expect((await call('GET', `/requirements/${r1.id}/dossier`)).body.verification).toBe('verified');
			expect(linkOf(db, r1.id)).toHaveLength(1);
			expect((await call('GET', `/requirements/parts/${p.id}`)).body[0]).toMatchObject({ requirementId: r1.id, status: 'verified' });
		});

		test('a part allocated during the draft stands on the draft, not on the baseline in force, and is not doubled at baseline', async () => {
			const { call, baseline, mkPart, db, r1, r2 } = await revising();
			const q = mkPart('Valve', 'P-2');
			const added = await call('POST', `/requirements/parts/${q.id}`, { reqNumber: r1.reqNumber });
			expect(added.body).toMatchObject({ requirementId: r2.id, revision: 2 });
			const inForce = (await call('GET', `/requirements/${r1.id}/dossier`)).body;
			expect(inForce.allocations.map((a: any) => a.partName)).toEqual(['Bracket']);
			expect(inForce.verification).toBe('verified');
			const draft = (await call('GET', `/requirements/${r2.id}/dossier`)).body;
			expect(draft.allocations.map((a: any) => [a.partName, a.againstRevision])).toEqual([['Bracket', 1], ['Valve', 2]]);
			expect((await call('GET', '/requirements/queue')).body.items.find((i: any) => i.id === r2.id).parts).toEqual(['Bracket', 'Valve']);
			await baseline(r2.id);
			expect(linkOf(db, r2.id)).toHaveLength(2);
			expect((await call('GET', `/requirements/${r2.id}/dossier`)).body.allocations.map((a: any) => a.partName)).toEqual(['Bracket', 'Valve']);
		});

		test('a part on the baseline in force cannot be allocated a second time through the draft', async () => {
			const { call, db, r1, r2, p } = await revising();
			const res = await call('POST', `/requirements/parts/${p.id}`, { reqNumber: r1.reqNumber });
			expect(res.status).toBe(409);
			expect(res.body.error).toBe('duplicate');
			expect(linkOf(db, r2.id)).toEqual([]);
		});

		test('the summary counts both live rows but rolls up coverage and verification once while the next revision is in draft', async () => {
			const { call } = await revising();
			const s = (await call('GET', '/requirements/summary')).body;
			expect(s.total).toBe(2);
			expect(s.byState).toEqual({ baselined: 1, draft: 1 });
			expect(s.verification).toMatchObject({ verified: 1, open: 0 });
			expect(s.coverage).toMatchObject({ leaves: 1, leavesAllocated: 1, withVerificationMethod: 2 });
		});

		test('a cancelled draft revision carries nothing, and the part stays on the baseline in force', async () => {
			const { call, db, r1, r2, link } = await revising('open');
			await call('POST', `/requirements/${r2.id}/cancel`, { reason: 'wrong direction' });
			expect(linkOf(db, r2.id)).toEqual([]);
			expect((await call('GET', `/requirements/${r1.id}`)).body.lifecycleState).toBe('baselined');
			expect((await call('POST', `/requirements/allocations/${link.id}/verify`, {})).status).toBe(200);
		});
	});

	describe('a revision superseded before allocations carried', () => {
		/** The state an older database holds: the link only on the superseded row. */
		async function older() {
			const s = await revising();
			await s.baseline(s.r2.id);
			s.db.delete(partRequirement).where(eq(partRequirement.requirementId, s.r2.id)).run();
			return s;
		}

		test('a person can allocate the part again, and verify it against the current revision', async () => {
			const { call, r1, r2, p, link } = await older();
			const again = await call('POST', `/requirements/parts/${p.id}`, { reqNumber: r1.reqNumber });
			expect(again.status).toBe(200);
			expect(again.body).toMatchObject({ requirementId: r2.id, status: 'open' });
			expect((await call('POST', `/requirements/allocations/${again.body.id}/verify`, {})).status).toBe(200);
			expect((await call('GET', `/requirements/parts/${p.id}`)).body.map((x: any) => x.requirementId)).toEqual([r2.id]);
			expect((await call('GET', `/requirements/${r1.id}/dossier`)).body.allocations.map((a: any) => a.id)).toEqual([link.id]);
		});

		test('the part page shows the old link as superseded, and the current revision does not claim it', async () => {
			const { call, r1, r2, p } = await older();
			expect((await call('GET', `/requirements/parts/${p.id}`)).body[0]).toMatchObject({ requirementId: r1.id, lifecycleState: 'superseded', status: 'verified' });
			const d = (await call('GET', `/requirements/${r2.id}/dossier`)).body;
			expect(d.allocations).toEqual([]);
			expect(d.verification).toBe('unallocated');
		});
	});

	describe('children', () => {
		async function withChild() {
			const s = await setup();
			const parent = await s.req();
			const child = await s.req({ parentId: parent.id });
			await s.baseline(parent.id);
			const rev2 = (await s.call('POST', `/requirements/${parent.id}/revise`)).body;
			return { ...s, parent, child, rev2 };
		}

		test('a child stays where it is while the parent revision is a draft', async () => {
			const { call, child, parent } = await withChild();
			expect((await call('GET', `/requirements/${child.id}`)).body).toMatchObject({ parentId: parent.id, stale: false });
		});

		test('a child moves to the new revision and stays stale, and the tree nests it there', async () => {
			const { call, baseline, child, rev2 } = await withChild();
			await baseline(rev2.id);
			expect((await call('GET', `/requirements/${child.id}`)).body).toMatchObject({ parentId: rev2.id, stale: true });
			const row = (await call('GET', '/requirements/tree')).body.items.find((i: any) => i.id === child.id);
			expect(row).toMatchObject({ parentId: rev2.id, orphan: false, stale: true });
			const d = (await call('GET', `/requirements/${rev2.id}/dossier`)).body;
			expect(d.children.map((c: any) => [c.id, c.stale])).toEqual([[child.id, true]]);
			expect((await call('GET', `/requirements/${child.id}/dossier`)).body.parentChain.map((p: any) => p.id)).toEqual([rev2.id]);
		});

		test('the move is audited on the child, by the baseline operation', async () => {
			const { baseline, db, child, parent, rev2 } = await withChild();
			await baseline(rev2.id);
			const row = db.select().from(auditLog).where(eq(auditLog.entity, 'requirement')).all().filter((x) => x.entityId === child.id).at(-1)!;
			expect(row.op).toBe('requirements.baseline');
			expect(row.before).toMatchObject({ parentId: parent.id, stale: false });
			expect(row.after).toMatchObject({ parentId: rev2.id, stale: true });
		});

		test('a person clears the flag by re-affirming or editing, not the move itself', async () => {
			const { call, baseline, req, parent, child, rev2 } = await withChild();
			const other = await req({ parentId: parent.id, title: 'Other child' });
			await baseline(rev2.id);
			expect((await call('POST', `/requirements/${child.id}/reaffirm`)).body).toMatchObject({ parentId: rev2.id, stale: false });
			expect((await call('PATCH', `/requirements/${other.id}`, { rationale: 'Re-derived against rev 2.' })).body).toMatchObject({ parentId: rev2.id, stale: false });
		});

		test('a baselined child and its draft revision both follow; a superseded or cancelled child keeps the parent it had', async () => {
			const { call, req, baseline, parent, rev2 } = await withChild();
			const old = await req({ parentId: parent.id, title: 'Superseded child' });
			await baseline(old.id);
			const newer = (await call('POST', `/requirements/${old.id}/revise`)).body;
			await baseline(newer.id);
			const inDraft = (await call('POST', `/requirements/${newer.id}/revise`)).body;
			const struck = await req({ parentId: parent.id, title: 'Struck child' });
			await call('POST', `/requirements/${struck.id}/cancel`, { reason: 'dropped' });
			await baseline(rev2.id);
			const got = async (id: number) => (await call('GET', `/requirements/${id}`)).body;
			expect(await got(newer.id)).toMatchObject({ parentId: rev2.id, stale: true, lifecycleState: 'baselined' });
			expect(await got(inDraft.id)).toMatchObject({ parentId: rev2.id, stale: true, lifecycleState: 'draft' });
			expect(await got(old.id)).toMatchObject({ parentId: parent.id, stale: false, lifecycleState: 'superseded' });
			expect(await got(struck.id)).toMatchObject({ parentId: parent.id, stale: false, lifecycleState: 'cancelled' });
		});

		test('a baseline event does not report a parent change because the parent was later revised', async () => {
			const { call, baseline, child, rev2 } = await withChild();
			await baseline(child.id);
			const next = (await call('POST', `/requirements/${child.id}/revise`)).body;
			await call('PATCH', `/requirements/${next.id}`, { statement: NEW_TEXT });
			await baseline(next.id);
			const event = (await call('GET', '/requirements/baselines')).body[0];
			await baseline(rev2.id);
			expect((await call('GET', `/requirements/${next.id}`)).body.parentId).toBe(rev2.id);
			expect((await call('GET', `/requirements/baselines/${event.id}`)).body.items[0].changed).toEqual(['statement']);
		});

		test('a real change of parent is still reported on the event', async () => {
			const { call, baseline, req, child } = await withChild();
			const other = await req({ title: 'Other parent' });
			await baseline(child.id);
			const next = (await call('POST', `/requirements/${child.id}/revise`)).body;
			await call('PATCH', `/requirements/${next.id}`, { parentId: other.id });
			await baseline(next.id);
			const event = (await call('GET', '/requirements/baselines')).body[0];
			expect((await call('GET', `/requirements/baselines/${event.id}`)).body.items[0].changed).toEqual(['parent']);
		});

		test('a revision cannot be parented under its own number or anything that flows from it', async () => {
			const { call, req, baseline, child, parent, rev2 } = await withChild();
			expect((await call('PATCH', `/requirements/${rev2.id}`, { parentId: parent.id })).status).toBe(422);
			expect((await call('PATCH', `/requirements/${rev2.id}`, { parentId: child.id })).status).toBe(422);
			const leaf = await req({ parentId: child.id, title: 'Leaf' });
			expect((await call('PATCH', `/requirements/${rev2.id}`, { parentId: leaf.id })).status).toBe(422);
			await baseline(rev2.id);
			expect((await call('GET', `/requirements/${rev2.id}`)).body.parentId).toBeNull();
		});

		test('a child cannot be parented under a number whose draft revision already sits below it', async () => {
			const { call, req, baseline, parent } = await setup().then(async (s) => {
				const parent = await s.req();
				await s.baseline(parent.id);
				return { ...s, parent };
			});
			const c = await req({ title: 'Would close the loop' });
			const rev2 = (await call('POST', `/requirements/${parent.id}/revise`)).body;
			expect((await call('PATCH', `/requirements/${rev2.id}`, { parentId: c.id })).status).toBe(200);
			expect((await call('PATCH', `/requirements/${c.id}`, { parentId: parent.id })).status).toBe(422);
			await baseline(rev2.id);
			expect((await call('GET', `/requirements/${c.id}`)).body.parentId).toBeNull();
		});
	});
});

describe('dashboard', () => {
	test('the summary rolls up coverage, verification and what is red', async () => {
		const { req, call, mkPart } = await setup();
		const root = await req();
		const leaf = await req({ parentId: root.id });
		await req({ tbr: true, tbrDue: iso(-3) });
		const p = mkPart('Feed Manifold', 'P-1');
		await call('POST', `/requirements/parts/${p.id}`, { reqNumber: leaf.reqNumber });
		const s = (await call('GET', '/requirements/summary')).body;
		expect(s.total).toBe(3);
		expect(s.byState).toEqual({ draft: 3 });
		expect(s.coverage).toMatchObject({ leaves: 2, leavesAllocated: 1, withVerificationMethod: 3 });
		expect(s.verification).toMatchObject({ open: 1, unallocated: 2 });
		expect(s.overdueTbrs).toHaveLength(1);
		expect(s.overdueTbrs[0]).toMatchObject({ owner: '(no owner)', daysOver: 3 });
	});

	test('only past-due TBRs on live rows are overdue, and the owner is named', async () => {
		const { req, call, admin } = await setup();
		await req({ tbr: true, tbrOwnerId: admin.id, tbrDue: iso(-5) });
		await req({ tbr: true, tbrDue: iso(5) });
		await req();
		const cancelled = await req({ tbr: true, tbrDue: iso(-5) });
		await call('POST', `/requirements/${cancelled.id}/cancel`, { reason: 'dropped' });
		const s = (await call('GET', '/requirements/summary')).body;
		expect(s.overdueTbrs.map((o: any) => [o.reqNumber, o.owner])).toEqual([['REQ-0001', 'ABBY']]);
	});

	test('a draft with block lint is stuck only after seven days', async () => {
		const { req, call, db } = await setup();
		const stuck = await req({ statement: 'The tank shall be sufficient.' });
		await req({ statement: 'The pump shall be adequate.' });
		const cleanOld = await req();
		const old = new Date(Date.now() - 10 * 86_400_000).toISOString();
		for (const r of [stuck, cleanOld]) {
			db.update(requirement).set({ createdAt: old }).where(eq(requirement.id, r.id)).run();
		}
		const s = (await call('GET', '/requirements/summary')).body;
		expect(s.stuckDrafts.map((x: any) => x.id)).toEqual([stuck.id]);
	});
});

describe('catalog import', () => {
	const catalog = [
		{ id: 'REQ-0007', title: 'Pressure', description: 'The tank shall hold 5 bar.', category: 'safety' },
		{ id: 'REQ-0008', title: 'Mass', description: '', category: '' }
	];

	test('the project catalog becomes level-0 drafts, skipping numbers that exist', async () => {
		const { call, db, req, project } = await setup();
		setSetting({ db, actor: { kind: 'system' }, op: 'test' }, PROJECT_CONFIG_KEY, JSON.stringify({ name: 'P', requirements: catalog }));
		const first = await call('POST', '/requirements/import', { projectId: project.id });
		expect(first.status).toBe(200);
		expect(first.body).toEqual({ created: ['REQ-0007', 'REQ-0008'], skipped: [] });
		const again = await call('POST', '/requirements/import', { projectId: project.id });
		expect(again.body).toEqual({ created: [], skipped: ['REQ-0007', 'REQ-0008'] });
		const r = (await call('GET', '/requirements/number/REQ-0007')).body;
		expect(r).toMatchObject({ lifecycleState: 'draft', level: 0, statement: 'The tank shall hold 5 bar.', category: 'safety' });
		// No statement: the title stands in.
		expect((await call('GET', '/requirements/number/REQ-0008')).body).toMatchObject({ statement: 'Mass', category: null });
		expect((await req()).reqNumber).toBe('REQ-0001');
	});

	test('the import goes into the chosen project and refuses an archived or unknown one', async () => {
		const { call, db, project } = await setup();
		setSetting({ db, actor: { kind: 'system' }, op: 'test' }, PROJECT_CONFIG_KEY, JSON.stringify({ name: 'P', requirements: catalog }));
		const other = createTestProject(db, 'OTHER');
		expect((await call('POST', '/requirements/import', { projectId: 999 })).status).toBe(404);
		await call('POST', `/projects/${other.id}/archive`, { reason: 'Test' });
		expect((await call('POST', '/requirements/import', { projectId: other.id })).status).toBe(409);
		expect((await call('POST', '/requirements/import', {})).status).toBe(422);
		await call('POST', '/requirements/import', { projectId: project.id });
		expect((await call('GET', '/requirements/number/REQ-0007')).body).toMatchObject({ projectId: project.id, projectCode: 'TP' });
	});

	test('a catalog number typed at any width is stored once and found at any width', async () => {
		const { call, db, project } = await setup();
		setSetting(
			{ db, actor: { kind: 'system' }, op: 'test' },
			PROJECT_CONFIG_KEY,
			JSON.stringify({ name: 'P', requirements: [{ id: 'REQ-001', title: 'A' }, { id: 'req-00000002', title: 'B' }] })
		);
		expect((await call('GET', '/requirements/catalog')).body.map((x: any) => x.reqNumber)).toEqual(['REQ-0001', 'REQ-0002']);
		const first = await call('POST', '/requirements/import', { projectId: project.id });
		expect(first.body).toEqual({ created: ['REQ-0001', 'REQ-0002'], skipped: [] });
		expect(db.select().from(requirement).all().map((r) => r.reqNumber)).toEqual(['REQ-0000000001', 'REQ-0000000002']);
		expect((await call('POST', '/requirements/import', { projectId: project.id })).body.skipped).toEqual(['REQ-0001', 'REQ-0002']);
		for (const n of ['REQ-1', 'REQ-0001', 'REQ-00001', 'REQ-0000000001'])
			expect((await call('GET', `/requirements/number/${n}`)).body).toMatchObject({ reqNumber: 'REQ-0001', title: 'A' });
	});

	test('import needs the admin gate and a catalog', async () => {
		const { call, as, plain, project } = await setup();
		expect((await call('POST', '/requirements/import', { projectId: project.id })).status).toBe(404);
		as(plain);
		expect((await call('POST', '/requirements/import', { projectId: project.id })).status).toBe(403);
	});
});

describe('catalog status', () => {
	test('the pending catalog lists entries without a requirement, and is empty before setup', async () => {
		const { call, db, project } = await setup();
		expect((await call('GET', '/requirements/catalog')).body).toEqual([]);
		setSetting(
			{ db, actor: { kind: 'system' }, op: 'test' },
			PROJECT_CONFIG_KEY,
			JSON.stringify({ name: 'P', requirements: [{ id: 'REQ-0007', title: 'A' }, { id: 'REQ-0008', title: 'B' }] })
		);
		expect((await call('GET', '/requirements/catalog')).body.map((x: any) => x.reqNumber)).toEqual(['REQ-0007', 'REQ-0008']);
		await call('POST', '/requirements/import', { projectId: project.id });
		expect((await call('GET', '/requirements/catalog')).body).toEqual([]);
	});
});

describe('projects', () => {
	test('a requirement needs an active project and shows its code and name', async () => {
		const { call, db, project } = await setup();
		expect((await call('POST', '/requirements', { title: 't', statement: 's', projectId: 999 })).status).toBe(404);
		const dead = createTestProject(db, 'DEAD');
		await call('POST', `/projects/${dead.id}/archive`, { reason: 'Test' });
		expect((await call('POST', '/requirements', { title: 't', statement: 's', projectId: dead.id })).status).toBe(409);
		const r = await call('POST', '/requirements', { title: 't', statement: 's', projectId: project.id });
		expect(r.body).toMatchObject({ projectId: project.id, projectCode: 'TP', projectName: 'Project TP' });
	});

	test('a create without projectId is refused', async () => {
		const { app } = await setup();
		const res = await app.request('/api/requirements', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ title: 't', statement: 's' })
		});
		expect(res.status).toBe(422);
	});

	test('the list, tree, queue and summary narrow to one project; numbers stay org-wide unique', async () => {
		const { call, req, db, project } = await setup();
		const b = createTestProject(db, 'B');
		const a1 = await req();
		const b1 = await req({ projectId: b.id });
		expect(a1.reqNumber).not.toBe(b1.reqNumber);
		const list = (q: string) => call('GET', `/requirements${q}`).then((r) => r.body.items.map((x: any) => x.id));
		expect(await list(`?projectId=${project.id}`)).toEqual([a1.id]);
		expect(await list(`?projectId=${b.id}`)).toEqual([b1.id]);
		expect(await list('')).toHaveLength(2);
		expect((await call('GET', `/requirements/tree?projectId=${b.id}`)).body.items.map((x: any) => x.id)).toEqual([b1.id]);
		expect((await call('GET', '/requirements/tree')).body.items).toHaveLength(2);
		expect((await call('GET', `/requirements/summary?projectId=${b.id}`)).body.total).toBe(1);
		expect((await call('GET', `/requirements/queue?projectId=${project.id}`)).body.ids).toEqual([a1.id]);
	});

	test('a child must sit in the parent project', async () => {
		const { call, req, db } = await setup();
		const b = createTestProject(db, 'B');
		const root = await req();
		const r = await call('POST', '/requirements', { title: 't', statement: 's', parentId: root.id, projectId: b.id });
		expect(r.status).toBe(422);
		const lone = await req({ projectId: b.id });
		expect((await call('PATCH', `/requirements/${lone.id}`, { parentId: root.id })).status).toBe(422);
	});

	test('a requirement moves to another project only without flow-down links', async () => {
		const { call, req, db, project } = await setup();
		const b = createTestProject(db, 'B');
		const root = await req();
		const child = await req({ parentId: root.id });
		expect((await call('PATCH', `/requirements/${root.id}`, { projectId: b.id })).status).toBe(409);
		expect((await call('PATCH', `/requirements/${child.id}`, { projectId: b.id })).status).toBe(409);
		const lone = await req();
		const moved = await call('PATCH', `/requirements/${lone.id}`, { projectId: b.id });
		expect(moved.body).toMatchObject({ projectId: b.id, projectCode: 'B' });
		expect((await call('GET', `/requirements/${root.id}`)).body.projectId).toBe(project.id);
	});

	test('a draft revision cannot carry its baselined predecessor to another project', async () => {
		const { call, req, db, project, baseline } = await setup();
		const b = createTestProject(db, 'B');
		const r1 = await req();
		await baseline(r1.id);
		const r2 = (await call('POST', `/requirements/${r1.id}/revise`)).body;
		const moved = await call('PATCH', `/requirements/${r2.id}`, { projectId: b.id });
		expect(moved.status).toBe(409);
		expect((await call('GET', `/requirements/${r1.id}`)).body.projectId).toBe(project.id);
		expect((await call('GET', `/requirements/${r2.id}`)).body.projectId).toBe(project.id);
		expect((await call('GET', `/requirements/baselines?projectId=${project.id}`)).body).toHaveLength(1);
		// The draft itself still edits.
		expect((await call('PATCH', `/requirements/${r2.id}`, { title: 'Sharper' })).status).toBe(200);
	});

	test('a baseline event belongs to one project and a mixed batch is refused', async () => {
		const { call, req, db, project } = await setup();
		const b = createTestProject(db, 'B');
		const ready = { rationale: 'because', verificationMethod: 'test' };
		const a1 = await req(ready);
		const b1 = await req({ ...ready, projectId: b.id });
		expect((await call('POST', '/requirements/baseline-batch', { ids: [a1.id, b1.id] })).status).toBe(422);
		const ok = await call('POST', '/requirements/baseline-batch', { ids: [a1.id] });
		expect(ok.status).toBe(200);
		const ev = (await call('GET', `/requirements/baselines?projectId=${project.id}`)).body;
		expect(ev).toHaveLength(1);
		expect(ev[0]).toMatchObject({ projectId: project.id, projectCode: 'TP' });
		expect((await call('GET', `/requirements/baselines?projectId=${b.id}`)).body).toHaveLength(0);
	});

	test('a revision stays in the project of its predecessor', async () => {
		const { call, req, db } = await setup();
		const b = createTestProject(db, 'B');
		const r = await req({ projectId: b.id });
		await call('POST', `/requirements/${r.id}/baseline`);
		const rev = await call('POST', `/requirements/${r.id}/revise`);
		expect(rev.body).toMatchObject({ revision: 2, projectId: b.id });
	});
});

describe('statement and rationale length caps', () => {
	const long = 'x'.repeat(4001);

	test('a statement over the cap is refused on lint, create and update', async () => {
		const { call } = await setup();
		expect((await call('POST', '/requirements/lint', { statement: long })).status).toBe(422);
		expect((await call('POST', '/requirements', { title: 't', statement: long })).status).toBe(422);
		const made = await call('POST', '/requirements', { title: 't', statement: 'The x shall y.' });
		expect(made.status).toBe(201);
		expect((await call('PATCH', `/requirements/${made.body.id}`, { statement: long })).status).toBe(422);
	});

	test('a rationale over the cap is refused', async () => {
		const { call } = await setup();
		const r = 'x'.repeat(10_001);
		expect((await call('POST', '/requirements', { title: 't', statement: 's', rationale: r })).status).toBe(422);
		expect((await call('POST', '/requirements/lint', { statement: 's', rationale: r })).status).toBe(422);
	});
});

describe('cancelling and recording verification are a person\'s acts', () => {
	const token = (u: { id: number }) => ({ kind: 'token', userId: u.id, isAdmin: true, tokenId: 1 }) as const;

	test('cancelling needs a reason, a person, and keeps who, when and why', async () => {
		const { req, call, as, admin } = await setup();
		const r = await req();
		expect((await call('POST', `/requirements/${r.id}/cancel`, { reason: ' ' })).status).toBe(422);
		as(token(admin));
		expect((await call('POST', `/requirements/${r.id}/cancel`, { reason: 'merged into REQ-9' })).status).toBe(403);
		as(admin);
		const c = await call('POST', `/requirements/${r.id}/cancel`, { reason: 'merged into REQ-9' });
		expect(c.body).toMatchObject({
			lifecycleState: 'cancelled',
			cancelReason: 'merged into REQ-9',
			cancelledByName: 'ABBY'
		});
		expect(c.body.cancelledAt).toMatch(/Z$/);
		const d = (await call('GET', `/requirements/${r.id}/dossier`)).body;
		expect(d).toMatchObject({ cancelReason: 'merged into REQ-9', cancelledBy: 'ABBY' });
	});

	test('recording verification is refused to an API token, with the status select as a second door', async () => {
		const { req, call, as, admin, mkPart, baseline } = await setup();
		const r = await req();
		const p = mkPart('Bracket', 'P-1');
		const link = (await call('POST', `/requirements/parts/${p.id}`, { reqNumber: r.reqNumber })).body;
		await baseline(r.id);
		as(token(admin));
		expect((await call('POST', `/requirements/allocations/${link.id}/verify`, { notes: 'x' })).status).toBe(403);
		expect((await call('PATCH', `/requirements/allocations/${link.id}`, { status: 'waived' })).status).toBe(403);
		as(admin);
		const v = (await call('POST', `/requirements/allocations/${link.id}/verify`, { notes: 'x' })).body;
		expect(v).toMatchObject({ status: 'verified', verifiedBy: { id: admin.id } });
		expect(v.verifiedAt).toBeTruthy();
	});

	test('verified is set only by verify, so it always carries who and when', async () => {
		const { req, call, mkPart } = await setup();
		const r = await req();
		const p = mkPart('Bracket', 'P-1');
		const link = (await call('POST', `/requirements/parts/${p.id}`, { reqNumber: r.reqNumber })).body;
		expect((await call('PATCH', `/requirements/allocations/${link.id}`, { status: 'verified' })).status).toBe(409);
	});

	test('allocations are read-only once the requirement is superseded or cancelled', async () => {
		const { req, call, mkPart, baseline } = await setup();
		const p = mkPart('Bracket', 'P-1');
		const q = mkPart('Valve', 'P-2');
		// Superseded: rev 1 baselined, rev 2 baselined.
		const r1 = await req();
		const l1 = (await call('POST', `/requirements/parts/${p.id}`, { reqNumber: r1.reqNumber })).body;
		await baseline(r1.id);
		const r2 = (await call('POST', `/requirements/${r1.id}/revise`)).body;
		await baseline(r2.id);
		// Cancelled.
		const c = await req({ title: 'Other' });
		const l2 = (await call('POST', `/requirements/parts/${q.id}`, { reqNumber: c.reqNumber })).body;
		await call('POST', `/requirements/${c.id}/cancel`, { reason: 'dropped' });
		for (const l of [l1, l2]) {
			const path = `/requirements/allocations/${l.id}`;
			expect((await call('PATCH', path, { status: 'waived' })).status).toBe(409);
			expect((await call('PATCH', path, { notes: 'late' })).status).toBe(409);
			expect((await call('POST', `${path}/verify`, { notes: 'late' })).status).toBe(409);
			expect((await call('DELETE', path)).status).toBe(409);
		}
	});
});

describe('a cancelled requirement is finished paper', () => {
	test('it takes no new allocation', async () => {
		const { req, call, mkPart } = await setup();
		const r = await req();
		const p = mkPart('Bracket', 'P-1');
		await call('POST', `/requirements/${r.id}/cancel`, { reason: 'dropped' });
		expect((await call('POST', `/requirements/parts/${p.id}`, { reqNumber: r.reqNumber })).status).toBe(409);
	});
});
