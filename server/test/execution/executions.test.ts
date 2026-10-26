import { describe, expect, test } from 'bun:test';
import { setup } from './helpers.ts';

describe('cutting an execution', () => {
	test('a cut creates a work order with one step state per snapshot step', async () => {
		const t = await setup();
		const pid = await t.published(['Prep', 'Fire']);
		const e = await t.cut(pid);
		expect(e.woNumber).toMatch(/^WO-\d{4}$/);
		expect(e.status).toBe('cut');
		expect(e.steps.map((s: any) => [s.number, s.status])).toEqual([['1', 'pending'], ['2', 'pending']]);
		expect(e.versionNumber).toBe(1);
		expect(e.projectId).toBe(t.proj.id);
	});

	test('the project defaults from the procedure and can be set on the cut', async () => {
		const t = await setup();
		const pid = await t.published();
		const other = (await t.ok('POST', '/projects', { code: 'OTH', name: 'Other' })) as any;
		expect((await t.cut(pid)).projectId).toBe(t.proj.id);
		expect((await t.cut(pid, { projectId: other.id })).projectId).toBe(other.id);
		await t.ok('POST', `/projects/${other.id}/archive`, {});
		const refused = await t.call('POST', '/executions', { procedureId: pid, projectId: other.id });
		expect(refused.status).toBe(409);
	});

	test('a batch cut makes N work orders, each with its own number', async () => {
		const t = await setup();
		const pid = await t.published();
		const first = await t.cut(pid, { quantity: 3 });
		expect(first.cutIds).toHaveLength(3);
		const list = await t.ok('GET', `/executions?procedureId=${pid}`);
		expect(new Set(list.items.map((r: any) => r.woNumber)).size).toBe(3);
	});

	test('an unpublished procedure cannot be cut, and a version can be pinned', async () => {
		const t = await setup();
		const p = await t.proc('Draft only');
		await t.step(p.id, 'A');
		expect((await t.call('POST', '/executions', { procedureId: p.id })).status).toBe(409);
		await t.ok('POST', `/procedures/${p.id}/publish`, {});
		await t.step(p.id, 'B');
		const v2 = await t.ok('POST', `/procedures/${p.id}/publish`, {});
		const pinned = await t.cut(p.id, { versionId: v2.id - 1 });
		expect(pinned.versionNumber).toBe(1);
		expect(pinned.steps).toHaveLength(1);
		expect((await t.cut(p.id)).steps).toHaveLength(2);
	});

	test('a later edit of the procedure never changes a cut execution', async () => {
		const t = await setup();
		const p = await t.proc('Frozen');
		const s = await t.step(p.id, 'Original');
		await t.ok('POST', `/procedures/${p.id}/publish`, {});
		const e = await t.cut(p.id);
		await t.ok('PATCH', `/procedures/${p.id}/steps/${s.id}`, { title: 'Changed' });
		expect((await t.doc(e.id)).ops[0].title).toBe('Original');
	});

	test('a build procedure allocates its outputs at cut time with a serial and an OPAL number', async () => {
		const t = await setup();
		const asm = await t.part('Assembly');
		const p = await t.proc('Build it', { procedureType: 'build' });
		await t.step(p.id, 'Assemble');
		await t.ok('POST', `/procedures/${p.id}/outputs`, { partId: asm.id, quantity: '1' });
		await t.ok('POST', `/procedures/${p.id}/publish`, {});
		const pv = await t.ok('GET', `/executions/preview?procedureId=${p.id}&quantity=2`);
		expect(pv.outputs[0].serials).toEqual(['001', '002']);
		const e = await t.cut(p.id);
		const prods = await t.ok('GET', `/executions/${e.id}/productions`);
		expect(prods).toHaveLength(1);
		expect(prods[0]).toMatchObject({ status: 'planned', serialNumber: '001', lotNumber: e.woNumber, quantity: '1' });
		expect(prods[0].opalNumber).toMatch(/^OPAL-/);
		// The preview allocated nothing: the next cut takes serial 002.
		const e2 = await t.cut(p.id);
		expect((await t.ok('GET', `/executions/${e2.id}/productions`))[0].serialNumber).toBe('002');
	});
});

describe('reading and editing', () => {
	test('list filters by status, procedure, project and search, with counts and paging', async () => {
		const t = await setup();
		const a = await t.published(['A'], {});
		const b = await t.published(['B'], {});
		const e1 = await t.cut(a);
		await t.cut(b);
		await t.complete(e1.id, '1');
		const all = await t.ok('GET', '/executions');
		expect(all.total).toBe(2);
		expect(all.counts).toMatchObject({ completed: 1, cut: 1 });
		expect((await t.ok('GET', '/executions?status=completed')).items).toHaveLength(1);
		expect((await t.ok('GET', `/executions?procedureId=${b}`)).items).toHaveLength(1);
		expect((await t.ok('GET', `/executions?projectId=${t.proj.id}`)).total).toBe(2);
		expect((await t.ok('GET', `/executions?q=${e1.woNumber}`)).items).toHaveLength(1);
		const p1 = await t.ok('GET', '/executions?limit=1');
		expect(p1.next).not.toBeNull();
		expect((await t.ok('GET', `/executions?limit=1&cursor=${p1.next}`)).items).toHaveLength(1);
	});

	test('an unknown execution is 404', async () => {
		const t = await setup();
		expect((await t.call('GET', '/executions/999')).status).toBe(404);
		expect((await t.call('GET', '/executions/999/document')).status).toBe(404);
	});

	test('priority and dates can change', async () => {
		const t = await setup();
		const pid = await t.published();
		const e = await t.cut(pid);
		const u = await t.ok('PATCH', `/executions/${e.id}`, { priority: 'urgent', targetCompletionAt: '2030-01-01T00:00:00Z' });
		expect(u).toMatchObject({ priority: 'urgent', woNumber: e.woNumber });
		expect(u.targetCompletionAt).toBe('2030-01-01T00:00:00.000Z');
	});

	test('only an active execution can be aborted, and the abort ends it', async () => {
		const t = await setup();
		const pid = await t.published(['A']);
		const e = await t.cut(pid);
		const a = await t.ok('POST', `/executions/${e.id}/cancel`, { reason: 'wrong part' });
		expect(a.status).toBe('aborted');
		expect(a.completedAt).not.toBeNull();
		expect((await t.call('POST', `/executions/${e.id}/cancel`, {})).status).toBe(409);
		expect((await t.complete(e.id, '1')).status).toBe(409);
	});

	test('the project of an execution cannot move while issues belong to it', async () => {
		const t = await setup();
		const pid = await t.published(['A']);
		const e = await t.cut(pid);
		const other = (await t.ok('POST', '/projects', { code: 'OTH', name: 'Other' })) as any;
		expect((await t.ok('PATCH', `/executions/${e.id}`, { projectId: other.id })).projectId).toBe(other.id);
		const e2 = await t.cut(pid);
		await t.nc(e2.id, '1', { containment: 'advisory' });
		expect((await t.call('PATCH', `/executions/${e2.id}`, { projectId: other.id })).status).toBe(409);
	});

	test('the cut preview scales the kit by quantity and checks live stock', async () => {
		const t = await setup();
		const screw = await t.part('Screw');
		const p = await t.proc('Kitted');
		await t.step(p.id, 'A');
		await t.ok('POST', `/procedures/${p.id}/kit`, { partId: screw.id, quantity: '2' });
		await t.ok('POST', `/procedures/${p.id}/publish`, {});
		await t.stock(screw.id, '5');
		const pv = await t.ok('GET', `/executions/preview?procedureId=${p.id}&quantity=3`);
		expect(pv.kit[0]).toMatchObject({ perWorkOrder: '2', required: '6', available: '5', isAvailable: false });
		expect(pv.allAvailable).toBe(false);
		expect((await t.ok('GET', `/executions/preview?procedureId=${p.id}&quantity=2`)).allAvailable).toBe(true);
		expect((await t.call('GET', `/executions/preview?procedureId=${p.id}&quantity=0`)).status).toBe(422);
	});
});

describe('derived status', () => {
	test('the first completed step moves the execution to in work and starts the clock', async () => {
		const t = await setup();
		const pid = await t.published(['A', 'B']);
		const e = await t.cut(pid);
		const r = await t.complete(e.id, '1');
		expect(r.json.executionStarted).toBe(true);
		const g = await t.get(e.id);
		expect(g.status).toBe('in_work');
		expect(g.startedAt).not.toBeNull();
		expect(g.progressDone).toBe(1);
	});

	test('the first skipped step also starts the execution', async () => {
		const t = await setup();
		const pid = await t.published(['A', 'B']);
		const e = await t.cut(pid);
		await t.skip(e.id, '1', { reason: 'n/a' });
		expect((await t.get(e.id)).status).toBe('in_work');
	});

	test('completing every step completes the execution', async () => {
		const t = await setup();
		const pid = await t.published(['A', 'B']);
		const e = await t.cut(pid);
		await t.complete(e.id, '1');
		const last = await t.complete(e.id, '2');
		expect(last.json.executionCompleted).toBe(true);
		const g = await t.get(e.id);
		expect(g.status).toBe('completed');
		expect(g.completedAt).not.toBeNull();
		expect(g.durationSeconds).not.toBeNull();
	});

	test('a skip that finishes the last step completes the execution', async () => {
		const t = await setup();
		const pid = await t.published(['A']);
		const e = await t.cut(pid);
		await t.skip(e.id, '1');
		expect((await t.get(e.id)).status).toBe('completed');
	});

	test('contingency work is optional until touched', async () => {
		const t = await setup();
		const p = await t.proc('Contingent');
		await t.step(p.id, 'Main');
		await t.step(p.id, 'Spare', { isContingency: true });
		await t.ok('POST', `/procedures/${p.id}/publish`, {});
		const e = await t.cut(p.id);
		await t.complete(e.id, '1');
		expect((await t.get(e.id)).status).toBe('completed');
	});
});

describe('work order numbers', () => {
	test('a work order number cannot be set or changed', async () => {
		const t = await setup();
		const pid = await t.published(['A']);
		const a = await t.cut(pid, { woNumber: 'WO-5' });
		expect(a.woNumber).toBe('WO-0001');
		const b = await t.cut(pid, { woNumber: 'X-1' });
		expect(b.woNumber).toBe('WO-0002');
		const patched = await t.ok('PATCH', `/executions/${b.id}`, { woNumber: 'WO-20', priority: 'high' });
		expect(patched).toMatchObject({ woNumber: 'WO-0002', priority: 'high' });
		expect((await t.cut(pid)).woNumber).toBe('WO-0003');
	});
});
